package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestSyncTopicSingleRowResponseRetainsItsSelectedSnapshot(t *testing.T) {
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
	created := time.Unix(1400, 0)
	app.syncStore["alerts"] = &SyncMessage{Key: "alerts", Value: "first", CreatedAt: created, UpdatedAt: created}
	selected, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	writer := &syncTopicSnapshotWriter{ResponseRecorder: httptest.NewRecorder(), selected: selected, release: release}
	go func() {
		defer close(done)
		app.handleSyncMessages(writer, httptest.NewRequest(http.MethodGet, "/api/sync/messages/alerts", nil))
	}()
	<-selected // GET selected its row and released the board lock.
	posted := httptest.NewRecorder()
	app.handleSyncMessages(posted, httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(`{"key":"alerts","value":"second"}`)))
	close(release)
	<-done
	if posted.Code != http.StatusOK {
		t.Fatalf("POST status = %d", posted.Code)
	}
	var result SyncMessage
	if err := json.Unmarshal(writer.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Value != "first" || !result.CreatedAt.Equal(created) || !result.UpdatedAt.Equal(created) {
		t.Fatal("concurrent POST changed a row already selected for a response")
	}
	if next := app.syncStore["alerts"]; next.Value != "second" || !next.CreatedAt.Equal(created) || !next.UpdatedAt.After(created) {
		t.Fatal("POST did not preserve creation time while replacing the row")
	}
}
