package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func testBridgeHub() *ws.Hub {
	return ws.NewHub(0)
}

func TestBridgeStartStopCleansOwnedPaths(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	info, err := os.Stat(b.artifact)
	if err != nil {
		t.Fatalf("artifact not materialized: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("artifact mode %o, want 0600", info.Mode().Perm())
	}
	socket := strings.TrimPrefix(b.endpoint.Target, "unix:")
	artifact := b.artifact
	b.Stop()
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Fatalf("socket survives stop: %v", err)
	}
	if _, err := os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("artifact survives stop: %v", err)
	}
	b.Stop() // idempotent
}

func TestBridgeProvisionCompleteRevoke(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env, args, managed := b.Provision("pane-1", true)
	if !managed {
		t.Fatal("provision not managed")
	}
	for _, key := range []string{piBridgeEnvTarget, piBridgeEnvPane, piBridgeEnvProcess, piBridgeEnvToken} {
		if env[key] == "" {
			t.Fatalf("env %s empty", key)
		}
	}
	if len(args) != 2 || args[0] != "--extension" || args[1] != b.artifact {
		t.Fatalf("extension args %v", args)
	}
	if len(env[piBridgeEnvToken]) != 64 {
		t.Fatalf("token len %d, want 64 hex", len(env[piBridgeEnvToken]))
	}

	// Second provision of the same pane is unmanaged and preserves
	// the live record: no new lease, no clobbered state, and the
	// first lease keeps its revoke path.
	_, _, managed = b.Provision("pane-1", true)
	if managed {
		t.Fatal("double provision managed")
	}
	if got := b.PaneSnapshot("pane-1"); got.State != piBridgeManaged {
		t.Fatalf("double provision state %+v, want managed", got)
	}
	if _, ok := b.server.PaneState(env[piBridgeEnvProcess]); !ok {
		t.Fatal("double provision orphaned the live lease")
	}

	b.Complete(&pty.PTYInstance{ID: "pane-1"})
	b.RevokePane("pane-1")
	if got := b.PaneSnapshot("pane-1"); got.State != piBridgePlain {
		t.Fatalf("revoked snapshot %+v, want plain", got)
	}
	b.RevokePane("pane-1")                      // idempotent
	b.Complete(&pty.PTYInstance{ID: "unknown"}) // ignored
	if got := b.PaneSnapshot("unknown"); got.State != piBridgePlain {
		t.Fatalf("unknown snapshot %+v, want plain", got)
	}
}

// TestBridgeMissingArtifactProvisionsUnavailable covers a bridge whose
// runtime failed to materialize (corrupt embed, unwritable dir): every
// pane launches unmanaged with a safe reason, never with extension args.
func TestBridgeMissingArtifactProvisionsUnavailable(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	b.artifact = "" // simulate materialize failure after startup
	b.reason = "runtime unavailable"
	env, args, managed := b.Provision("pane-1", true)
	if managed || env != nil || args != nil {
		t.Fatalf("missing artifact provisioned: managed=%v env=%v args=%v", managed, env, args)
	}
	if got := b.PaneSnapshot("pane-1"); got.State != piBridgeUnavailable || got.Reason == "" {
		t.Fatalf("missing artifact snapshot %+v, want unavailable with reason", got)
	}
	frame := b.encodeAttach(pty.PTYInstanceSnapshot{ID: "pane-1", Coder: "pi"})
	if frame == nil || frame.GetState() != piBridgeUnavailable || frame.GetReason() == "" {
		t.Fatalf("missing artifact attach %+v, want unavailable state with reason", frame)
	}
}

func TestBridgeNilSafe(t *testing.T) {
	var b *Bridge
	if _, _, managed := b.Provision("pane-1", true); managed {
		t.Fatal("nil bridge provisioned")
	}
	b.Complete(&pty.PTYInstance{ID: "pane-1"})
	b.Complete(nil)
	b.RevokePane("pane-1")
	b.Stop()
	if got := b.PaneSnapshot("pane-1"); got.State != piBridgePlain {
		t.Fatalf("nil snapshot %+v, want plain", got)
	}
	if b.encodeAttach(pty.PTYInstanceSnapshot{ID: "pane-1", Coder: "pi"}) != nil {
		t.Fatal("nil bridge encoded attach")
	}
}

// dialBridge opens a raw client stream against a test bridge.
func dialBridge(t *testing.T, b *Bridge, pane, process, token string) (pibridgepb.Integration_ConnectClient, context.CancelFunc) {
	t.Helper()
	socket := strings.TrimPrefix(b.endpoint.Target, "unix:")
	conn, err := grpc.NewClient("passthrough:///unused",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return net.Dial("unix", socket)
		}),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	md := metadata.Pairs("phi-pi-pane", pane, "phi-pi-process", process, "phi-pi-token", token)
	ctx, cancel := context.WithTimeout(metadata.NewOutgoingContext(context.Background(), md), 10*time.Second)
	t.Cleanup(cancel)
	stream, err := pibridgepb.NewIntegrationClient(conn).Connect(ctx)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	return stream, cancel
}

func TestBridgeSettlementNotifiesHub(t *testing.T) {
	hub := testBridgeHub()
	b := startPiBridge(hub)
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env, _, managed := b.Provision("pane-1", true)
	if !managed {
		t.Fatal("provision not managed")
	}
	b.Complete(&pty.PTYInstance{ID: "pane-1"})

	client := &ws.Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	<-client.Send // ATTACH_HEAD

	stream, _ := dialBridge(t, b, "pane-1", env[piBridgeEnvProcess], env[piBridgeEnvToken])
	hello := &pibridgepb.PiToPhi{
		PaneId: "pane-1", ProcessId: env[piBridgeEnvProcess], RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
			ProtocolVersion: 1, SessionId: "sess", RuntimeId: "rt",
			Capabilities: []string{"pi.lifecycle.v1"},
			CurrentState: &pibridgepb.StateSnapshot{
				State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess",
			},
		}},
	}
	if err := stream.Send(hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("accepted: %v", err)
	}
	// Hello pushes a fresh bridge view before any settlement.
	select {
	case raw := <-client.Send:
		server, err := wireproto.DecodeServerFrame(raw)
		if err != nil || server.GetBridgeState() == nil {
			t.Fatalf("state decode: %+v err=%v", server, err)
		}
		state := server.GetBridgeState()
		if state.GetState() != "managed" || state.Running == nil || *state.Running != false || !slices.Equal(state.GetCapabilities(), []string{"pi.lifecycle.v1"}) {
			t.Fatalf("state %+v", state)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no state frame")
	}
	settled := &pibridgepb.PiToPhi{
		PaneId: "pane-1", ProcessId: env[piBridgeEnvProcess], RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_AgentSettled{AgentSettled: &pibridgepb.AgentSettled{
			EventSequence: 2, RunId: 7, Outcome: pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED,
		}},
	}
	if err := stream.Send(settled); err != nil {
		t.Fatalf("settled: %v", err)
	}

	select {
	case raw := <-client.Send:
		server, err := wireproto.DecodeServerFrame(raw)
		if err != nil || server.GetSettlement() == nil {
			t.Fatalf("control decode: %+v err=%v", server, err)
		}
		if control := server.GetSettlement(); control.GetPaneId() != "pane-1" || control.GetRun() != 7 || control.GetOutcome() != "completed" {
			t.Fatalf("control %+v", control)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no settlement frame")
	}

	// Duplicate edge never notifies twice.
	if err := stream.Send(settled); err != nil {
		t.Fatalf("duplicate settled: %v", err)
	}
	select {
	case raw := <-client.Send:
		t.Fatalf("duplicate settlement notified: %x", raw)
	case <-time.After(200 * time.Millisecond):
	}

	if got := b.PaneSnapshot("pane-1"); got.LastRun != "7" {
		t.Fatalf("snapshot %+v, want last_run 7", got)
	}
}

func TestBridgeConnectedTracksStream(t *testing.T) {
	hub := testBridgeHub()
	b := startPiBridge(hub)
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env, _, managed := b.Provision("pane-c", true)
	if !managed {
		t.Fatal("provision not managed")
	}
	b.Complete(&pty.PTYInstance{ID: "pane-c"})
	// The lease exists but no stream is up: known-disconnected.
	if got := b.PaneSnapshot("pane-c"); got.Connected == nil || *got.Connected {
		t.Fatalf("snapshot %+v, want connected false before hello", got)
	}

	client := &ws.Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-c", client)
	<-client.Send // ATTACH_HEAD

	stream, cancel := dialBridge(t, b, "pane-c", env[piBridgeEnvProcess], env[piBridgeEnvToken])
	hello := &pibridgepb.PiToPhi{
		PaneId: "pane-c", ProcessId: env[piBridgeEnvProcess], RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
			ProtocolVersion: 1, SessionId: "sess", RuntimeId: "rt",
			Capabilities: []string{"pi.lifecycle.v1", "pi.history.v1"},
			CurrentState: &pibridgepb.StateSnapshot{
				State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess",
			},
		}},
	}
	if err := stream.Send(hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("accepted: %v", err)
	}
	select {
	case raw := <-client.Send:
		server, err := wireproto.DecodeServerFrame(raw)
		if err != nil || server.GetBridgeState() == nil {
			t.Fatalf("state decode: %+v err=%v", server, err)
		}
		state := server.GetBridgeState()
		if state.GetState() != "managed" || state.Connected == nil || !*state.Connected {
			t.Fatalf("state %+v, want connected true", state)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no state frame")
	}
	if got := b.PaneSnapshot("pane-c"); got.Connected == nil || !*got.Connected {
		t.Fatalf("snapshot %+v, want connected true", got)
	}

	cancel()
	select {
	case raw := <-client.Send:
		server, err := wireproto.DecodeServerFrame(raw)
		if err != nil || server.GetBridgeState() == nil {
			t.Fatalf("down decode: %+v err=%v", server, err)
		}
		state := server.GetBridgeState()
		if state.GetState() != "managed" || state.Connected == nil || *state.Connected {
			t.Fatalf("state %+v, want connected false", state)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no peer-down frame")
	}
	if got := b.PaneSnapshot("pane-c"); got.Connected == nil || *got.Connected {
		t.Fatalf("snapshot %+v, want connected false", got)
	}
}

func TestBridgeStaleSettlementDropped(t *testing.T) {
	hub := testBridgeHub()
	b := startPiBridge(hub)
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env, _, _ := b.Provision("pane-1", true)
	client := &ws.Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	<-client.Send
	b.RevokePane("pane-1")

	b.onSettled("pane-1", env[piBridgeEnvProcess], 1, 3, pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED)
	select {
	case frame := <-client.Send:
		t.Fatalf("stale settlement notified: %x", frame)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestBridgeAttachEncoding(t *testing.T) {
	hub := testBridgeHub()
	b := startPiBridge(hub)
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	if got := b.encodeAttach(pty.PTYInstanceSnapshot{ID: "pane-1", Coder: "bash"}); got != nil {
		t.Fatalf("non-pi attach encoded: %+v", got)
	}
	if got := b.encodeAttach(pty.PTYInstanceSnapshot{ID: "unknown", Coder: "pi"}); got != nil {
		t.Fatalf("unknown pane attach encoded: %+v", got)
	}
	env, _, _ := b.Provision("pane-1", true)
	state := b.encodeAttach(pty.PTYInstanceSnapshot{ID: "pane-1", Coder: "pi"})
	if state == nil || state.GetState() != piBridgeManaged {
		t.Fatalf("attach %+v", state)
	}
	b.onSettled("pane-1", env[piBridgeEnvProcess], 1, 11, pibridgepb.RunOutcome_RUN_OUTCOME_ABORTED)
	state = b.encodeAttach(pty.PTYInstanceSnapshot{ID: "pane-1", Coder: "pi"})
	if state.GetLastRun() != 11 {
		t.Fatalf("attach catch-up %+v", state)
	}
}

func TestBridgeSnapshotCopiesRunningFlag(t *testing.T) {
	hub := testBridgeHub()
	b := startPiBridge(hub)
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env, _, _ := b.Provision("pane-1", true)
	floor, _ := b.server.PublicationRevision(env[piBridgeEnvProcess])
	b.onState("pane-1", env[piBridgeEnvProcess], 1, floor+1, true, true, "p/m", "", []string{"pi.lifecycle.v1"}, nil, nil)
	b.mu.Lock()
	p := b.panes["pane-1"]
	view := p.snapshot()
	// Simulate a future in-place update: a published view must not move.
	*p.lastRunning = false
	b.mu.Unlock()
	if view.running == nil || *view.running != true {
		t.Fatal("published snapshot shares the live running flag")
	}
}

func TestBridgeProvisionNoInject(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	// Manual install: the lease and credentials exist, but no
	// --extension args are returned for the spawn.
	env, args, managed := b.Provision("pane-1", false)
	if !managed {
		t.Fatal("provision not managed")
	}
	if env[piBridgeEnvToken] == "" || env[piBridgeEnvProcess] == "" {
		t.Fatal("manual provision lacks credentials")
	}
	if len(args) != 0 {
		t.Fatalf("no-inject provision returned args %v", args)
	}
}

func TestCompareStamp(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.1.0", "0.1.0", 0},
		{"0.2.0", "0.1.9", 1},
		{"0.1.0", "0.1.1", -1},
		{"1.0.0", "0.9.9", 1},
		{"0.1.0\n", "0.1.0", 0},
		{"0.1.0 hash-a", "0.1.0 hash-b", 0},
		{"0.1.0 hash-a", "0.1.1 hash-b", -1},
		{"garbage", "0.1.0", -1},
		{"0.1.0", "garbage", 1},
		{"", "", 0},
	}
	for _, c := range cases {
		if got := compareStamp(c.a, c.b); got != c.want {
			t.Fatalf("compareStamp(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestMaterializeStablePiBridge(t *testing.T) {
	home := withTempHome(t)
	stub := func() ([]byte, error) { return []byte("bundle-bytes"), nil }
	stableFile := func() string {
		return filepath.Join(home, ".phi", piBridgeStableDir, piBridgeArtifactName)
	}
	stableVersion := func() string {
		raw, err := os.ReadFile(filepath.Join(home, ".phi", piBridgeStableDir, "VERSION"))
		if err != nil {
			t.Fatalf("read stable VERSION: %v", err)
		}
		return strings.TrimSpace(string(raw))
	}

	// Fresh install writes bundle and version.
	if err := materializeStablePiBridgeAt(stub, "0.1.0"); err != nil {
		t.Fatalf("fresh install: %v", err)
	}
	if raw, _ := os.ReadFile(stableFile()); string(raw) != "bundle-bytes" {
		t.Fatal("stable bundle missing or wrong")
	}
	if stableVersion() != "0.1.0" {
		t.Fatal("stable version missing or wrong")
	}

	// Older installed version is replaced.
	newer := func() ([]byte, error) { return []byte("bundle-v2"), nil }
	if err := materializeStablePiBridgeAt(newer, "0.2.0"); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	if raw, _ := os.ReadFile(stableFile()); string(raw) != "bundle-v2" {
		t.Fatal("upgrade did not replace bundle")
	}
	if stableVersion() != "0.2.0" {
		t.Fatal("upgrade did not replace version")
	}

	// Newer installed version is left alone, byte for byte.
	before, _ := os.ReadFile(stableFile())
	if err := materializeStablePiBridgeAt(stub, "0.1.0"); err != nil {
		t.Fatalf("downgrade guard: %v", err)
	}
	after, _ := os.ReadFile(stableFile())
	if string(before) != string(after) || stableVersion() != "0.2.0" {
		t.Fatal("newer install was clobbered")
	}

	// Corrupt installed version loses to a well-formed bundled one.
	if err := os.WriteFile(filepath.Join(home, ".phi", piBridgeStableDir, "VERSION"), []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := materializeStablePiBridgeAt(newer, "0.2.0"); err != nil {
		t.Fatalf("corrupt recovery: %v", err)
	}
	if stableVersion() != "0.2.0" {
		t.Fatal("corrupt version not replaced")
	}

	// Unparsable bundled version fails loud without touching the install.
	if err := materializeStablePiBridgeAt(stub, "garbage"); err == nil {
		t.Fatal("unparsable bundled version accepted")
	}
	if stableVersion() != "0.2.0" {
		t.Fatal("failed upgrade clobbered the install")
	}

	// Same version, new content: the stamp decides, not the version
	// number. A rebuilt bundle must not sit stale behind an equal
	// version.
	if err := materializeStablePiBridgeAt(stub, "0.2.0 hash-b"); err != nil {
		t.Fatalf("same-version refresh: %v", err)
	}
	if raw, _ := os.ReadFile(stableFile()); string(raw) != "bundle-bytes" {
		t.Fatal("same-version rebuild did not replace the bundle")
	}
	if stableVersion() != "0.2.0 hash-b" {
		t.Fatalf("same-version rebuild did not update the stamp: %q", stableVersion())
	}

	// Identical stamp: nothing is written again.
	if err := materializeStablePiBridgeAt(newer, "0.2.0 hash-b"); err != nil {
		t.Fatalf("identical stamp: %v", err)
	}
	if raw, _ := os.ReadFile(stableFile()); string(raw) != "bundle-bytes" {
		t.Fatal("identical stamp replaced the bundle")
	}
	if stableVersion() != "0.2.0 hash-b" {
		t.Fatal("identical stamp changed the version file")
	}

	// A newer installed version still wins over an older bundled one,
	// even when the stamps differ.
	if err := materializeStablePiBridgeAt(stub, "0.1.0 hash-c"); err != nil {
		t.Fatalf("newer install guard: %v", err)
	}
	if raw, _ := os.ReadFile(stableFile()); string(raw) != "bundle-bytes" {
		t.Fatal("newer install was clobbered")
	}
	if stableVersion() != "0.2.0 hash-b" {
		t.Fatal("newer install lost its version")
	}
}

// Settlements are scoped to their runtime generation: a newer generation
// clears the obsolete retained run, and delayed old callbacks are dropped.
func TestBridgeGenerationScopesSettlements(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	env, _, _ := b.Provision("pane-1", true)
	proc := env[piBridgeEnvProcess]
	b.Complete(&pty.PTYInstance{ID: "pane-1"})
	floor, _ := b.server.PublicationRevision(proc)
	b.onState("pane-1", proc, 1, floor+1, false, true, "p/m", "", []string{"pi.lifecycle.v1"}, nil, nil)
	b.onSettled("pane-1", proc, 1, 5, pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED)
	if got := b.PaneSnapshot("pane-1"); got.Generation != "1" || got.LastRun != "5" {
		t.Fatalf("gen1 snapshot %+v, want generation 1 last_run 5", got)
	}
	// New runtime generation clears the old retained run.
	b.onState("pane-1", proc, 2, floor+2, false, true, "p/m", "", []string{"pi.lifecycle.v1"}, nil, nil)
	if got := b.PaneSnapshot("pane-1"); got.Generation != "2" || got.LastRun != "" {
		t.Fatalf("gen2 idle snapshot %+v, want generation 2 no last_run", got)
	}
	// Delayed old settlement must not overwrite the new generation.
	b.onSettled("pane-1", proc, 1, 6, pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED)
	if got := b.PaneSnapshot("pane-1"); got.Generation != "2" || got.LastRun != "" {
		t.Fatalf("stale gen1 snapshot %+v, want generation 2 no last_run", got)
	}
	// New generation restarts run numbering from 1.
	b.onSettled("pane-1", proc, 2, 1, pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED)
	if got := b.PaneSnapshot("pane-1"); got.Generation != "2" || got.LastRun != "1" {
		t.Fatalf("gen2 settled snapshot %+v, want generation 2 last_run 1", got)
	}
	// Delayed old state must not overwrite the new view.
	b.onState("pane-1", proc, 1, floor+3, true, true, "old/model", "", []string{"pi.lifecycle.v1"}, nil, nil)
	if got := b.PaneSnapshot("pane-1"); got.Generation != "2" || got.LastRun != "1" {
		t.Fatalf("stale state snapshot %+v, want generation 2 last_run 1", got)
	}
}

// PaneSnapshot must not race with settlement updates.
func TestBridgePaneSnapshotConcurrent(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	env, _, _ := b.Provision("pane-1", true)
	proc := env[piBridgeEnvProcess]
	b.Complete(&pty.PTYInstance{ID: "pane-1"})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			_ = b.PaneSnapshot("pane-1")
		}
	}()
	for i := uint64(1); i <= 200; i++ {
		b.onSettled("pane-1", proc, 1, i, pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED)
	}
	<-done
}

// A delayed old PTY exit after a restore retry reuses the pane ID must not
// revoke the replacement lease.
func TestBridgeDelayedExitPreservesReplacement(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	_, _, _ = b.Provision("pane-1", true)
	oldInst := &pty.PTYInstance{ID: "pane-1"}
	b.Complete(oldInst)
	// Restore probe failure: synchronous revoke before the retry.
	b.RevokePane("pane-1")
	env2, _, managed := b.Provision("pane-1", true)
	if !managed {
		t.Fatal("retry provision not managed")
	}
	newInst := &pty.PTYInstance{ID: "pane-1"}
	b.Complete(newInst)
	// Delayed old exit must be ignored.
	b.handlePaneExit(oldInst)
	if got := b.PaneSnapshot("pane-1"); got.State != piBridgeManaged {
		t.Fatalf("delayed old exit revoked replacement: %+v", got)
	}
	if _, ok := b.server.PaneState(env2[piBridgeEnvProcess]); !ok {
		t.Fatal("replacement lease missing after delayed old exit")
	}
	// Current exit still revokes.
	b.handlePaneExit(newInst)
	if got := b.PaneSnapshot("pane-1"); got.State != piBridgePlain {
		t.Fatalf("current exit snapshot %+v, want plain", got)
	}
}

// answerHistoryOnce serves one HistoryRequest on a test stream with a
// canned response, then returns. It fails the test on any stream error.
func answerHistoryOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient, entries []string, unavailable bool) {
	t.Helper()
	for {
		msg, err := stream.Recv()
		if err != nil {
			t.Errorf("recv: %v", err)
			return
		}
		req := msg.GetHistoryRequest()
		if req == nil {
			continue
		}
		res := &pibridgepb.PiToPhi{
			PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
			Payload: &pibridgepb.PiToPhi_HistoryResponse{HistoryResponse: &pibridgepb.HistoryResponse{
				RequestId: req.GetRequestId(), Entries: entries, Unavailable: unavailable,
			}},
		}
		if err := stream.Send(res); err != nil {
			t.Errorf("send response: %v", err)
		}
		return
	}
}

func dialBridgePane(t *testing.T, b *Bridge, pane string, caps ...string) (pibridgepb.Integration_ConnectClient, context.CancelFunc) {
	t.Helper()
	env, _, managed := b.Provision(pane, true)
	if !managed {
		t.Fatal("provision not managed")
	}
	b.Complete(&pty.PTYInstance{ID: pane})
	stream, cancel := dialBridge(t, b, pane, env[piBridgeEnvProcess], env[piBridgeEnvToken])
	hello := &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: env[piBridgeEnvProcess], RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
			ProtocolVersion: 1, SessionId: "sess", RuntimeId: "rt",
			Capabilities: caps,
			CurrentState: &pibridgepb.StateSnapshot{
				State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess",
			},
		}},
	}
	if err := stream.Send(hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("accepted: %v", err)
	}
	return stream, cancel
}

// answerModelsOnce serves one ModelsRequest on a test stream with a
// canned response, then returns. It fails the test on any stream error.
func answerModelsOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient, models []*pibridgepb.ModelRef, truncated, unavailable bool) {
	t.Helper()
	for {
		msg, err := stream.Recv()
		if err != nil {
			t.Errorf("recv: %v", err)
			return
		}
		req := msg.GetModelsRequest()
		if req == nil {
			continue
		}
		res := &pibridgepb.PiToPhi{
			PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
			Payload: &pibridgepb.PiToPhi_ModelsResponse{ModelsResponse: &pibridgepb.ModelsResponse{
				RequestId: req.GetRequestId(), Models: models, Truncated: truncated, Unavailable: unavailable,
			}},
		}
		if err := stream.Send(res); err != nil {
			t.Errorf("send response: %v", err)
		}
		return
	}
}

func answerThinkingLevelsOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient) (process string, generation uint64) {
	t.Helper()
	msg, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv thinking list: %v", err)
	}
	req := msg.GetThinkingLevelsRequest()
	if req == nil {
		t.Fatalf("not a thinking-level request: %v", msg.GetPayload())
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
		Payload: &pibridgepb.PiToPhi_ThinkingLevelsResponse{ThinkingLevelsResponse: &pibridgepb.ThinkingLevelsResponse{
			RequestId: req.GetRequestId(), Levels: []string{"off", "high", "xhigh", "max"}, Provider: "p", Model: "m",
		}},
	}); err != nil {
		t.Fatalf("send thinking list: %v", err)
	}
	return msg.GetProcessId(), msg.GetRuntimeGeneration()
}

func answerSetThinkingOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient) {
	t.Helper()
	msg, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv set-thinking: %v", err)
	}
	req := msg.GetSetThinkingRequest()
	if req == nil {
		t.Fatalf("not a set-thinking request: %v", msg.GetPayload())
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
		Payload: &pibridgepb.PiToPhi_SetThinkingAck{SetThinkingAck: &pibridgepb.SetThinkingAck{RequestId: req.GetRequestId(), Ok: true}},
	}); err != nil {
		t.Fatalf("send set-thinking ack: %v", err)
	}
}

// answerSetModelOnce serves one SetModelRequest on a test stream with
// a canned ack, then returns. It fails the test on any stream error.
func answerSetModelOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient, ok bool, reason string) {
	t.Helper()
	for {
		msg, err := stream.Recv()
		if err != nil {
			t.Errorf("recv: %v", err)
			return
		}
		req := msg.GetSetModelRequest()
		if req == nil {
			continue
		}
		res := &pibridgepb.PiToPhi{
			PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
			Payload: &pibridgepb.PiToPhi_SetModelAck{SetModelAck: &pibridgepb.SetModelAck{
				RequestId: req.GetRequestId(), Ok: ok, Reason: reason,
			}},
		}
		if err := stream.Send(res); err != nil {
			t.Errorf("send ack: %v", err)
		}
		return
	}
}

func TestBridgeThinkingLevelRetainedInBaselinesAndClearedOnNewGeneration(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	env, _, managed := b.Provision("pane-thinking-state", true)
	if !managed {
		t.Fatal("provision not managed")
	}
	b.Complete(&pty.PTYInstance{ID: "pane-thinking-state"})
	floor, _ := b.server.PublicationRevision(env[piBridgeEnvProcess])
	caps := []string{"pi.lifecycle.v1", "pi.thinking.v1"}
	usage := &pibridge.ContextUsage{Tokens: 0, Window: 200000, Percent: 0, HasTokens: true, HasWindow: true, HasPercent: true}
	readiness := &pibridge.Readiness{Idle: false, HasPendingMessages: true}
	b.onState("pane-thinking-state", env[piBridgeEnvProcess], 1, floor+1, false, true, "p/m", "high", caps, usage, readiness)
	baseline := b.PaneSnapshot("pane-thinking-state")
	if baseline.ThinkingLevel != "high" {
		t.Fatalf("HTTP baseline thinking level %q, want high", baseline.ThinkingLevel)
	}
	baselineJSON, err := json.Marshal(baseline)
	if err != nil {
		t.Fatalf("marshal HTTP baseline: %v", err)
	}
	var baselineFields map[string]any
	if err := json.Unmarshal(baselineJSON, &baselineFields); err != nil || baselineFields["thinking_level"] != "high" {
		t.Fatalf("HTTP baseline JSON %s err=%v", baselineJSON, err)
	}
	frame := encodeBridgeState("pane-thinking-state", b.panes["pane-thinking-state"].snapshot())
	if frame.GetThinkingLevel() != "high" {
		t.Fatalf("WS thinking level %q, want high", frame.GetThinkingLevel())
	}
	if frame.ContextTokens == nil || frame.GetContextTokens() != 0 || frame.ContextWindow == nil || frame.GetContextWindow() != 200000 || frame.ContextPercent == nil || frame.GetContextPercent() != 0 {
		t.Fatalf("WS context telemetry lost explicit values: %+v", frame)
	}
	if frame.CompactIdle == nil || frame.GetCompactIdle() || frame.CompactQueued == nil || !frame.GetCompactQueued() {
		t.Fatalf("WS readiness lost explicit booleans: %+v", frame)
	}

	b.onState("pane-thinking-state", env[piBridgeEnvProcess], 2, floor+2, false, false, "", "", caps, nil, nil)
	baseline = b.PaneSnapshot("pane-thinking-state")
	if baseline.Generation != "2" || baseline.ThinkingLevel != "" {
		t.Fatalf("new-generation baseline %+v, want unknown thinking level", baseline)
	}
	baselineJSON, err = json.Marshal(baseline)
	if err != nil {
		t.Fatalf("marshal cleared HTTP baseline: %v", err)
	}
	if err := json.Unmarshal(baselineJSON, &baselineFields); err != nil || baselineFields["thinking_level"] != "" {
		t.Fatalf("cleared HTTP baseline JSON %s err=%v", baselineJSON, err)
	}
	frame = encodeBridgeState("pane-thinking-state", b.panes["pane-thinking-state"].snapshot())
	if frame.ThinkingLevel == nil || frame.GetThinkingLevel() != "" {
		t.Fatalf("new-generation WS thinking level %q present=%v, want explicit unknown", frame.GetThinkingLevel(), frame.ThinkingLevel != nil)
	}
	if frame.ContextTokens != nil || frame.CompactIdle != nil {
		t.Fatalf("unknown new-generation telemetry must remain absent: %+v", frame)
	}
}

func TestBridgeRequestPaneHistory(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	if _, err := b.RequestPaneHistory(context.Background(), "unknown"); err == nil {
		t.Fatal("unknown pane read succeeded")
	}
	var nilBridge *Bridge
	if _, err := nilBridge.RequestPaneHistory(context.Background(), "pane-1"); err == nil {
		t.Fatal("nil bridge read succeeded")
	}

	// Managed lease, no stream: fail fast.
	env, _, managed := b.Provision("pane-np", true)
	if !managed {
		t.Fatal("provision not managed")
	}
	_ = env
	b.Complete(&pty.PTYInstance{ID: "pane-np"})
	if _, err := b.RequestPaneHistory(context.Background(), "pane-np"); err == nil {
		t.Fatal("peerless pane read succeeded")
	}

	// Live peer without the history capability: never request.
	stream, cancel := dialBridgePane(t, b, "pane-lc", "pi.lifecycle.v1")
	defer cancel()
	if _, err := b.RequestPaneHistory(context.Background(), "pane-lc"); err == nil {
		t.Fatal("lifecycle-only pane read succeeded")
	}

	// Live peer with the capability: entries flow newest-first.
	stream, cancel = dialBridgePane(t, b, "pane-h", "pi.lifecycle.v1", "pi.history.v1")
	defer cancel()
	go answerHistoryOnce(t, stream, []string{"newest", "oldest"}, false)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	res, err := b.RequestPaneHistory(ctx, "pane-h")
	if err != nil {
		t.Fatalf("history read: %v", err)
	}
	if res.Unavailable || len(res.Entries) != 2 || res.Entries[0] != "newest" || res.Entries[1] != "oldest" {
		t.Fatalf("result %+v, want newest-first entries", res)
	}

	// Explicit unavailable survives as a result, not an error.
	go answerHistoryOnce(t, stream, nil, true)
	res, err = b.RequestPaneHistory(ctx, "pane-h")
	if err != nil {
		t.Fatalf("unavailable read: %v", err)
	}
	if !res.Unavailable {
		t.Fatalf("result %+v, want unavailable", res)
	}
}

func TestHandlePiBridgeHistory(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	serve := func(method, target string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, nil)
		rec := httptest.NewRecorder()
		handlePiBridgeHistory(rec, req)
		return rec
	}

	if rec := serve(http.MethodPost, "/api/pi-history?pane=x"); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST code %d, want 405", rec.Code)
	}
	if rec := serve(http.MethodGet, "/api/pi-history"); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing pane code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodGet, "/api/pi-history?pane=unknown"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unknown pane code %d, want 503", rec.Code)
	}
	if rec := serve(http.MethodGet, "/api/pi-history?pane=unknown"); !strings.Contains(rec.Body.String(), "pi history unavailable") {
		t.Fatalf("unknown pane body %q, want fixed string", rec.Body.String())
	}

	stream, cancel := dialBridgePane(t, b, "pane-http", "pi.lifecycle.v1", "pi.history.v1")
	defer cancel()
	go answerHistoryOnce(t, stream, []string{"one", "two"}, false)
	rec := serve(http.MethodGet, "/api/pi-history?pane=pane-http")
	if rec.Code != http.StatusOK {
		t.Fatalf("happy code %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store", got)
	}
	var body struct {
		Entries     []string `json:"entries"`
		Unavailable bool     `json:"unavailable"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if body.Unavailable || len(body.Entries) != 2 || body.Entries[0] != "one" {
		t.Fatalf("body %+v, want entries", body)
	}

	// A withheld reply cannot hold the HTTP handler beyond its deadline.
	timedOut := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRecorder()
		handlePiBridgeHistory(r, httptest.NewRequest(http.MethodGet, "/api/pi-history?pane=pane-http", nil))
		timedOut <- r
	}()
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("withheld request: %v", err)
	}
	select {
	case r := <-timedOut:
		if r.Code != http.StatusServiceUnavailable {
			t.Fatalf("timeout code %d, want 503", r.Code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("history handler exceeded its timeout")
	}

	// Peer loss is also a sanitized 503.
	cancel()
	rec = serve(http.MethodGet, "/api/pi-history?pane=pane-http")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("dead peer code %d, want 503", rec.Code)
	}
}

func TestBridgeRequestPaneModels(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	if _, err := b.RequestPaneModels(context.Background(), "unknown"); err == nil {
		t.Fatal("unknown pane read succeeded")
	}
	var nilBridge *Bridge
	if _, err := nilBridge.RequestPaneModels(context.Background(), "pane-1"); err == nil {
		t.Fatal("nil bridge read succeeded")
	}

	// Managed lease, no stream: fail fast.
	_, _, managed := b.Provision("pane-np", true)
	if !managed {
		t.Fatal("provision not managed")
	}
	b.Complete(&pty.PTYInstance{ID: "pane-np"})
	if _, err := b.RequestPaneModels(context.Background(), "pane-np"); err == nil {
		t.Fatal("peerless pane read succeeded")
	}

	// Live peer without the models capability: never request.
	stream, cancel := dialBridgePane(t, b, "pane-lc", "pi.lifecycle.v1")
	defer cancel()
	if _, err := b.RequestPaneModels(context.Background(), "pane-lc"); err == nil {
		t.Fatal("lifecycle-only pane read succeeded")
	}

	// Live peer with the capability: refs flow with flags.
	stream, cancel = dialBridgePane(t, b, "pane-m", "pi.lifecycle.v1", "pi.models.v1")
	defer cancel()
	go answerModelsOnce(t, stream, []*pibridgepb.ModelRef{{Provider: "a", Model: "x"}}, true, false)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	res, err := b.RequestPaneModels(ctx, "pane-m")
	if err != nil {
		t.Fatalf("models read: %v", err)
	}
	if res.Unavailable || !res.Truncated || len(res.Models) != 1 || res.Models[0].Provider != "a" || res.Models[0].Model != "x" {
		t.Fatalf("result %+v, want one truncated ref", res)
	}

	// Explicit unavailable survives as a result, not an error.
	go answerModelsOnce(t, stream, nil, false, true)
	res, err = b.RequestPaneModels(ctx, "pane-m")
	if err != nil {
		t.Fatalf("unavailable read: %v", err)
	}
	if !res.Unavailable {
		t.Fatalf("result %+v, want unavailable", res)
	}
}

func TestBridgeRequestPaneSetModel(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	if _, err := b.RequestPaneSetModel(context.Background(), "unknown", "a", "x"); err == nil {
		t.Fatal("unknown pane switch succeeded")
	}
	var nilBridge *Bridge
	if _, err := nilBridge.RequestPaneSetModel(context.Background(), "pane-1", "a", "x"); err == nil {
		t.Fatal("nil bridge switch succeeded")
	}

	stream, cancel := dialBridgePane(t, b, "pane-lc", "pi.lifecycle.v1")
	defer cancel()
	if _, err := b.RequestPaneSetModel(context.Background(), "pane-lc", "a", "x"); err == nil {
		t.Fatal("lifecycle-only pane switch succeeded")
	}

	stream, cancel = dialBridgePane(t, b, "pane-s", "pi.lifecycle.v1", "pi.models.v1")
	defer cancel()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	go answerSetModelOnce(t, stream, true, "")
	res, err := b.RequestPaneSetModel(ctx, "pane-s", "a", "x")
	if err != nil {
		t.Fatalf("set-model: %v", err)
	}
	if !res.OK || res.Reason != "" {
		t.Fatalf("result %+v, want ok", res)
	}

	go answerSetModelOnce(t, stream, false, "no-auth")
	res, err = b.RequestPaneSetModel(ctx, "pane-s", "a", "x")
	if err != nil {
		t.Fatalf("refused set-model: %v", err)
	}
	if res.OK || res.Reason != "no-auth" {
		t.Fatalf("result %+v, want no-auth refusal", res)
	}
}

func TestHandlePiBridgeThinkingListRejectsReusedPane(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	stream, cancel := dialBridgePane(t, b, "pane-reused-list", "pi.lifecycle.v1", "pi.thinking.v1")
	defer cancel()
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodGet, "/api/pi-bridge/thinking-levels?pane=pane-reused-list", nil)
		rec := httptest.NewRecorder()
		handlePiBridgeThinkingLevels(rec, req)
		result <- rec
	}()
	msg, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv list request: %v", err)
	}
	req := msg.GetThinkingLevelsRequest()
	if req == nil {
		t.Fatalf("not a thinking-level request: %v", msg.GetPayload())
	}
	b.mu.Lock()
	old := b.panes["pane-reused-list"]
	b.panes["pane-reused-list"] = &bridgePane{processID: "replacement-process", managed: true}
	b.mu.Unlock()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
		Payload: &pibridgepb.PiToPhi_ThinkingLevelsResponse{ThinkingLevelsResponse: &pibridgepb.ThinkingLevelsResponse{
			RequestId: req.GetRequestId(), Levels: []string{"off", "high"}, Provider: "p", Model: "m",
		}},
	}); err != nil {
		t.Fatalf("send delayed list: %v", err)
	}
	rec := <-result
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "pi thinking unavailable") {
		t.Fatalf("delayed old-process response status=%d body=%q", rec.Code, rec.Body.String())
	}
	b.mu.Lock()
	b.panes["pane-reused-list"] = old
	b.mu.Unlock()
}

func TestHandlePiBridgeThinkingEndpoints(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	serve := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		rec := httptest.NewRecorder()
		if strings.HasPrefix(path, "/api/pi-bridge/thinking-levels") {
			handlePiBridgeThinkingLevels(rec, req)
		} else {
			handlePiBridgeSetThinking(rec, req)
		}
		return rec
	}
	if rec := serve(http.MethodPost, "/api/pi-bridge/thinking-levels?pane=x", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("list method %d, want 405", rec.Code)
	}
	if rec := serve(http.MethodGet, "/api/pi-bridge/thinking-levels", ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing pane %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodPost, "/api/pi-bridge/thinking", "not-json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad body %d, want 400", rec.Code)
	}
	for _, body := range []string{
		`{"pane":"p","level":"high","provider":"p","model":"m"}`,
		`{"pane":"p","level":"high","provider":"p","model":"m","process_id":"proc","generation":"0"}`,
		`{"pane":"p","level":"high","provider":"p","model":"m","process_id":"proc","generation":"+1"}`,
		`{"pane":"p","level":"high","provider":"p","model":"m","process_id":"proc","generation":"18446744073709551616"}`,
		`{"pane":"p","level":"high","provider":"p","model":"m","process_id":"proc","generation":"1"} {}`,
		`{"pane":"p","level":"xxxxxxxxxxxxxxxxx","provider":"p","model":"m","process_id":"proc","generation":"1"}`,
		`{"pane":"p","level":"high","provider":"` + strings.Repeat("p", 257) + `","model":"m","process_id":"proc","generation":"1"}`,
		`{"pane":"p","level":"high","provider":"p","model":"m","process_id":"` + strings.Repeat("q", 257) + `","generation":"1"}`,
		`{"pane":"p","level":"high","provider":"p","model":"m","process_id":"proc","generation":"1"}` + strings.Repeat(" ", 4100),
	} {
		if rec := serve(http.MethodPost, "/api/pi-bridge/thinking", body); rec.Code != http.StatusBadRequest {
			t.Fatalf("invalid body status %d for %q, want 400", rec.Code, body)
		}
	}

	stream, cancel := dialBridgePane(t, b, "pane-thinking-http", "pi.lifecycle.v1", "pi.thinking.v1")
	defer cancel()
	listResult := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		listResult <- serve(http.MethodGet, "/api/pi-bridge/thinking-levels?pane=pane-thinking-http", "")
	}()
	processID, generation := answerThinkingLevelsOnce(t, stream)
	rec := <-listResult
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("list response status=%d cache=%q body=%q", rec.Code, rec.Header().Get("Cache-Control"), rec.Body.String())
	}
	var list struct {
		Levels      []string `json:"levels"`
		Provider    string   `json:"provider"`
		Model       string   `json:"model"`
		Unavailable bool     `json:"unavailable"`
		ProcessID   string   `json:"process_id"`
		Generation  string   `json:"generation"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("list JSON: %v", err)
	}
	if list.Unavailable || len(list.Levels) != 4 || list.Provider != "p" || list.Model != "m" || list.ProcessID != processID || list.Generation != strconv.FormatUint(generation, 10) {
		t.Fatalf("list %+v, want captured origin", list)
	}

	payload := `{"pane":"pane-thinking-http","level":"high","provider":"p","model":"m","process_id":"` + processID + `","generation":"` + strconv.FormatUint(generation, 10) + `"}`
	setResult := make(chan *httptest.ResponseRecorder, 1)
	go func() { setResult <- serve(http.MethodPost, "/api/pi-bridge/thinking", payload) }()
	answerSetThinkingOnce(t, stream)
	rec = <-setResult
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("set response status=%d cache=%q body=%q", rec.Code, rec.Header().Get("Cache-Control"), rec.Body.String())
	}
	var ack struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil || !ack.OK || ack.Reason != "" {
		t.Fatalf("ack %+v err=%v", ack, err)
	}

	stale := strings.Replace(payload, `"generation":"1"`, `"generation":"2"`, 1)
	if rec = serve(http.MethodPost, "/api/pi-bridge/thinking", stale); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("stale generation status %d, want sanitized 503", rec.Code)
	}
	wrongProcess := strings.Replace(payload, processID, "replacement-process", 1)
	if rec = serve(http.MethodPost, "/api/pi-bridge/thinking", wrongProcess); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("wrong process status %d, want sanitized 503", rec.Code)
	}
}

func TestHandlePiBridgeModels(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	serve := func(method, target string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, nil)
		rec := httptest.NewRecorder()
		handlePiBridgeModels(rec, req)
		return rec
	}

	if rec := serve(http.MethodPost, "/api/pi-bridge/models?pane=x"); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST code %d, want 405", rec.Code)
	}
	if rec := serve(http.MethodGet, "/api/pi-bridge/models"); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing pane code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodGet, "/api/pi-bridge/models?pane=unknown"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unknown pane code %d, want 503", rec.Code)
	}

	stream, cancel := dialBridgePane(t, b, "pane-http", "pi.lifecycle.v1", "pi.models.v1")
	defer cancel()
	go answerModelsOnce(t, stream, []*pibridgepb.ModelRef{{Provider: "a", Model: "x"}}, false, false)
	rec := serve(http.MethodGet, "/api/pi-bridge/models?pane=pane-http")
	if rec.Code != http.StatusOK {
		t.Fatalf("happy code %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store", got)
	}
	var body struct {
		Models []struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
		} `json:"models"`
		Truncated   bool `json:"truncated"`
		Unavailable bool `json:"unavailable"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if body.Unavailable || len(body.Models) != 1 || body.Models[0].Provider != "a" || body.Models[0].ID != "x" {
		t.Fatalf("body %+v, want one mapped row", body)
	}

	// A withheld reply cannot hold the HTTP handler beyond its deadline.
	timedOut := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRecorder()
		handlePiBridgeModels(r, httptest.NewRequest(http.MethodGet, "/api/pi-bridge/models?pane=pane-http", nil))
		timedOut <- r
	}()
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("withheld request: %v", err)
	}
	select {
	case r := <-timedOut:
		if r.Code != http.StatusServiceUnavailable {
			t.Fatalf("timeout code %d, want 503", r.Code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("models handler exceeded its timeout")
	}

	// Peer loss is also a sanitized 503.
	cancel()
	rec = serve(http.MethodGet, "/api/pi-bridge/models?pane=pane-http")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("dead peer code %d, want 503", rec.Code)
	}
}

func TestHandlePiBridgeSetModel(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	serve := func(method, body string) *httptest.ResponseRecorder {
		t.Helper()
		var reader *strings.Reader
		if body == "" {
			reader = strings.NewReader("")
		} else {
			reader = strings.NewReader(body)
		}
		req := httptest.NewRequest(method, "/api/pi-bridge/model", reader)
		rec := httptest.NewRecorder()
		handlePiBridgeSetModel(rec, req)
		return rec
	}

	if rec := serve(http.MethodGet, ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET code %d, want 405", rec.Code)
	}
	if rec := serve(http.MethodPost, "not-json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodPost, `{"pane":"p","provider":"a"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty model code %d, want 400", rec.Code)
	}
	long := strings.Repeat("x", 257)
	if rec := serve(http.MethodPost, `{"pane":"p","provider":"a","model":"`+long+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("overlong model code %d, want 400", rec.Code)
	}
	huge := strings.Repeat("y", 5000)
	if rec := serve(http.MethodPost, `{"pane":"p","provider":"a","model":"`+huge+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized body code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodPost, `{"pane":"unknown","provider":"a","model":"x"}`); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unknown pane code %d, want 503", rec.Code)
	}

	stream, cancel := dialBridgePane(t, b, "pane-http", "pi.lifecycle.v1", "pi.models.v1")
	defer cancel()
	go answerSetModelOnce(t, stream, true, "")
	rec := serve(http.MethodPost, `{"pane":"pane-http","provider":"a","model":"x"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("happy code %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store", got)
	}
	var body struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if !body.OK || body.Reason != "" {
		t.Fatalf("body %+v, want ok", body)
	}

	// Refusal reasons pass through verbatim.
	go answerSetModelOnce(t, stream, false, "unknown-model")
	rec = serve(http.MethodPost, `{"pane":"pane-http","provider":"a","model":"zzz"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("refused code %d, want 200", rec.Code)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if body.OK || body.Reason != "unknown-model" {
		t.Fatalf("body %+v, want unknown-model refusal", body)
	}

	// Peer loss is a sanitized 503.
	cancel()
	rec = serve(http.MethodPost, `{"pane":"pane-http","provider":"a","model":"x"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("dead peer code %d, want 503", rec.Code)
	}
}

func drainBridgeFrames(t *testing.T, client *ws.Client, want int) []*wspb.TerminalBridgeState {
	t.Helper()
	frames := make([]*wspb.TerminalBridgeState, 0, want)
	for len(frames) < want {
		select {
		case raw := <-client.Send:
			server, err := wireproto.DecodeServerFrame(raw)
			if err != nil || server.GetBridgeState() == nil {
				t.Fatalf("frame = %+v err=%v, want a bridge state", server, err)
			}
			frames = append(frames, server.GetBridgeState())
		case <-time.After(5 * time.Second):
			t.Fatalf("only %d of %d frames", len(frames), want)
		}
	}
	select {
	case raw := <-client.Send:
		t.Fatalf("extra frame: %x", raw)
	case <-time.After(200 * time.Millisecond):
	}
	return frames
}

// A delayed older publication must not replace a newer retained view.
// Duplicates and zero revisions are idempotent silence: one broadcast
// for the accepted publication, none for the rest.
func TestBridgeOnStateFencesPublicationOrder(t *testing.T) {
	hub := testBridgeHub()
	b := startPiBridge(hub)
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env, _, _ := b.Provision("pane-1", true)
	proc := env[piBridgeEnvProcess]
	client := &ws.Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	<-client.Send // ATTACH_HEAD
	floor, _ := b.server.PublicationRevision(proc)

	// Newer publication lands first, then the delayed older one.
	b.onState("pane-1", proc, 1, floor+2, false, true, "provB/modelB", "", []string{"pi.lifecycle.v1"}, nil, nil)
	b.onState("pane-1", proc, 1, floor+1, false, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)
	b.onState("pane-1", proc, 1, floor+2, false, true, "provB/modelB", "", []string{"pi.lifecycle.v1"}, nil, nil)
	b.onState("pane-1", proc, 1, 0, false, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)

	wantRev := strconv.FormatUint(floor+2, 10)
	if got := b.PaneSnapshot("pane-1"); got.Model != "provB/modelB" || got.TelemetryRevision != wantRev {
		t.Fatalf("snapshot %+v, want modelB at rev %s", got, wantRev)
	}
	frames := drainBridgeFrames(t, client, 1)
	if frames[0].GetModel() != "provB/modelB" || strconv.FormatUint(frames[0].GetTelemetryRevision(), 10) != wantRev {
		t.Fatalf("frame %+v, want modelB at rev %s", frames[0], wantRev)
	}
}

// HTTP snapshots and attach frames carry one coherent
// (revision, model) pair from the same retained view.
func TestBridgeSnapshotAndAttachShareOneRevision(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env, _, _ := b.Provision("pane-1", true)
	proc := env[piBridgeEnvProcess]
	floor, _ := b.server.PublicationRevision(proc)
	b.onState("pane-1", proc, 1, floor+1, true, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)

	snap := b.PaneSnapshot("pane-1")
	attach := b.encodeAttach(pty.PTYInstanceSnapshot{ID: "pane-1", Coder: "pi"})
	if attach == nil {
		t.Fatal("no attach frame")
	}
	if snap.Model != "provA/modelA" || attach.GetModel() != snap.Model {
		t.Fatalf("snapshot %+v vs attach %+v, want one model", snap, attach)
	}
	if snap.TelemetryRevision == "" || strconv.FormatUint(attach.GetTelemetryRevision(), 10) != snap.TelemetryRevision {
		t.Fatalf("snapshot %+v vs attach %+v, want one revision", snap, attach)
	}
	if snap.Running == nil || !*snap.Running || attach.Running == nil || !*attach.Running {
		t.Fatalf("snapshot %+v vs attach %+v, want running", snap, attach)
	}
}

// A reused pane ID starts from a fresh empty baseline above every
// publication of the prior record; delayed callbacks from the dead
// lease can never apply.
func TestBridgeReusedPaneStartsAboveOldPublications(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	envA, _, _ := b.Provision("pane-1", true)
	procA := envA[piBridgeEnvProcess]
	floorA, _ := b.server.PublicationRevision(procA)
	if got := b.PaneSnapshot("pane-1"); got.State != piBridgeManaged ||
		got.TelemetryRevision != strconv.FormatUint(floorA, 10) || got.Model != "" || got.Running != nil {
		t.Fatalf("fresh baseline %+v, want managed rev floor, no model", got)
	}
	b.onState("pane-1", procA, 1, floorA+1, false, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)

	b.RevokePane("pane-1")
	envB, _, managed := b.Provision("pane-1", true)
	if !managed {
		t.Fatal("retry provision not managed")
	}
	procB := envB[piBridgeEnvProcess]
	floorB, _ := b.server.PublicationRevision(procB)
	if floorB <= floorA {
		t.Fatalf("floor %d not above old floor %d", floorB, floorA)
	}
	if got := b.PaneSnapshot("pane-1"); got.TelemetryRevision != strconv.FormatUint(floorB, 10) ||
		got.Model != "" || got.Running != nil || got.Generation != "" {
		t.Fatalf("reused baseline %+v, want empty rev floor", got)
	}
	// Delayed callback from the dead lease drops on process mismatch.
	b.onState("pane-1", procA, 1, floorA+2, false, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)
	if got := b.PaneSnapshot("pane-1"); got.TelemetryRevision != strconv.FormatUint(floorB, 10) || got.Model != "" {
		t.Fatalf("dead-lease callback applied: %+v", got)
	}
}

// A Hello without state advances the revision floor but keeps
// model/usage unknown; a new generation also clears the stale
// model/usage of the old process instead of inheriting it.
func TestBridgeStatelessHelloKeepsModelUnknown(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env, _, _ := b.Provision("pane-1", true)
	proc := env[piBridgeEnvProcess]
	floor, _ := b.server.PublicationRevision(proc)
	b.onState("pane-1", proc, 1, floor+1, false, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)
	if got := b.PaneSnapshot("pane-1"); got.Model != "provA/modelA" {
		t.Fatalf("snapshot %+v, want modelA", got)
	}

	// Capabilities ride the Hello, not the snapshot: a stateless
	// republish still updates the negotiated set.
	b.onState("pane-1", proc, 2, floor+2, false, false, "", "", []string{"pi.lifecycle.v1"}, nil, nil)
	if got := b.PaneSnapshot("pane-1"); got.Generation != "2" ||
		got.TelemetryRevision != strconv.FormatUint(floor+2, 10) ||
		got.Model != "" || got.Running != nil || !slices.Equal(got.Capabilities, []string{"pi.lifecycle.v1"}) {
		t.Fatalf("new-gen stateless %+v, want unknown model with caps at rev floor+2", got)
	}

	b.onState("pane-1", proc, 2, floor+3, false, false, "", "", []string{"pi.lifecycle.v1", "pi.extra.v1"}, nil, nil)
	if got := b.PaneSnapshot("pane-1"); got.TelemetryRevision != strconv.FormatUint(floor+3, 10) ||
		got.Model != "" || got.Running != nil || !slices.Equal(got.Capabilities, []string{"pi.lifecycle.v1", "pi.extra.v1"}) {
		t.Fatalf("same-gen stateless %+v, want unknown model with caps at rev floor+3", got)
	}
}

// Publication floors are per pane: a stale callback for one pane
// never disturbs another.
func TestBridgePublicationFloorsArePerPane(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()

	env1, _, _ := b.Provision("pane-1", true)
	env2, _, _ := b.Provision("pane-2", true)
	proc1, proc2 := env1[piBridgeEnvProcess], env2[piBridgeEnvProcess]
	floor1, _ := b.server.PublicationRevision(proc1)
	floor2, _ := b.server.PublicationRevision(proc2)

	b.onState("pane-2", proc2, 1, floor2+1, false, true, "provB/modelB", "", []string{"pi.lifecycle.v1"}, nil, nil)
	// Equal-to-floor and zero revisions drop for pane-1.
	b.onState("pane-1", proc1, 1, floor1, false, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)
	b.onState("pane-1", proc1, 1, 0, false, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)
	if got := b.PaneSnapshot("pane-1"); got.TelemetryRevision != strconv.FormatUint(floor1, 10) || got.Model != "" {
		t.Fatalf("pane-1 %+v, want empty floor", got)
	}
	if got := b.PaneSnapshot("pane-2"); got.Model != "provB/modelB" {
		t.Fatalf("pane-2 %+v, want modelB", got)
	}

	b.onState("pane-1", proc1, 1, floor1+1, false, true, "provA/modelA", "", []string{"pi.lifecycle.v1"}, nil, nil)
	if got := b.PaneSnapshot("pane-1"); got.Model != "provA/modelA" {
		t.Fatalf("pane-1 %+v, want modelA", got)
	}
	if got := b.PaneSnapshot("pane-2"); got.Model != "provB/modelB" ||
		got.TelemetryRevision != strconv.FormatUint(floor2+1, 10) {
		t.Fatalf("pane-2 %+v, want undisturbed modelB", got)
	}
}

// answerSkillsOnce serves one SkillsRequest on a test stream with a
// canned response, then returns.
// paneProcessID reports the bridge process that owns one pane, so a
// test can echo the origin that the pane's answers carry.
func paneProcessID(t *testing.T, b *Bridge, pane string) string {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	p, ok := b.panes[pane]
	if !ok {
		t.Fatalf("pane %s is not registered", pane)
	}
	return p.processID
}

func answerSkillsOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient, skills []*pibridgepb.SkillRef, truncated, unavailable bool) {
	t.Helper()
	for {
		msg, err := stream.Recv()
		if err != nil {
			t.Errorf("recv: %v", err)
			return
		}
		req := msg.GetSkillsRequest()
		if req == nil {
			continue
		}
		res := &pibridgepb.PiToPhi{
			PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
			Payload: &pibridgepb.PiToPhi_SkillsResponse{SkillsResponse: &pibridgepb.SkillsResponse{
				RequestId: req.GetRequestId(), Skills: skills, Truncated: truncated, Unavailable: unavailable,
			}},
		}
		if err := stream.Send(res); err != nil {
			t.Errorf("send response: %v", err)
		}
		return
	}
}

// answerInvokeSkillOnce serves one InvokeSkillRequest on a test stream
// with a canned ack, then returns.
func answerInvokeSkillOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient, ok bool, reason string) {
	t.Helper()
	for {
		msg, err := stream.Recv()
		if err != nil {
			t.Errorf("recv: %v", err)
			return
		}
		req := msg.GetInvokeSkillRequest()
		if req == nil {
			continue
		}
		res := &pibridgepb.PiToPhi{
			PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
			Payload: &pibridgepb.PiToPhi_InvokeSkillAck{InvokeSkillAck: &pibridgepb.InvokeSkillAck{
				RequestId: req.GetRequestId(), Ok: ok, Reason: reason,
			}},
		}
		if err := stream.Send(res); err != nil {
			t.Errorf("send ack: %v", err)
		}
		return
	}
}

func TestHandlePiBridgeSkills(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	serve := func(method, target string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, nil)
		rec := httptest.NewRecorder()
		handlePiBridgeSkills(rec, req)
		return rec
	}

	if rec := serve(http.MethodPost, "/api/pi-bridge/skills?pane=x"); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST code %d, want 405", rec.Code)
	}
	if rec := serve(http.MethodGet, "/api/pi-bridge/skills"); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing pane code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodGet, "/api/pi-bridge/skills?pane=unknown"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unknown pane code %d, want 503", rec.Code)
	}

	stream, cancel := dialBridgePane(t, b, "pane-http", "pi.lifecycle.v1", "pi.skills.v1")
	defer cancel()
	go answerSkillsOnce(t, stream, []*pibridgepb.SkillRef{
		{Name: "demo-skill", Description: "demo"},
	}, false, false)
	rec := serve(http.MethodGet, "/api/pi-bridge/skills?pane=pane-http")
	if rec.Code != http.StatusOK {
		t.Fatalf("happy code %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store", got)
	}
	var body struct {
		Skills []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"skills"`
		Truncated   bool   `json:"truncated"`
		Unavailable bool   `json:"unavailable"`
		ProcessID   string `json:"process_id"`
		Generation  string `json:"generation"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if body.Unavailable || len(body.Skills) != 1 || body.Skills[0].Name != "demo-skill" {
		t.Fatalf("body %+v, want one skill row", body)
	}
	// The answer names the peer that served it, so a click can be
	// fenced to that runtime.
	if body.ProcessID == "" || body.Generation != "1" {
		t.Fatalf("body %+v, want the answering origin", body)
	}

	// A withheld reply cannot hold the HTTP handler beyond its deadline.
	timedOut := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRecorder()
		handlePiBridgeSkills(r, httptest.NewRequest(http.MethodGet, "/api/pi-bridge/skills?pane=pane-http", nil))
		timedOut <- r
	}()
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("withheld request: %v", err)
	}
	select {
	case r := <-timedOut:
		if r.Code != http.StatusServiceUnavailable {
			t.Fatalf("timeout code %d, want 503", r.Code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("skills handler exceeded its timeout")
	}

	// Peer loss is also a sanitized 503.
	cancel()
	rec = serve(http.MethodGet, "/api/pi-bridge/skills?pane=pane-http")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("dead peer code %d, want 503", rec.Code)
	}
}

func TestHandlePiBridgeInvokeSkill(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	serve := func(method, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "/api/pi-bridge/skill", strings.NewReader(body))
		rec := httptest.NewRecorder()
		handlePiBridgeInvokeSkill(rec, req)
		return rec
	}

	if rec := serve(http.MethodGet, ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET code %d, want 405", rec.Code)
	}
	if rec := serve(http.MethodPost, `{"name":"demo-skill"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing pane code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodPost, `{"pane":"p1"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing name code %d, want 400", rec.Code)
	}
	// The origin of the list that produced the row must be echoed.
	if rec := serve(http.MethodPost, `{"pane":"p1","name":"demo-skill"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing origin code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodPost, `{"pane":"p1","name":"demo-skill","process_id":"proc"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing generation code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodPost, `{"pane":"p1","name":"demo-skill","process_id":"proc","generation":"x"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed generation code %d, want 400", rec.Code)
	}
	// A name that cannot be carried on the wire is a client error and
	// never reaches the peer.
	if rec := serve(http.MethodPost, `{"pane":"p1","name":"`+strings.Repeat("x", 65)+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized name code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodPost, `{"pane":"p1","name":"`+strings.Repeat("x", 5000)+`"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized body code %d, want 400", rec.Code)
	}
	if rec := serve(http.MethodPost, `{"pane":"unknown","name":"demo-skill","process_id":"proc","generation":"1"}`); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unknown pane code %d, want 503", rec.Code)
	}

	stream, cancel := dialBridgePane(t, b, "pane-http", "pi.lifecycle.v1", "pi.skills.v1")
	defer cancel()
	processID := paneProcessID(t, b, "pane-http")
	origin := `{"pane":"pane-http","name":"demo-skill","process_id":"` + processID + `","generation":"1"}`
	go answerInvokeSkillOnce(t, stream, true, "")
	rec := serve(http.MethodPost, origin)
	if rec.Code != http.StatusOK {
		t.Fatalf("happy code %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store", got)
	}
	var body struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if !body.OK || body.Reason != "" {
		t.Fatalf("body %+v, want dispatched", body)
	}

	// An unknown skill is a refusal, not an error.
	go answerInvokeSkillOnce(t, stream, false, "unknown-skill")
	rec = serve(http.MethodPost, strings.Replace(origin, "demo-skill", "other-skill", 1))
	if rec.Code != http.StatusOK {
		t.Fatalf("refusal code %d, want 200", rec.Code)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if body.OK || body.Reason != "unknown-skill" {
		t.Fatalf("body %+v, want unknown-skill refusal", body)
	}

	// A runtime that moved on refuses the click before any dispatch:
	// the outcome is known, so it is a refusal and not an unknown one.
	for name, stale := range map[string]string{
		"stale generation": strings.Replace(origin, `"generation":"1"`, `"generation":"2"`, 1),
		"wrong process":    strings.Replace(origin, processID, "replacement-process", 1),
	} {
		rec = serve(http.MethodPost, stale)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s code %d, want 200", name, rec.Code)
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("body decode: %v", err)
		}
		if body.OK || body.Reason != "unavailable" {
			t.Fatalf("%s body %+v, want an unavailable refusal", name, body)
		}
	}

	// Peer loss is a sanitized 503.
	cancel()
	rec = serve(http.MethodPost, origin)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("dead peer code %d, want 503", rec.Code)
	}
}
