package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

type syncTopicSnapshotWriter struct {
	*httptest.ResponseRecorder
	selected chan struct{}
	release  <-chan struct{}
}

func (w *syncTopicSnapshotWriter) Header() http.Header {
	close(w.selected)
	<-w.release
	return w.ResponseRecorder.Header()
}

func TestSyncTopicResponseRetainsItsSelectedSnapshot(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		paths := []string{"/api/sync/messages"}
		if method == http.MethodGet {
			paths = append(paths, "/api/sync/messages/alerts")
		}
		for _, path := range paths {
			for _, mutation := range []string{http.MethodPost, http.MethodDelete} {
				t.Run(method+path+"/during-"+mutation, func(t *testing.T) {
					withTempConfig(t)
					app := testServer
					app.setSyncPathForTest(filepath.Join(t.TempDir(), "syncboard.json"))
					defer func() { _ = app.flushSyncStore() }()
					created := time.Unix(1400, 0)
					original := SyncMessage{Key: "alerts", Value: "first", CreatedAt: created, UpdatedAt: created}
					app.syncStore["alerts"] = &original
					selected, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
					writer := &syncTopicSnapshotWriter{ResponseRecorder: httptest.NewRecorder(), selected: selected, release: release}
					go func() {
						defer close(done)
						app.handleSyncMessages(writer, httptest.NewRequest(method, path, strings.NewReader(`{"key":"alerts","value":"selected"}`)))
					}()
					<-selected // Selection/commit finished and released the board lock.
					wanted := *app.syncStore["alerts"]
					changed := httptest.NewRecorder()
					mutationPath := "/api/sync/messages"
					if mutation == http.MethodDelete {
						mutationPath += "/alerts"
					}
					app.handleSyncMessages(changed, httptest.NewRequest(mutation, mutationPath, strings.NewReader(`{"key":"alerts","value":"second"}`)))
					close(release)
					<-done
					if writer.Code != http.StatusOK || changed.Code != http.StatusOK {
						t.Fatalf("selected/mutation status = %d/%d", writer.Code, changed.Code)
					}
					var result SyncMessage
					if method == http.MethodGet && path == "/api/sync/messages" {
						var rows []SyncMessage
						if err := json.Unmarshal(writer.Body.Bytes(), &rows); err != nil || len(rows) != 1 {
							t.Fatalf("list snapshot = %s, %v", writer.Body.Bytes(), err)
						}
						result = rows[0]
					} else if err := json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
						t.Fatal(err)
					}
					if result.Key != wanted.Key || result.Value != wanted.Value || !result.CreatedAt.Equal(wanted.CreatedAt) || !result.UpdatedAt.Equal(wanted.UpdatedAt) {
						t.Fatalf("response changed after selection: got %+v, want %+v", result, wanted)
					}
					if original.Value != "first" || !original.UpdatedAt.Equal(created) || !result.CreatedAt.Equal(created) {
						t.Fatal("POST changed a published row or its creation time")
					}
					if mutation == http.MethodDelete {
						if app.syncStore["alerts"] != nil {
							t.Fatal("DELETE did not remove the current row")
						}
					} else if next := app.syncStore["alerts"]; next.Value != "second" || !next.CreatedAt.Equal(created) || !next.UpdatedAt.After(wanted.UpdatedAt) {
						t.Fatal("POST did not replace the row and advance its update time")
					}
				})
			}
		}
	}
}

func TestSyncTopicRefusalPreservesPublishedState(t *testing.T) {
	for _, scenario := range []string{"invalid", "request-too-large", "encoded-too-large-no-subscribers", "capacity-new-row", "capacity-existing-row"} {
		t.Run(scenario, func(t *testing.T) {
			withTempConfig(t)
			app := testServer
			app.setSyncPathForTest(filepath.Join(t.TempDir(), "syncboard.json"))
			defer func() { _ = app.flushSyncStore() }()
			app.hub = ws.NewHub(0)
			defer app.hub.Close()
			listener := &ws.Client{Send: make(chan []byte, 2)}
			app.hub.Register(ws.EventsPaneID, listener)
			defer app.hub.Unregister(ws.EventsPaneID, listener)
			created := time.Unix(1500, 0)
			original := &SyncMessage{Key: "alerts", Value: "committed", CreatedAt: created, UpdatedAt: created}
			app.syncStore["alerts"] = original
			body := `{"key":"alerts","value":"refused"}`
			status, reason := http.StatusBadRequest, "invalid"
			switch scenario {
			case "invalid":
				body += " {}"
			case "request-too-large":
				body = `{"key":"alerts","value":"` + strings.Repeat("x", maxSyncTopicPostBytes) + `"}`
				status, reason = http.StatusRequestEntityTooLarge, "too-large"
			case "encoded-too-large-no-subscribers":
				body = `{"key":"alerts","value":"` + strings.Repeat("x", maxSyncTopicBatchTextBytes) + `"}`
				status, reason = http.StatusRequestEntityTooLarge, "too-large"
			default:
				status, reason = http.StatusServiceUnavailable, "capacity"
				key := "alerts"
				if scenario == "capacity-new-row" {
					key = "new"
					body = `{"key":"new","value":"refused"}`
				}
				full, other := topicOwner("full"), topicOwner("other")
				for i := 0; i < maxSyncTopicBatchesPerOwner; i++ {
					topic := "full-" + strconv.Itoa(i)
					if i == 0 {
						topic = key
					}
					if err := app.syncTopics.subscribeLocked(full, topic); err != nil {
						t.Fatal(err)
					}
					if _, err := app.syncTopics.admitPostLocked(topic, "pending", created); err != nil {
						t.Fatal(err)
					}
				}
				if err := app.syncTopics.subscribeLocked(other, key); err != nil {
					t.Fatal(err)
				}
				app.syncTopics.pumpLocked(created.Add(syncTopicBatchWindow))
			}
			pending := func() map[string][]string {
				rows := make(map[string][]string)
				for key, owner := range app.syncTopics.owners {
					rows[key] = nil
					for _, batch := range owner.batches {
						rows[key] = append(rows[key], string(batch.text))
					}
				}
				return rows
			}
			before := pending()
			beforePost, beforeBatch, beforeCount := app.syncTopics.nextPost, app.syncTopics.nextBatch, app.syncTopics.totalBatches
			if err := app.flushSyncStore(); err != nil {
				t.Fatal(err)
			}
			stored, err := os.ReadFile(app.syncFilePath())
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			app.handleSyncMessages(response, httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(body)))
			if response.Code != status || response.Body.String() != `{"syncboard_admission":"refused","reason":"`+reason+`"}` {
				t.Fatalf("refusal = %d %.160s", response.Code, response.Body.String())
			}
			if len(app.syncStore) != 1 || app.syncStore["alerts"] != original || original.Value != "committed" || !original.UpdatedAt.Equal(created) {
				t.Fatal("refusal changed the committed row or timestamps")
			}
			if !reflect.DeepEqual(before, pending()) || app.syncTopics.nextPost != beforePost || app.syncTopics.nextBatch != beforeBatch || app.syncTopics.totalBatches != beforeCount {
				t.Fatal("refusal changed recipient contents, counters, or reservations")
			}
			if app.saveTimer != nil {
				t.Fatal("refusal scheduled persistence")
			}
			if err := app.flushSyncStore(); err != nil {
				t.Fatal(err)
			}
			after, err := os.ReadFile(app.syncFilePath())
			if err != nil || !bytes.Equal(stored, after) {
				t.Fatalf("refusal changed persisted state: %v", err)
			}
			select {
			case <-listener.Send:
				t.Fatal("refusal emitted a browser notification")
			default:
			}
			accepted := httptest.NewRecorder()
			app.handleSyncMessages(accepted, httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(`{"key":"unrelated","value":"accepted"}`)))
			if accepted.Code != http.StatusOK {
				t.Fatalf("unrelated POST = %d", accepted.Code)
			}
			select {
			case frame := <-listener.Send:
				notification, err := wireproto.DecodeNotification(frame)
				if err != nil || notification.GetSyncChanged().GetKey() != "unrelated" || notification.GetSyncChanged().GetMsg().GetValue() != "accepted" {
					t.Fatalf("accepted notification = %v, %v", notification, err)
				}
			default:
				t.Fatal("notification observer did not receive the accepted POST")
			}
		})
	}
}
