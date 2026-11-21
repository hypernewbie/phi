package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/pibridge"
)

func TestSyncTopicLiveAuthorityChangeRequiresRestart(t *testing.T) {
	for _, change := range []string{"follower-to-coordinator", "coordinator-to-follower", "target", "peer-id"} {
		t.Run(change, func(t *testing.T) {
			withTempConfig(t)
			app := testServer
			app.setSyncPathForTest(filepath.Join(t.TempDir(), "syncboard.json"))
			defer func() { _ = app.flushSyncStore() }()
			var oldCalls, newCalls atomic.Int64
			oldTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				oldCalls.Add(1)
				_, _ = w.Write([]byte("[]"))
			}))
			defer oldTarget.Close()
			newTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				newCalls.Add(1)
				_, _ = w.Write([]byte("[]"))
			}))
			defer newTarget.Close()
			initial, err := testStore.Update(func(cfg *config.Config) error {
				cfg.SyncCoordinator, cfg.SyncTopicsPeerID = oldTarget.URL, "f1"
				if change == "coordinator-to-follower" {
					cfg.SyncCoordinator = ""
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			row := &SyncMessage{Key: "dormant", Value: "unchanged"}
			app.syncStore[row.Key] = row
			baseline := httptest.NewRecorder()
			app.handleSyncMessages(baseline, httptest.NewRequest(http.MethodGet, "/api/sync/messages", nil))
			if baseline.Code != http.StatusOK {
				t.Fatalf("baseline status = %d", baseline.Code)
			}
			beforeCalls := oldCalls.Load()
			if _, err := testStore.Update(func(cfg *config.Config) error {
				switch change {
				case "follower-to-coordinator":
					cfg.SyncCoordinator = ""
				case "target", "coordinator-to-follower":
					cfg.SyncCoordinator = newTarget.URL
				case "peer-id":
					cfg.SyncTopicsPeerID = "f2"
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			for _, restored := range []bool{false, true} {
				if restored {
					if _, err := testStore.Update(func(cfg *config.Config) error {
						cfg.SyncCoordinator, cfg.SyncTopicsPeerID = initial.SyncCoordinator, initial.SyncTopicsPeerID
						return nil
					}); err != nil {
						t.Fatal(err)
					}
				}
				for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
					path := "/api/sync/messages"
					if method == http.MethodDelete {
						path += "/dormant"
					}
					response := httptest.NewRecorder()
					app.handleSyncMessages(response, httptest.NewRequest(method, path, strings.NewReader(`{"key":"new","value":"refused"}`)))
					if response.Code != http.StatusServiceUnavailable {
						t.Errorf("%s restored=%v status=%d, want not-ready", method, restored, response.Code)
					}
				}
			}
			if oldCalls.Load() != beforeCalls || newCalls.Load() != 0 {
				t.Errorf("authority change contacted a coordinator: old=%d (baseline=%d), new=%d", oldCalls.Load(), beforeCalls, newCalls.Load())
			}
			if len(app.syncStore) != 1 || app.syncStore[row.Key] != row {
				t.Error("authority change readmitted the dormant local board")
			}
		})
	}
}

func TestSyncTopicFollowerLiveAuthorityChangeRetainsFormerCoordinatorWork(t *testing.T) {
	for _, change := range []string{"role", "target", "peer-id"} {
		t.Run(change, func(t *testing.T) {
			withTempConfig(t)
			coordinator, coordinatorStore := testServer, testStore
			secret := strings.Repeat("a", 64)
			if _, err := coordinatorStore.Update(func(cfg *config.Config) error {
				cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			handlerDone := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerDone)
				coordinator.handleSyncTopicPeer(w, r)
			}))
			defer srv.Close()
			withTempConfig(t)
			follower, followerStore := testServer, testStore
			initial, err := followerStore.Update(func(cfg *config.Config) error {
				cfg.SyncCoordinator, cfg.SyncTopicsPeerID, cfg.SyncTopicsPeerSecret = srv.URL, "f1", secret
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			target, err := url.Parse("ws" + strings.TrimPrefix(srv.URL, "http") + syncTopicsPeerPath)
			if err != nil {
				t.Fatal(err)
			}
			client := newSyncTopicPeerClient(follower, *target, srv.URL, "f1", secret)
			follower.syncTopicPeer = client
			connectDone := make(chan error, 1)
			go func() { connectDone <- client.connect(secret) }()
			defer func() {
				client.mu.Lock()
				conn := client.ws
				client.mu.Unlock()
				if conn != nil {
					_ = conn.Close()
				}
				select {
				case <-connectDone:
				case <-time.After(2 * time.Second):
					t.Error("follower reader did not stop")
				}
				select {
				case <-handlerDone:
				case <-time.After(2 * time.Second):
					t.Error("former coordinator reader did not stop")
				}
			}()
			owner := pibridge.SyncboardOwner{PaneID: "pane", ProcessID: "proc", Generation: 1}
			deadline := time.Now().Add(2 * time.Second)
			for {
				if err := client.Register(owner, "alerts"); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("follower did not register its owner")
				}
				time.Sleep(time.Millisecond)
			}
			wire := *wireOwnerFromPibridge(owner)
			coordinator.syncMu.Lock()
			_, err = coordinator.syncTopics.admitPostLocked("alerts", "retained", time.Now())
			batch := coordinator.syncTopics.owners[syncTopicOwnerKey(syncTopicOwnerFromWire("f1", wire))].batches[0]
			coordinator.syncMu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			client.mu.Lock()
			client.batches[batch.id] = wire
			client.mu.Unlock()
			if _, err := followerStore.Update(func(cfg *config.Config) error {
				switch change {
				case "role":
					cfg.SyncCoordinator = ""
				case "target":
					cfg.SyncCoordinator += "/replacement"
				case "peer-id":
					cfg.SyncTopicsPeerID = "f2"
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if client.Ack(owner, coordinator.syncTopics.epoch, batch.seq, batch.id) {
				t.Fatal("changed authority sent an old-target ACK")
			}
			if _, err := followerStore.Update(func(cfg *config.Config) error {
				cfg.SyncCoordinator, cfg.SyncTopicsPeerID = initial.SyncCoordinator, initial.SyncTopicsPeerID
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if err := client.Register(owner, "alerts"); err == nil || client.checkConfig() {
				t.Fatal("restored configuration revived a restart-required follower")
			}
			select {
			case <-handlerDone:
			case <-time.After(2 * time.Second):
				t.Fatal("authority change left the former feed open")
			}
			coordinator.syncMu.RLock()
			_, subs, batches := coordinator.syncTopics.statsLocked()
			coordinator.syncMu.RUnlock()
			coordinator.peerRegistry().mu.Lock()
			cohort := coordinator.peerRegistry().byPeer["f1"]
			retained := !cohort.retired && !cohort.ready && cohort.lastControl == 1
			coordinator.peerRegistry().mu.Unlock()
			if subs != 1 || batches != 1 || !retained {
				t.Fatal("authority change canceled or acknowledged work at its former coordinator")
			}
			if _, err := coordinatorStore.Update(func(cfg *config.Config) error {
				delete(cfg.SyncTopicsAllowedPeers, "f1")
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			coordinator.peerRegistry().sweep(coordinator)
			if coordinator.syncTopics.totalSubs != 0 || coordinator.syncTopics.totalBatches != 0 {
				t.Fatal("explicit former-coordinator revocation did not release its reservations")
			}
		})
	}
}

func TestSyncTopicUnavailableConfigPreservesFollowerWork(t *testing.T) {
	for _, failure := range []string{"unreadable", "invalid-target", "invalid-peer", "invalid-secret"} {
		t.Run(failure, func(t *testing.T) {
			path := withTempConfig(t)
			app := testServer
			secret := strings.Repeat("a", 64)
			if _, err := testStore.Update(func(cfg *config.Config) error {
				cfg.SyncCoordinator, cfg.SyncTopicsPeerID, cfg.SyncTopicsPeerSecret = "http://coordinator.invalid", "f1", secret
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			client := newSyncTopicPeerClient(app, url.URL{}, "http://coordinator.invalid", "f1", secret)
			if !client.checkConfig() {
				t.Fatal("valid initial config was unavailable")
			}
			owner := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1}
			pending := &syncTopicPeerPending{seq: 1, action: "register", owner: owner, topic: "alerts", done: make(chan struct{})}
			client.active, client.ready, client.pending = true, true, pending
			client.intents["pane\x00proc\x00alerts"] = syncTopicPeerIntent{owner: owner, topic: "alerts"}
			client.dirtyRetire["old\x00proc"] = syncTopicPeerRetire{owner: owner, key: "old\x00proc"}
			client.batches["retained"] = owner
			if failure == "unreadable" {
				if err := os.WriteFile(path, []byte("sync_coordinator = \n"), 0o600); err != nil {
					t.Fatal(err)
				}
				testStore.ResetCache()
			} else if _, err := testStore.Update(func(cfg *config.Config) error {
				switch failure {
				case "invalid-target":
					cfg.SyncCoordinator = "not-a-url"
				case "invalid-peer":
					cfg.SyncTopicsPeerID = strings.Repeat("p", syncTopicsPeerMaxID+1)
				case "invalid-secret":
					cfg.SyncTopicsPeerSecret = "invalid"
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if client.checkConfig() || client.active || client.ready || client.retired || client.blocked ||
				client.pending != pending || pending.retired || len(client.intents) != 1 || len(client.dirtyRetire) != 1 || len(client.batches) != 1 {
				t.Fatal("unavailable config changed retained follower work or permanently fenced it")
			}
			if err := os.WriteFile(path, original, 0o600); err != nil {
				t.Fatal(err)
			}
			testStore.ResetCache()
			if !client.checkConfig() {
				t.Fatal("corrected config could not resume its original authority")
			}
		})
	}
}

func TestSyncTopicAuthorityChangeDuringPostBodyRead(t *testing.T) {
	for _, follower := range []bool{false, true} {
		t.Run(map[bool]string{false: "coordinator", true: "follower"}[follower], func(t *testing.T) {
			withTempConfig(t)
			app := testServer
			app.setSyncPathForTest(filepath.Join(t.TempDir(), "syncboard.json"))
			defer func() { _ = app.flushSyncStore() }()
			var calls atomic.Int64
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = w.Write([]byte("{}"))
			}))
			defer target.Close()
			if follower {
				if _, err := testStore.Update(func(cfg *config.Config) error {
					cfg.SyncCoordinator, cfg.SyncTopicsPeerID = target.URL, "f1"
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := app.loadSyncConfig(); err != nil {
				t.Fatal(err)
			}
			reader, writer := io.Pipe()
			defer reader.Close()
			defer writer.Close()
			response := httptest.NewRecorder()
			done := make(chan struct{})
			go func() {
				defer close(done)
				app.handleSyncMessages(response, httptest.NewRequest(http.MethodPost, "/api/sync/messages", reader))
			}()
			// A pipe write completes only after the handler enters its body read.
			if _, err := writer.Write([]byte(`{"key":"new",`)); err != nil {
				t.Fatal(err)
			}
			if _, err := testStore.Update(func(cfg *config.Config) error {
				if follower {
					cfg.SyncCoordinator = ""
				} else {
					cfg.SyncCoordinator = target.URL
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			probe := httptest.NewRecorder()
			app.handleSyncMessages(probe, httptest.NewRequest(http.MethodGet, "/api/sync/messages", nil))
			if probe.Code != http.StatusServiceUnavailable {
				t.Fatal("changed authority was not fenced during the blocked body read")
			}
			if _, err := writer.Write([]byte(`"value":"refused"}`)); err != nil {
				t.Fatal(err)
			}
			_ = writer.Close()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("POST did not finish after its body completed")
			}
			if response.Code != http.StatusServiceUnavailable || len(app.syncStore) != 0 || calls.Load() != 0 {
				t.Fatal("body-blocked POST crossed the authority fence")
			}
		})
	}
}

func TestSyncTopicSecretRotationPreservesPendingRetirement(t *testing.T) {
	withTempConfig(t)
	secret := strings.Repeat("a", 64)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncCoordinator, cfg.SyncTopicsPeerID, cfg.SyncTopicsPeerSecret = "http://coordinator.invalid", "f1", secret
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	client := newSyncTopicPeerClient(testServer, url.URL{}, "http://coordinator.invalid", "f1", secret)
	if !client.checkConfig() {
		t.Fatal("valid initial config was unavailable")
	}
	owner := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 2}
	pending := &syncTopicPeerPending{seq: 2, action: "register", owner: owner, topic: "alerts", done: make(chan struct{})}
	client.epoch, client.fence, client.stream = "epoch", "fence", "stream"
	client.active, client.ready, client.control, client.pending = true, true, 1, pending
	client.intents["pane\x00proc\x00alerts"] = syncTopicPeerIntent{owner: owner, topic: "alerts"}
	client.dirtyRetire["old\x00proc"] = syncTopicPeerRetire{owner: syncTopicWireOwn{Pane: "old", Process: "proc", Generation: 1}, key: "old\x00proc"}
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerSecret = strings.Repeat("b", 64)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if client.checkConfig() || !client.retired || client.blocked || client.active || client.ready ||
		client.pending != pending || !pending.retired || len(client.intents) != 0 || len(client.dirtyRetire) != 2 || client.control != 1 {
		t.Fatal("secret rotation lost ordered retirement or left the old stream active")
	}
	client.handleResult(&syncTopicPeerFrame{Type: "result", Epoch: "epoch", Fence: "fence", Stream: "stream", Control: "2", Result: "ok"})
	if err := waitPeerResult(pending); err == nil || client.pending != nil || client.control != 2 || len(client.intents) != 0 || len(client.dirtyRetire) != 2 {
		t.Fatal("late pre-rotation registration resurrected its retired owner or lost cleanup")
	}
}
