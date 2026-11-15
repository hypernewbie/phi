package phic

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/gorilla/websocket"
)

// recallServer serves the compose pane socket and /api/pi-history.
func recallServer(t *testing.T, entries string, unavailable bool, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	up := websocket.Upgrader{Subprotocols: []string{"terminal"}}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ws/pane/p":
			ws, err := up.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			_ = ws.WriteMessage(websocket.BinaryMessage, attachHeadFrame(7, 0))
			for {
				if _, _, err := ws.ReadMessage(); err != nil {
					return
				}
			}
		case "/api/pi-history":
			if r.URL.Query().Get("pane") != "p" {
				http.Error(w, "bad pane", http.StatusBadRequest)
				return
			}
			hits.Add(1)
			fmt.Fprintf(w, `{"entries":%s,"unavailable":%v}`, entries, unavailable)
		default:
			http.NotFound(w, r)
		}
	}))
}

func recallModel(t *testing.T, srv *httptest.Server) *tuiModel {
	t.Helper()
	m := newModelWithServer(t, srv)
	tab := m.ensureTab(m.currentOrigin(), "p", spawnCapture{origin: m.currentOrigin(), index: 0, project: "/work", coder: "pi"})
	tab.actor = &paneActor{ctx: t.Context(), conn: &websocket.Conn{}, inbox: make(chan paneInput, 4)}
	m.tabs[m.currentOrigin()] = []*paneTab{tab}
	m.activateTab(m.currentOrigin(), tab)
	return m
}

// driveRecall presses Up and runs the returned commands until quiet.
func driveRecall(m *tuiModel) {
	model, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	for i := 0; cmd != nil && i < 4; i++ {
		model, cmd = model.Update(cmd())
	}
}

// TestComposeRecallCyclesPiHistory pins the web composer semantics: Up from
// an empty box fetches once and walks newest-first, Down walks back, and
// past the newest restores the saved draft.
func TestComposeRecallCyclesPiHistory(t *testing.T) {
	var hits atomic.Int32
	srv := recallServer(t, `["first prompt","second prompt"]`, false, &hits)
	defer srv.Close()
	m := recallModel(t, srv)

	m.Update(m.openCompose())
	if !m.compose.open || m.compose.recall.cursor != -1 {
		t.Fatalf("compose did not open cleanly: %+v", m.compose.recall)
	}

	// First Up: fetch and land on the newest entry.
	driveRecall(m)
	if got := hits.Load(); got != 1 {
		t.Fatalf("history fetches = %d, want 1", got)
	}
	if v := m.compose.area.Value(); v != "first prompt" {
		t.Fatalf("newest entry = %q", v)
	}

	// Second Up: one step older. No refetch.
	driveRecall(m)
	if got := hits.Load(); got != 1 {
		t.Fatalf("cycling refetched: %d", got)
	}
	if v := m.compose.area.Value(); v != "second prompt" {
		t.Fatalf("older entry = %q", v)
	}

	// Third Up at the oldest: stays.
	driveRecall(m)
	if v := m.compose.area.Value(); v != "second prompt" {
		t.Fatalf("past oldest = %q", v)
	}

	// Down: back to newest; Down again: restore the draft.
	m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	if v := m.compose.area.Value(); v != "first prompt" {
		t.Fatalf("newer entry = %q", v)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	if v := m.compose.area.Value(); v != "" {
		t.Fatalf("draft restore = %q", v)
	}

	// Typing after recall resets the cycle; Up from a non-empty box is a
	// normal cursor move, not a recall.
	m.Update(tea.KeyPressMsg{Code: 'z', Text: "z"})
	if m.compose.recall.cursor != -1 {
		t.Fatal("edit did not reset the recall cursor")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	if v := m.compose.area.Value(); v != "z" {
		t.Fatalf("Up on non-empty draft changed the value: %q", v)
	}
}

// TestComposeRecallDraftIsRestored pins that a saved mid-recall draft wins
// over the empty-box fetch replay guard.
func TestComposeRecallDraftIsRestored(t *testing.T) {
	var hits atomic.Int32
	srv := recallServer(t, `["only"]`, false, &hits)
	defer srv.Close()
	m := recallModel(t, srv)
	m.Update(m.openCompose())

	// Open with a draft, clear it, recall, then Down past the newest.
	tab := m.findTab(m.compose.tab)
	tab.composeDraft = ""
	m.compose.area.SetValue("")
	driveRecall(m) // newest
	if v := m.compose.area.Value(); v != "only" {
		t.Fatalf("entry = %q", v)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	if v := m.compose.area.Value(); v != "" {
		t.Fatalf("draft = %q", v)
	}
}

// TestComposeRecallUnavailableKeepsDraft pins the degraded path: an
// unavailable Pi history leaves the box exactly as it was.
func TestComposeRecallUnavailableKeepsDraft(t *testing.T) {
	var hits atomic.Int32
	srv := recallServer(t, `[]`, true, &hits)
	defer srv.Close()
	m := recallModel(t, srv)
	m.Update(m.openCompose())
	driveRecall(m)
	if v := m.compose.area.Value(); v != "" {
		t.Fatalf("unavailable history changed the box: %q", v)
	}
	if m.compose.recall.entries != nil {
		t.Fatal("unavailable history was cached")
	}
	// A second Up refetches nothing new but stays harmless.
	m.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	if v := m.compose.area.Value(); v != "" {
		t.Fatalf("second Up broke the box: %q", v)
	}
}

// TestComposeRecallNonPiPaneDoesNotFetch pins the eligibility guard.
func TestComposeRecallNonPiPaneDoesNotFetch(t *testing.T) {
	var hits atomic.Int32
	srv := recallServer(t, `["x"]`, false, &hits)
	defer srv.Close()
	m := recallModel(t, srv)
	tab := m.activeTabModel()
	tab.coder = "shell"
	tab.view.Coder = "shell"
	m.Update(m.openCompose())
	driveRecall(m)
	if got := hits.Load(); got != 0 {
		t.Fatalf("shell pane fetched Pi history: %d", got)
	}
	if v := m.compose.area.Value(); v != "" {
		t.Fatalf("shell pane box changed: %q", v)
	}
}

// TestComposeRecallStaleReplyDropped pins the pane/generation guards: a
// reply for a closed or moved compose box changes nothing.
func TestComposeRecallStaleReplyDropped(t *testing.T) {
	var hits atomic.Int32
	srv := recallServer(t, `["x"]`, false, &hits)
	defer srv.Close()
	m := recallModel(t, srv)
	m.Update(m.openCompose())

	// Start the fetch but close the box before the reply lands.
	cmd := m.fetchRecallCmd()
	if cmd == nil {
		t.Fatal("no fetch command")
	}
	m.closeCompose()
	m.Update(cmd())
	tab := m.findTab(paneKey{Origin: m.currentOrigin(), ID: "p"})
	_ = tab
	if m.compose.open {
		t.Fatal("compose did not close")
	}

	// Reopen: the dropped reply did not poison the new session.
	m.Update(m.openCompose())
	if len(m.compose.recall.entries) != 0 {
		t.Fatal("stale reply leaked into the new compose session")
	}
	driveRecall(m)
	if v := m.compose.area.Value(); v != "x" {
		t.Fatalf("fresh recall after stale reply = %q", v)
	}
	if !strings.Contains(m.compose.area.Value(), "x") {
		t.Fatal("recall broken")
	}
}
