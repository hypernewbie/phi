package phic

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func wsUpgrader() websocket.Upgrader { return websocket.Upgrader{} }

func attachHeadFrame(epoch, head uint64) []byte {
	return wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: epoch, Head: head}, nil)
}

func liveFrame(start uint64, data []byte) []byte {
	return wireproto.EncodeLiveOutputFrame(start, data)
}

func timeAfter() <-chan time.Time { return time.After(5 * time.Second) }

// newModelWithServer builds a ready model pointed at one fake server with a
// shell coder, a workspace, and one live pane.
func newModelWithServer(t *testing.T, srv *httptest.Server) *tuiModel {
	t.Helper()
	m := newTUIModel("test", config{}, nil, []*serverState{{
		profile: desktopProfile{ID: "s1", Name: "fake", Origin: srv.URL},
		api:     mustAPI(t, srv.URL),
	}}, 0, stubBuild)
	m.width, m.height = 100, 30
	m.data[0] = &serverData{
		loaded:   true,
		identity: serverIdentity{Workspaces: []string{"/work"}},
		coders:   []CoderDescriptor{{ID: "shell", Name: "Shell", IsShell: true}, {ID: "opencode", Name: "OpenCode"}},
		panes:    []TerminalView{{ID: "p", Coder: "shell", Dir: "/work", Title: "shell"}},
	}
	m.project = "/work"
	return m
}

// attachPaneForTest attaches the pane tab through the model and returns it.
func attachPaneForTest(t *testing.T, m *tuiModel) *paneTab {
	t.Helper()
	tab := m.ensureTab(0, m.currentOrigin(), "p", spawnCapture{origin: m.currentOrigin(), index: 0, project: "/work", coder: "shell"})
	m.tabs[0] = []*paneTab{tab}
	m.activateTab(0, tab)
	if tab.actor == nil {
		t.Fatal("tab did not attach")
	}
	return tab
}

// TestTUIKeyRoutingTerminalVersusChrome proves backend focus receives
// ordinary keys while the application prefix never reaches the backend.
func TestTUIKeyRoutingTerminalVersusChrome(t *testing.T) {
	up := wsUpgrader()
	inputs := make(chan string, 32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/pane/p" {
			http.NotFound(w, r)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteMessage(websocket.BinaryMessage, attachHeadFrame(7, 0))
		_ = ws.WriteMessage(websocket.BinaryMessage, liveFrame(0, []byte("ready")))
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if len(msg) > 0 && msg[0] == 1 {
				inputs <- string(msg[1:])
			}
		}
	}))
	defer srv.Close()

	m := newModelWithServer(t, srv)
	attachPaneForTest(t, m)

	// Terminal focus: a printable key reaches the backend.
	m.Update(tea.KeyPressMsg(tea.Key{Code: 'x', Text: "x"}))
	select {
	case got := <-inputs:
		if got != "x" {
			t.Fatalf("terminal key = %q, want %q", got, "x")
		}
	case <-timeAfter():
		t.Fatal("terminal key did not reach the backend")
	}

	// The application prefix is consumed by chrome, not forwarded.
	m.Update(tea.KeyPressMsg(tea.Key{Code: ']', Mod: tea.ModCtrl}))
	if !m.prefix {
		t.Fatal("prefix not armed")
	}
	m.Update(tea.KeyPressMsg(tea.Key{Code: 'd'}))
	if m.prefix || !m.diff.open {
		t.Fatalf("prefix key did not toggle diff (prefix=%v open=%v)", m.prefix, m.diff.open)
	}
	select {
	case got := <-inputs:
		t.Fatalf("chrome key leaked to backend: %q", got)
	default:
	}

	// A modal captures input; the pane stays attached and still renders.
	m.openHelp()
	m.Update(tea.KeyPressMsg(tea.Key{Code: 'x', Text: "x"}))
	if m.modal.kind != modalNone {
		t.Fatal("help modal did not close on key")
	}
	if _, ok := m.activeTabModel().actor.snapshotCopy(); !ok {
		t.Fatal("pane frame lost while modal was open")
	}
	select {
	case got := <-inputs:
		t.Fatalf("modal key leaked to backend: %q", got)
	default:
	}

	// Focus returns to the terminal and input flows again.
	m.focus = focusTerminal
	m.Update(tea.KeyPressMsg(tea.Key{Code: 'y', Text: "y"}))
	select {
	case got := <-inputs:
		if got != "y" {
			t.Fatalf("post-modal key = %q, want %q", got, "y")
		}
	case <-timeAfter():
		t.Fatal("post-modal key did not reach the backend")
	}
}

// TestTUISpawnCaptureEmptyResumeIdentity asserts New Session sends exactly one
// fresh spawn request with the captured context and no resume identity.
func TestTUISpawnCaptureEmptyResumeIdentity(t *testing.T) {
	type captured struct {
		body map[string]any
	}
	got := make(chan captured, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/terminals" && r.Method == http.MethodPost:
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			got <- captured{body: body}
			_, _ = w.Write([]byte(`{"pane_id":"new1","session_id":"fresh"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	m := newModelWithServer(t, srv)
	m.worktree = "/work/wt"
	cmd := m.spawnForCoder("shell", false, "")
	if cmd == nil {
		t.Fatal("spawn command missing")
	}
	msg, ok := cmd().(spawnDoneMsg)
	if !ok || msg.err != "" {
		t.Fatalf("spawn failed: %+v", msg)
	}
	select {
	case c := <-got:
		if c.body["cwd"] != "/work" || c.body["workspace"] != "/work/wt" || c.body["coder"] != "shell" {
			t.Fatalf("captured context = %v", c.body)
		}
		if _, present := c.body["session_id"]; present {
			t.Fatalf("fresh spawn carried a resume identity: %v", c.body["session_id"])
		}
		cols, _ := c.body["cols"].(float64)
		rows, _ := c.body["rows"].(float64)
		if cols <= 0 || rows <= 0 {
			t.Fatalf("spawn geometry not captured: cols=%v rows=%v", c.body["cols"], c.body["rows"])
		}
	default:
		t.Fatal("no spawn request arrived")
	}
}

// TestTUIResumeUsesExactSessionIdentity asserts a saved row resumes by its
// exact identity, preferring session_path when the adapter requires it.
func TestTUIResumeUsesExactSessionIdentity(t *testing.T) {
	got := make(chan map[string]any, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/terminals" && r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			got <- body
			_, _ = w.Write([]byte(`{"pane_id":"res1","session_id":"sid"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	m := newModelWithServer(t, srv)
	if cmd := m.resumeSession(Session{ID: "sid", SessionPath: "/sessions/one", Coder: "opencode"}); cmd == nil {
		t.Fatal("resume command missing")
	} else {
		_ = cmd()
	}
	select {
	case body := <-got:
		if body["session_id"] != "/sessions/one" || body["coder"] != "opencode" {
			t.Fatalf("resume identity = %v", body)
		}
	default:
		t.Fatal("no resume request arrived")
	}

	// A session without a path uses its ID. Clear the pending-spawn guard the
	// first capture left behind, exactly as applying its result would.
	m.pendingSpawn[0] = false
	if cmd := m.resumeSession(Session{ID: "plain", Coder: "opencode"}); cmd != nil {
		_ = cmd()
	}
	select {
	case body := <-got:
		if body["session_id"] != "plain" {
			t.Fatalf("resume identity = %v", body)
		}
	default:
		t.Fatal("no second resume request arrived")
	}
}

// TestTUIStaleResultsCannotChangeContext proves late results for another
// generation, server, coder, or project are ignored.
func TestTUIStaleResultsCannotChangeContext(t *testing.T) {
	m := newModelWithServer(t, httptest.NewServer(http.NotFoundHandler()))
	m.gen = 5
	m.data[0].sessionsCoder = "shell"
	m.data[0].sessionsDir = "/work"
	m.data[0].sessions = []Session{{ID: "keep"}}

	m.Update(serverLoadedMsg{gen: 4, index: 0, coders: []CoderDescriptor{{ID: "evil"}}})
	if m.data[0].coders[0].ID != "shell" {
		t.Fatal("stale server result changed the coder list")
	}
	m.Update(sessionsLoadedMsg{gen: 5, index: 0, coder: "other", dir: "/work", items: []Session{{ID: "evil"}}})
	if len(m.data[0].sessions) != 1 || m.data[0].sessions[0].ID != "keep" {
		t.Fatal("stale sessions result changed the sidebar")
	}
	m.Update(sessionsLoadedMsg{gen: 5, index: 0, coder: "shell", dir: "/elsewhere", items: []Session{{ID: "evil"}}})
	if m.data[0].sessions[0].ID != "keep" {
		t.Fatal("wrong-project sessions result changed the sidebar")
	}
}

// TestTUIViewRendersEmbeddedFrame proves the rendered screen embeds copied
// pane content instead of passing backend bytes through.
func TestTUIViewRendersEmbeddedFrame(t *testing.T) {
	up := wsUpgrader()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/pane/p" {
			http.NotFound(w, r)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteMessage(websocket.BinaryMessage, attachHeadFrame(7, 0))
		_ = ws.WriteMessage(websocket.BinaryMessage, liveFrame(0, []byte("framed content")))
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	m := newModelWithServer(t, srv)
	tab := attachPaneForTest(t, m)
	waitFor(t, "rendered pane frame", func() bool {
		frame, ok := tab.actor.snapshotCopy()
		return ok && strings.Contains(frameText(frame), "framed content")
	})
	screen := m.render()
	if !strings.Contains(screen, "framed content") {
		t.Fatalf("rendered screen does not embed pane content:\n%s", screen)
	}
	if !strings.Contains(screen, "TERMINALS") || !strings.Contains(screen, "SESSIONS") {
		t.Fatal("persistent chrome missing from render")
	}
}

// TestTUICloseIsSoftThenFinal asserts x schedules Undo and X sends exactly one
// DELETE to the captured origin.
func TestTUICloseIsSoftThenFinal(t *testing.T) {
	var deletes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/terminals/") {
			deletes++
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	m := newModelWithServer(t, srv)
	tab := attachPaneForTest(t, m)

	cmd := m.closeTab(tab, false)
	if cmd == nil || !tab.closing {
		t.Fatal("soft close did not arm Undo")
	}
	if deletes != 0 {
		t.Fatal("soft close sent DELETE")
	}
	m.undoClose(tab)
	if tab.closing {
		t.Fatal("undo did not restore the tab")
	}

	_ = m.closeTab(tab, false)
	if !tab.closing {
		t.Fatal("second soft close did not arm Undo")
	}
	cmd = m.closeTab(tab, false) // closing again is the final close
	msg, ok := cmd().(deleteDoneMsg)
	if !ok || msg.err != "" {
		t.Fatalf("final close failed: %+v", msg)
	}
	if deletes != 1 {
		t.Fatalf("final close DELETE count = %d, want 1", deletes)
	}
}

// TestTUIIntentRoundTrip persists and restores tab order, active tab, and
// panel state without touching secrets.
func TestTUIIntentRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := &desktopStore{path: dir + "/profiles.json"}
	m := newTUIModel("test", config{}, store, []*serverState{{profile: desktopProfile{ID: "s1", Name: "fake", Origin: "http://localhost:1"}}}, 0, stubBuild)
	m.width, m.height = 100, 30
	m.tabs[0] = []*paneTab{
		{key: paneKey{Origin: "http://localhost:1", ID: "a"}, title: "A"},
		{key: paneKey{Origin: "http://localhost:1", ID: "b"}, title: "B"},
	}
	m.activeTab[0] = 1
	m.project = "/work"
	m.worktree = "/work/wt"
	m.diff.open = true
	if cmd := m.persistIntent(); cmd != nil {
		_ = cmd()
	}

	restored := newTUIModel("test", config{}, store, []*serverState{{profile: desktopProfile{ID: "s1", Name: "fake", Origin: "http://localhost:1"}}}, 0, stubBuild)
	restored.tabs[0] = []*paneTab{
		{key: paneKey{Origin: "http://localhost:1", ID: "b"}, title: "B"},
		{key: paneKey{Origin: "http://localhost:1", ID: "a"}, title: "A"},
	}
	restored.restoreIntent()
	if !restored.diff.open {
		t.Fatal("diff panel state not restored")
	}
	if restored.tabs[0][0].key.ID != "a" || restored.tabs[0][1].key.ID != "b" {
		t.Fatalf("tab order not restored: %v", restored.tabs[0])
	}
	if restored.activeTab[0] != 1 {
		t.Fatalf("active tab = %d, want 1", restored.activeTab[0])
	}
	ui, err := store.readUI()
	if err != nil {
		t.Fatal(err)
	}
	intent := ui.Servers["s1"]
	if intent.Project != "/work" || intent.Worktree != "/work/wt" || !intent.DiffOpen || intent.Active != "b" {
		t.Fatalf("persisted intent = %+v", intent)
	}
}
