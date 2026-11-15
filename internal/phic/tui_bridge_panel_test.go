package phic

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/gorilla/websocket"
)

// bridgePanelServer serves the pane socket (attach only) plus every Pi
// bridge endpoint, recording mutating calls.
type bridgePanelServer struct {
	mu       sync.Mutex
	posts    []string
	bodies   []string
	setModel string
	setThink string
	invoke   string
	compactS int
	compactB string
	reloadS  int
	reloadB  string
}

func newBridgePanelServer() *bridgePanelServer {
	return &bridgePanelServer{
		setModel: `{"ok":true}`,
		setThink: `{"ok":true}`,
		invoke:   `{"ok":true}`,
		compactS: http.StatusOK,
		compactB: `{"outcome":"completed"}`,
		reloadS:  http.StatusAccepted,
		reloadB:  `{"outcome":"dispatched"}`,
	}
}

func (b *bridgePanelServer) handler() http.Handler {
	up := websocket.Upgrader{Subprotocols: []string{"terminal"}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		case "/api/pi-bridge/models":
			fmt.Fprint(w, `{"models":[{"provider":"anthropic","id":"claude-sonnet-4-5"},{"provider":"openai","id":"gpt-5.2"}],"truncated":false,"unavailable":false}`)
		case "/api/pi-bridge/thinking-levels":
			fmt.Fprint(w, `{"levels":["off","medium","high"],"provider":"anthropic","model":"claude-sonnet-4-5","process_id":"pi-9","generation":"4","unavailable":false}`)
		case "/api/pi-bridge/skills":
			fmt.Fprint(w, `{"skills":[{"name":"update_ae","description":"pull and rebuild"},{"name":"vik","description":"tasks"}],"truncated":false,"unavailable":false,"process_id":"pi-9","generation":"4"}`)
		case "/api/pi-bridge/model", "/api/pi-bridge/thinking", "/api/pi-bridge/skill",
			"/api/pi-bridge/compact", "/api/pi-bridge/reload":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			raw, _ := json.Marshal(body)
			b.mu.Lock()
			b.posts = append(b.posts, r.URL.Path)
			b.bodies = append(b.bodies, string(raw))
			b.mu.Unlock()
			switch r.URL.Path {
			case "/api/pi-bridge/model":
				fmt.Fprint(w, b.setModel)
			case "/api/pi-bridge/thinking":
				fmt.Fprint(w, b.setThink)
			case "/api/pi-bridge/skill":
				fmt.Fprint(w, b.invoke)
			case "/api/pi-bridge/compact":
				w.WriteHeader(b.compactS)
				fmt.Fprint(w, b.compactB)
			case "/api/pi-bridge/reload":
				w.WriteHeader(b.reloadS)
				fmt.Fprint(w, b.reloadB)
			}
		default:
			http.NotFound(w, r)
		}
	})
}

// bridgePanelTestModel builds a console with one attached pi pane.
func bridgePanelTestModel(t *testing.T, srv *httptest.Server) (*tuiModel, *paneTab) {
	t.Helper()
	m := newModelWithServer(t, srv)
	tab := m.ensureTab(m.currentOrigin(), "p", spawnCapture{origin: m.currentOrigin(), index: 0, project: "/work", coder: "pi"})
	tab.actor = &paneActor{ctx: t.Context(), conn: &websocket.Conn{}, inbox: make(chan paneInput, 4)}
	m.tabs[m.currentOrigin()] = []*paneTab{tab}
	m.activateTab(m.currentOrigin(), tab)
	return m, tab
}

// TestBridgePanelOpenLoadAndSwitch pins the open flow: one bounded load of
// all three lists, section switching, and per-section rendering.
func TestBridgePanelOpenLoadAndSwitch(t *testing.T) {
	b := newBridgePanelServer()
	srv := httptest.NewServer(b.handler())
	defer srv.Close()
	m, tab := bridgePanelTestModel(t, srv)

	// Without a live tab the panel refuses.
	m.tabs[m.currentOrigin()] = nil
	m.Update(tea.KeyPressMsg{Code: ']', Mod: tea.ModCtrl})
	m.Update(tea.KeyPressMsg{Code: 'P'})
	if m.modal.kind != modalNone {
		t.Fatal("Pi controls opened without a live terminal")
	}
	if m.status != "no live terminal for Pi controls" {
		t.Fatalf("refusal status = %q", m.status)
	}

	// With the tab: prefix P opens and loads all three lists.
	m.tabs[m.currentOrigin()] = []*paneTab{tab}
	m.Update(tea.KeyPressMsg{Code: ']', Mod: tea.ModCtrl})
	m.Update(tea.KeyPressMsg{Code: 'P'})
	if m.modal.kind != modalBridge || !m.bridge.loading || m.bridge.pane != "p" {
		t.Fatalf("panel did not open: %+v", m.bridge)
	}
	m.Update(m.loadBridgePanel(m.bridge.ticket)())
	if m.bridge.loading || len(m.bridge.models.Models) != 2 || len(m.bridge.thinkingList.Levels) != 3 || len(m.bridge.skillsList.Skills) != 2 {
		t.Fatalf("lists did not load: %+v", m.bridge)
	}
	view := m.renderBridgeModal()
	plain := ansi.Strip(view)
	if !strings.Contains(plain, "Models") || !strings.Contains(plain, "claude-sonnet-4-5") {
		t.Fatalf("models section did not render: %q", plain)
	}

	// Section switch via 2 renders levels; 3 renders skills.
	m.Update(tea.KeyPressMsg{Code: '2'})
	if m.bridge.section != sectionThinking || !strings.Contains(ansi.Strip(m.renderBridgeModal()), "medium") {
		t.Fatalf("thinking section did not render: %q", ansi.Strip(m.renderBridgeModal()))
	}
	m.Update(tea.KeyPressMsg{Code: '3'})
	if m.bridge.section != sectionSkills || !strings.Contains(ansi.Strip(m.renderBridgeModal()), "update_ae") {
		t.Fatalf("skills section did not render: %q", ansi.Strip(m.renderBridgeModal()))
	}

	// Escape closes and returns focus.
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.modal.kind != modalNone || m.focus != focusTerminal {
		t.Fatal("Pi controls did not close on Escape")
	}
}

// TestBridgePanelAppliesSelections pins the Enter path per section: the
// request body carries the row's data and, for thinking and skills, the
// process origin from the list that produced it.
func TestBridgePanelAppliesSelections(t *testing.T) {
	b := newBridgePanelServer()
	srv := httptest.NewServer(b.handler())
	defer srv.Close()
	m, _ := bridgePanelTestModel(t, srv)
	m.modal.open(modalBridge, "Pi controls")
	m.bridge = bridgePanelState{pane: "p"}
	m.Update(m.loadBridgePanel(m.bridge.ticket)())
	driveKey(m, tea.KeyPressMsg{Code: tea.KeyDown}) // cursor 1: gpt-5.2
	driveKey(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	waitFor(t, "model action reply", func() bool { return !m.bridge.busy })
	if b.posts[len(b.posts)-1] != "/api/pi-bridge/model" || !strings.Contains(b.bodies[len(b.bodies)-1], `"gpt-5.2"`) {
		t.Fatalf("model apply = %s %s", b.posts, b.bodies)
	}

	m.Update(tea.KeyPressMsg{Code: '2'})
	driveKey(m, tea.KeyPressMsg{Code: tea.KeyEnter}) // cursor 0: off
	waitFor(t, "thinking action reply", func() bool { return !m.bridge.busy })
	body := b.bodies[len(b.bodies)-1]
	if !strings.Contains(body, `"level":"off"`) || !strings.Contains(body, `"process_id":"pi-9"`) || !strings.Contains(body, `"generation":"4"`) {
		t.Fatalf("thinking apply lost its origin: %s", body)
	}

	m.Update(tea.KeyPressMsg{Code: '3'})
	driveKey(m, tea.KeyPressMsg{Code: tea.KeyDown}) // cursor 1: vik
	driveKey(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	waitFor(t, "skill action reply", func() bool { return !m.bridge.busy })
	body = b.bodies[len(b.bodies)-1]
	if !strings.Contains(body, `"name":"vik"`) || !strings.Contains(body, `"process_id":"pi-9"`) {
		t.Fatalf("skill apply lost its origin: %s", body)
	}
	if m.bridge.notice == "" {
		t.Fatal("applies produced no notice")
	}
}

// TestBridgePanelCompactAndReload pins the guard and the happy path: no
// snapshot refuses locally; a snapshot produces the stamped request.
func TestBridgePanelCompactAndReload(t *testing.T) {
	b := newBridgePanelServer()
	srv := httptest.NewServer(b.handler())
	defer srv.Close()
	m, tab := bridgePanelTestModel(t, srv)
	m.modal.open(modalBridge, "Pi controls")
	m.bridge = bridgePanelState{pane: "p"}

	// No bridge state yet: both actions refuse locally, nothing is sent.
	m.Update(tea.KeyPressMsg{Code: 'c'})
	if b.compactPosted(t) || m.bridge.err == "" {
		t.Fatal("compact without a snapshot reached the server")
	}
	m.Update(tea.KeyPressMsg{Code: 'r'})
	if b.reloadPosted(t) {
		t.Fatal("reload without a snapshot reached the server")
	}

	// Publish a snapshot: compact sends its stamps.
	m.bridge.err = ""
	snap := bridgeSnapshot{
		state: "ready", generation: 5, telemetryRevision: 11, runID: 3,
		contextRevision: 9, processID: "pi-9", model: "m", connected: true,
	}
	tab.bridge = &snap
	driveKey(m, tea.KeyPressMsg{Code: 'c'})
	waitFor(t, "compact reply", func() bool { return !m.bridge.busy })
	body := b.bodies[len(b.bodies)-1]
	if b.posts[len(b.posts)-1] != "/api/pi-bridge/compact" ||
		!strings.Contains(body, `"generation":"5"`) || !strings.Contains(body, `"telemetry_revision":"11"`) {
		t.Fatalf("compact request = %s %s", b.posts, b.bodies)
	}
	if !strings.Contains(m.status, "completed") {
		t.Fatalf("compact outcome not surfaced: %q", m.status)
	}

	driveKey(m, tea.KeyPressMsg{Code: 'r'})
	waitFor(t, "reload reply", func() bool { return !m.bridge.busy })
	body = b.bodies[len(b.bodies)-1]
	if b.posts[len(b.posts)-1] != "/api/pi-bridge/reload" ||
		!strings.Contains(body, `"process_id":"pi-9"`) || !strings.Contains(body, `"run_id":"3"`) || !strings.Contains(body, `"context_revision":"9"`) {
		t.Fatalf("reload request = %s %s", b.posts, b.bodies)
	}
	if !strings.Contains(m.status, "dispatched") {
		t.Fatalf("reload outcome not surfaced: %q", m.status)
	}

	// A reload without run/context revisions refuses locally: the server
	// requires positive stamps and the panel does not send doomed bodies.
	m.bridge.busy = false
	weak := snap
	weak.runID = 0
	tab.bridge = &weak
	count := len(b.posts)
	m.Update(tea.KeyPressMsg{Code: 'r'})
	if len(b.posts) != count {
		t.Fatal("reload with an incomplete origin reached the server")
	}
}

// TestBridgePanelRefusals pins that a refused ack never looks like success
// and the panel stays usable.
func TestBridgePanelRefusals(t *testing.T) {
	b := newBridgePanelServer()
	b.setModel = `{"ok":false,"reason":"switching"}`
	b.compactS, b.compactB = http.StatusConflict, `{"outcome":"rejected-before-start","reason":"running"}`
	srv := httptest.NewServer(b.handler())
	defer srv.Close()
	m, tab := bridgePanelTestModel(t, srv)
	m.modal.open(modalBridge, "Pi controls")
	m.bridge = bridgePanelState{pane: "p"}
	m.Update(m.loadBridgePanel(m.bridge.ticket)())

	driveKey(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	waitFor(t, "model refusal reply", func() bool { return !m.bridge.busy })
	if !strings.Contains(m.status, "refused") || !strings.Contains(m.status, "switching") {
		t.Fatalf("refusal not surfaced: %q", m.status)
	}

	tab.bridge = &bridgeSnapshot{state: "ready", generation: 5, telemetryRevision: 11, processID: "pi-9"}
	driveKey(m, tea.KeyPressMsg{Code: 'c'})
	waitFor(t, "compact rejection reply", func() bool { return !m.bridge.busy })
	if !strings.Contains(m.status, "rejected-before-start") || !strings.Contains(m.status, "running") {
		t.Fatalf("compact rejection not surfaced: %q", m.status)
	}
	if m.modal.kind != modalBridge {
		t.Fatal("panel closed on refusal")
	}
}

// TestBridgePanelStaleRepliesAreDropped pins the ticket/generation guards:
// a reply for another pane or an older ticket changes nothing.
func TestBridgePanelStaleRepliesAreDropped(t *testing.T) {
	b := newBridgePanelServer()
	srv := httptest.NewServer(b.handler())
	defer srv.Close()
	m, _ := bridgePanelTestModel(t, srv)
	m.modal.open(modalBridge, "Pi controls")
	m.bridge = bridgePanelState{pane: "p", ticket: 3}

	stale := bridgePanelMsg{gen: m.gen, ticket: 2, pane: "p",
		models: bridgeCatalog{Models: []BridgeModel{{Provider: "x", ID: "wrong"}}}}
	if cmd := m.handleBridgePanelMsg(stale); cmd != nil || len(m.bridge.models.Models) != 0 {
		t.Fatal("stale ticket overwrote the panel")
	}
	other := bridgePanelMsg{gen: m.gen, ticket: 3, pane: "other",
		models: bridgeCatalog{Models: []BridgeModel{{Provider: "x", ID: "wrong"}}}}
	if cmd := m.handleBridgePanelMsg(other); cmd != nil || len(m.bridge.models.Models) != 0 {
		t.Fatal("other pane reply overwrote the panel")
	}
	current := bridgePanelMsg{gen: m.gen, ticket: 3, pane: "p",
		models: bridgeCatalog{Models: []BridgeModel{{Provider: "x", ID: "right"}}}}
	if cmd := m.handleBridgePanelMsg(current); cmd != nil || len(m.bridge.models.Models) != 1 {
		t.Fatal("current reply was dropped")
	}

	oldGen := bridgeActionMsg{gen: m.gen - 1, pane: "p", kind: "model", detail: "m"}
	m.handleBridgeActionMsg(oldGen)
	if m.status != "" {
		t.Fatalf("stale action leaked into the status line: %q", m.status)
	}
}

// TestBridgePanelUnavailableLists pins the unavailable surface: an empty
// pane shows the server's answer, not a fabricated empty success.
func TestBridgePanelUnavailableLists(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/pi-bridge/models":
			fmt.Fprint(w, `{"models":[],"truncated":false,"unavailable":true}`)
		case "/api/pi-bridge/thinking-levels":
			http.Error(w, "pi thinking unavailable", http.StatusServiceUnavailable)
		case "/api/pi-bridge/skills":
			fmt.Fprint(w, `{"skills":[],"truncated":false,"unavailable":true,"process_id":"","generation":""}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	m, _ := bridgePanelTestModel(t, srv)
	m.modal.open(modalBridge, "Pi controls")
	m.bridge = bridgePanelState{pane: "p"}
	m.Update(m.loadBridgePanel(m.bridge.ticket)())
	view := ansi.Strip(m.renderBridgeModal())
	if !strings.Contains(view, "nothing published for this pane") {
		t.Fatalf("unavailable models section = %q", view)
	}
	m.Update(tea.KeyPressMsg{Code: '2'})
	if m.bridge.err == "" || !strings.Contains(ansi.Strip(m.renderBridgeModal()), "503") {
		t.Fatalf("thinking error not surfaced: %q err=%q", view, m.bridge.err)
	}
	// Enter on an empty section is a no-op, not a crash.
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.bridge.busy {
		t.Fatal("empty section started an action")
	}
}

// driveKey drives one key press through Update and executes the command it
// returns (for example a bridge action call) so its reply lands in the model.
func driveKey(m *tuiModel, msg tea.KeyPressMsg) {
	model, cmd := m.Update(msg)
	for i := 0; cmd != nil && i < 4; i++ {
		model, cmd = model.Update(cmd())
	}
}

func (b *bridgePanelServer) compactPosted(t *testing.T) bool {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, p := range b.posts {
		if p == "/api/pi-bridge/compact" {
			return true
		}
	}
	return false
}

func (b *bridgePanelServer) reloadPosted(t *testing.T) bool {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, p := range b.posts {
		if p == "/api/pi-bridge/reload" {
			return true
		}
	}
	return false
}
