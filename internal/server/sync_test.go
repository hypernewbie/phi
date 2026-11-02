package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncMessagesCRUD(t *testing.T) {
	t.Cleanup(testServer.setSyncPathForTest(filepath.Join(t.TempDir(), "syncboard-test.json")))

	testServer.syncMu.Lock()
	testServer.syncStore = make(map[string]*SyncMessage)
	testServer.syncMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/sync/messages", nil)
	w := httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/sync/messages failed: status %d", w.Code)
	}
	var list []SyncMessage
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("failed to decode list: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected 0 messages, got %d", len(list))
	}

	payload, _ := json.Marshal(map[string]string{"key": "alpha", "value": "hello"})
	req = httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(string(payload)))
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /api/sync/messages failed: status %d", w.Code)
	}
	var created SyncMessage
	json.NewDecoder(w.Body).Decode(&created)
	if created.Key != "alpha" || created.Value != "hello" {
		t.Errorf("unexpected created message: %+v", created)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/alpha", nil)
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/sync/messages/alpha failed: status %d", w.Code)
	}
	var fetched SyncMessage
	json.NewDecoder(w.Body).Decode(&fetched)
	if fetched.Key != "alpha" || fetched.Value != "hello" {
		t.Errorf("unexpected fetched message: %+v", fetched)
	}

	payload, _ = json.Marshal(map[string]string{"key": "alpha", "value": "updated"})
	req = httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(string(payload)))
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /api/sync/messages upsert failed: status %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/alpha", nil)
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	json.NewDecoder(w.Body).Decode(&fetched)
	if fetched.Value != "updated" {
		t.Errorf("expected value 'updated', got %q", fetched.Value)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/nonexistent", nil)
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/sync/messages/alpha", nil)
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE /api/sync/messages/alpha failed: status %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/alpha", nil)
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404 after delete, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/sync/messages/nonexistent", nil)
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404 on delete nonexistent, got %d", w.Code)
	}

	// Rich action JSON payload support: value sent as raw JSON object
	richPayload := `{"key":"rich-card","value":{"title":"Mockup","preview":"img.png","auto_open":true}}`
	req = httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(richPayload))
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /api/sync/messages with raw JSON object failed: status %d", w.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/rich-card", nil)
	w = httptest.NewRecorder()
	testServer.handleSyncMessages(w, req)
	var richFetched SyncMessage
	json.NewDecoder(w.Body).Decode(&richFetched)
	if !strings.Contains(richFetched.Value, `"title":"Mockup"`) {
		t.Errorf("expected rich value to preserve JSON object, got %q", richFetched.Value)
	}
}
