package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/config"
)

func TestSyncTopicPeerRechecksAuthorityAfterBlockedRead(t *testing.T) {
	for _, kind := range []string{"register", "retire_owner", "ack", "ready"} {
		t.Run(kind, func(t *testing.T) {
			path := withTempConfig(t)
			app := testServer
			secret := strings.Repeat("a", 64)
			if _, err := testStore.Update(func(cfg *config.Config) error {
				cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			handlerDone := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerDone)
				app.handleSyncTopicPeer(w, r)
			}))
			defer srv.Close()
			header := http.Header{}
			header.Set(syncTopicsPeerHeader, "f1")
			header.Set(syncTopicsSecretHeader, secret)
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+syncTopicsPeerPath, header)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			var offer, bound, result syncTopicPeerFrame
			if err := conn.ReadJSON(&offer); err != nil {
				t.Fatal(err)
			}
			if err := conn.WriteJSON(syncTopicPeerFrame{Type: "bind", Version: syncTopicsPeerVersion, Epoch: offer.Epoch, Instance: "instance", Prior: offer.Fence}); err != nil {
				t.Fatal(err)
			}
			if err := conn.ReadJSON(&bound); err != nil || bound.Type != "bound" {
				t.Fatalf("bind failed: %v", err)
			}
			owner := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1}
			frame := syncTopicPeerFrame{Type: "control", Epoch: bound.Epoch, Fence: bound.Fence, Stream: bound.Stream, Control: "1", Action: "register", Owner: &owner, Topic: "alerts"}
			if err := conn.WriteJSON(frame); err != nil {
				t.Fatal(err)
			}
			if err := conn.ReadJSON(&result); err != nil || result.Result != "ok" {
				t.Fatalf("seed registration failed: %v", err)
			}
			app.syncMu.Lock()
			_, err = app.syncTopics.admitPostLocked("alerts", "retained", time.Unix(1600, 0))
			pending := app.syncTopics.owners[syncTopicOwnerKey(syncTopicOwnerFromWire("f1", owner))].batches[0]
			app.syncMu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			frame.Control, frame.Action, frame.Topic = "2", kind, "new"
			if kind == "ack" {
				frame.Type, frame.Seq, frame.BatchID = "ack", canonicalCounter(pending.seq), pending.id
			} else if kind == "ready" {
				frame.Type, frame.Last = "ready", "1"
			}
			ponged := false
			conn.SetPongHandler(func(string) error {
				ponged = true
				// Pong proves the server passed its pre-read authority check and
				// is inside ReadMessage. Change authority before application data.
				if err := os.WriteFile(path, []byte("sync_coordinator = \n"), 0o600); err != nil {
					return err
				}
				testStore.ResetCache()
				return conn.WriteJSON(frame)
			})
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			_, _, readErr := conn.ReadMessage()
			_ = conn.Close()
			select {
			case <-handlerDone:
			case <-time.After(2 * time.Second):
				t.Fatal("peer handler did not finish")
			}
			if !ponged || readErr == nil {
				t.Fatal("authority failure did not close the stream after the read barrier")
			}
			app.syncMu.RLock()
			owners, subs, batches := app.syncTopics.statsLocked()
			app.syncMu.RUnlock()
			cohort := app.peerRegistry().byPeer["f1"]
			if owners != 1 || subs != 1 || batches != 1 || cohort.lastControl != 1 || cohort.retired || cohort.ready {
				t.Fatalf("unavailable authority changed retained work: owners=%d subs=%d batches=%d control=%d retired=%v ready=%v", owners, subs, batches, cohort.lastControl, cohort.retired, cohort.ready)
			}
		})
	}
}
