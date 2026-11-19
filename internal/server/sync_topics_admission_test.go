package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/internal/pibridge"
	"github.com/hypernewbie/phi/pkg/ws"
)

func TestSyncTopicFollowerRegistrationRejectsRemovedNativeOwner(t *testing.T) {
	withTempConfig(t)
	app := testServer
	app.hub = ws.NewHub(0)
	app.bridge = piapp.StartBridge(app.hub, func() ([]byte, error) { return []byte("test runtime"), nil }, "0.0.0-test", nil)
	if app.bridge == nil {
		t.Fatal("bridge did not start")
	}
	defer app.bridge.Stop()
	app.bridge.SetSyncboardTopicEpoch(app.syncTopics.epoch)
	for _, existing := range []bool{false, true} {
		t.Run(strconv.FormatBool(existing), func(t *testing.T) {
			client := newSyncTopicPeerClient(app, url.URL{}, "", "f1", "")
			client.active, client.ready, client.epoch = true, true, app.syncTopics.epoch
			owner := pibridge.SyncboardOwner{PaneID: "removed", ProcessID: "proc", Generation: 1}
			if existing {
				client.intents["removed\x00proc\x00alerts"] = syncTopicPeerIntent{owner: *wireOwnerFromPibridge(owner), topic: "alerts"}
			}
			if err := client.Register(owner, "alerts"); !errors.Is(err, pibridge.ErrTopicUnavailable) {
				t.Fatalf("removed native owner inherited or created a follower intent: %v", err)
			}
			if client.pending != nil {
				t.Fatal("removed native owner queued a registration control")
			}
		})
	}
}

func TestSyncTopicPostRetiresRemovedLocalOwnerBeforeCapacityAdmission(t *testing.T) {
	withTempConfig(t)
	app := testServer
	app.setSyncPathForTest(filepath.Join(t.TempDir(), "syncboard.json"))
	defer func() {
		app.saveMu.Lock()
		if app.saveTimer != nil {
			app.saveTimer.Stop()
		}
		app.saveMu.Unlock()
	}()
	app.hub = ws.NewHub(0)
	app.bridge = piapp.StartBridge(app.hub, func() ([]byte, error) { return []byte("test runtime"), nil }, "0.0.0-test", nil)
	if app.bridge == nil {
		t.Fatal("bridge did not start")
	}
	defer app.bridge.Stop()
	app.bridge.SetSyncboardTopicEpoch(app.syncTopics.epoch)
	local := topicOwner("local")
	for i := 0; i < maxSyncTopicBatchesPerOwner; i++ {
		topic := "old-" + strconv.Itoa(i)
		if i == 0 {
			topic = "alerts"
		}
		if err := app.syncTopics.subscribeLocked(local, topic); err != nil {
			t.Fatal(err)
		}
		if admitted, err := app.syncTopics.admitPostLocked(topic, "old", time.Now().Add(-2*syncTopicBatchWindow)); err != nil || !admitted {
			t.Fatalf("seed admission = %v, %v", admitted, err)
		}
	}
	remote := syncTopicOwner{
		paneID: "remote-pane", processID: "remote-process", generation: 1,
		runtimeID: "runtime", sessionID: "session", remote: true, peerID: "peer",
		remoteSend: func(*syncTopicBatch) error { return nil },
	}
	if err := app.syncTopics.subscribeRemoteLocked(remote, "alerts"); err != nil {
		t.Fatal(err)
	}
	// The native registry no longer has local's lease, but its delayed
	// retirement callback has not yet removed the captured topic owner.
	posted := httptest.NewRecorder()
	app.handleSyncMessages(posted, httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(`{"key":"alerts","value":"new"}`)))
	if posted.Code != http.StatusOK {
		t.Fatalf("removed owner's capacity blocked POST: %d %s", posted.Code, posted.Body.String())
	}
	if row := app.syncStore["alerts"]; row == nil || row.Value != "new" {
		t.Fatal("POST did not commit its board row")
	}
	if _, exists := app.syncTopics.owners[syncTopicOwnerKey(local)]; exists {
		t.Fatal("removed native owner survived admission")
	}
	remaining := app.syncTopics.owners[syncTopicOwnerKey(remote)]
	if len(app.syncTopics.owners) != 1 || remaining == nil || len(remaining.batches) != 1 || app.syncTopics.totalBatches != 1 {
		t.Fatal("local retirement lost remote admission or leaked old reservations")
	}
}
