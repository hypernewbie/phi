package phic

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBoardServer is an in-memory board mirroring the server's REST shape.
type syncBoardServer struct {
	mu   sync.Mutex
	rows map[string]SyncMessage
}

func newSyncBoardServer() *syncBoardServer {
	return &syncBoardServer{rows: map[string]SyncMessage{
		"build-status": {Key: "build-status", Value: "green", CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"},
		"agent/aeQ":    {Key: "agent/aeQ", Value: "idle after test run\nlogs clean", CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"},
	}}
}

func (s *syncBoardServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/sync/messages"), "/")
		switch r.Method {
		case http.MethodGet:
			s.mu.Lock()
			defer s.mu.Unlock()
			if key == "" {
				_ = json.NewEncoder(w).Encode(mapValues(s.rows))
				return
			}
			msg, ok := s.rows[key]
			if !ok {
				http.Error(w, "Message not found", http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(msg)
		case http.MethodPost:
			var req struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Key) == "" {
				http.Error(w, "Key is required", http.StatusBadRequest)
				return
			}
			s.mu.Lock()
			s.rows[req.Key] = SyncMessage{Key: req.Key, Value: req.Value}
			s.mu.Unlock()
			fmt.Fprint(w, `{}`)
		case http.MethodDelete:
			s.mu.Lock()
			delete(s.rows, key)
			s.mu.Unlock()
			fmt.Fprint(w, `{}`)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
	})
}

func mapValues(m map[string]SyncMessage) []SyncMessage {
	out := make([]SyncMessage, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

func TestSyncAPIListSortsAndPreviews(t *testing.T) {
	srv := httptest.NewServer(newSyncBoardServer().handler())
	defer srv.Close()
	api, err := newAPIClient(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	list, err := api.SyncMessages(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Key != "agent/aeQ" || list[1].Key != "build-status" {
		t.Fatalf("list not key-sorted: %+v", list)
	}
	row := syncPreview(list[1], 40)
	if row != "build-status — green" {
		t.Fatalf("preview = %q", row)
	}
	multiline := syncPreview(list[0], 40)
	if !strings.Contains(multiline, "␤") {
		t.Fatalf("multiline preview lost the newline marker: %q", multiline)
	}
	long := syncPreview(SyncMessage{Key: "k", Value: strings.Repeat("x", 80)}, 20)
	if !strings.HasSuffix(long, "…") || strings.Count(long, "x") != 20 {
		t.Fatalf("long preview not truncated: %q", long)
	}
}

func TestSyncAPIUpsertAndDelete(t *testing.T) {
	board := newSyncBoardServer()
	srv := httptest.NewServer(board.handler())
	defer srv.Close()
	api, err := newAPIClient(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	if err := api.SyncUpsert(ctx, "note", "hello board"); err != nil {
		t.Fatal(err)
	}
	board.mu.Lock()
	got := board.rows["note"]
	board.mu.Unlock()
	if got.Value != "hello board" {
		t.Fatalf("upsert = %+v", got)
	}
	if err := api.SyncUpsert(ctx, "build-status", "red"); err != nil {
		t.Fatal(err)
	}
	list, _ := api.SyncMessages(ctx)
	if len(list) != 3 {
		t.Fatalf("upsert grew the board wrong: %d", len(list))
	}

	if err := api.SyncDelete(ctx, "note"); err != nil {
		t.Fatal(err)
	}
	board.mu.Lock()
	_, exists := board.rows["note"]
	board.mu.Unlock()
	if exists {
		t.Fatal("delete left the row")
	}
	// Deleting a missing key is a no-op success, like the server.
	if err := api.SyncDelete(ctx, "gone"); err != nil {
		t.Fatalf("missing delete errored: %v", err)
	}
}
