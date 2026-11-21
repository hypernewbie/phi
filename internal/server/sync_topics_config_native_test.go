package server

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

func TestSyncTopicLiveRoleChangeFencesNativeBinding(t *testing.T) {
	withTempConfig(t)
	app := testServer
	app.hub = ws.NewHub(0)
	app.bridge = piapp.StartBridge(app.hub, func() ([]byte, error) { return []byte("test runtime"), nil }, "0.0.0-test", nil)
	if app.bridge == nil {
		t.Fatal("bridge did not start")
	}
	defer app.bridge.Stop()
	if _, err := app.loadSyncConfig(); err != nil {
		t.Fatal(err)
	}
	app.bridge.SetSyncboardTopicEpoch(app.syncTopics.epoch)
	app.bridge.SetSyncboardTopicRetireHandler(app.retireSyncTopicOwner)
	owners := make(chan pibridge.SyncboardOwner, 1)
	app.bridge.SetSyncboardTopicSubscriber(func(owner pibridge.SyncboardOwner, topic string) error {
		app.syncMu.Lock()
		err := app.syncTopics.subscribeLocked(syncTopicOwnerFromBridge(owner), topic)
		app.syncMu.Unlock()
		owners <- owner
		return err
	})
	env, _, managed := app.bridge.Provision("pane", true)
	if !managed {
		t.Fatal("pane was not managed")
	}
	app.bridge.Complete(&pty.PTYInstance{ID: "pane"})
	socket := strings.TrimPrefix(env["PHI_PI_BRIDGE_ENDPOINT"], "unix:")
	conn, err := grpc.NewClient("passthrough:///unused",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	md := metadata.Pairs("phi-pi-pane", "pane", "phi-pi-process", env["PHI_PI_BRIDGE_PROCESS_ID"], "phi-pi-token", env["PHI_PI_BRIDGE_TOKEN"])
	ctx, cancel := context.WithTimeout(metadata.NewOutgoingContext(context.Background(), md), 5*time.Second)
	defer cancel()
	stream, err := pibridgepb.NewIntegrationClient(conn).Connect(ctx)
	if err != nil {
		t.Fatal("native stream did not connect")
	}
	envelope := func(payload *pibridgepb.PiToPhi) error {
		payload.PaneId, payload.ProcessId, payload.RuntimeGeneration = "pane", env["PHI_PI_BRIDGE_PROCESS_ID"], 1
		return stream.Send(payload)
	}
	if err := envelope(&pibridgepb.PiToPhi{Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
		ProtocolVersion: 1, RuntimeId: "runtime", SessionId: "session",
		Capabilities: []string{pibridge.CapabilityLifecycle, pibridge.CapabilitySyncboard, pibridge.CapabilitySyncboardTopics},
		CurrentState: &pibridgepb.StateSnapshot{State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "session"},
	}}}); err != nil {
		t.Fatal("native hello failed")
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatal("native hello was not accepted")
	}
	if err := envelope(&pibridgepb.PiToPhi{Payload: &pibridgepb.PiToPhi_SyncboardRequest{SyncboardRequest: &pibridgepb.SyncboardRequest{
		RequestId: "1", Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_SUBSCRIBE, Key: "alerts",
	}}}); err != nil {
		t.Fatal("native subscribe failed")
	}
	var binding uint64
	for binding == 0 {
		frame, err := stream.Recv()
		if err != nil {
			t.Fatal("native subscribe response was not received")
		}
		if response := frame.GetSyncboardResponse(); response != nil {
			if response.GetHttpStatus() != 200 {
				t.Fatal("native subscription was refused")
			}
			binding = response.GetTopicBindingSeq()
		}
	}
	owner := <-owners
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncCoordinator = "http://replacement.invalid"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.loadSyncConfig(); err == nil {
		t.Fatal("live role change was not refused")
	}
	for {
		frame, err := stream.Recv()
		if err != nil {
			t.Fatal("native retirement marker was not received")
		}
		if marker := frame.GetSyncboardTopicRetired(); marker != nil {
			if marker.GetReason() != "peer-config-changed" || marker.GetRetiredEpoch() != app.syncTopics.epoch || marker.GetThroughBindingSeq() < binding {
				t.Fatal("native marker did not fence the captured binding")
			}
			break
		}
	}
	if err := app.bridge.WithSyncboardTopicOwners([]pibridge.SyncboardOwner{owner}, app.syncTopics.epoch, func(valid []pibridge.SyncboardOwner) error {
		if len(valid) != 0 {
			t.Fatal("native generation remained eligible after its role-change fence")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if app.syncTopics.totalSubs != 0 || app.syncTopics.totalBatches != 0 {
		t.Fatal("native retirement did not cancel its local topic reservations")
	}
}
