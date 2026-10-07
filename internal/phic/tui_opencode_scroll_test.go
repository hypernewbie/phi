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

func TestOpenCodeScrollHackPredicate(t *testing.T) {
	cases := []struct {
		name string
		tab  *paneTab
		want bool
	}{
		{"nil tab", nil, false},
		{"shell coder", &paneTab{coder: "shell"}, false},
		{"claude coder", &paneTab{coder: "claude"}, false},
		{"opencode full tui", &paneTab{coder: "opencode", view: TerminalView{Coder: "opencode", OpenCodeMode: "tui"}}, true},
		{"opencode legacy", &paneTab{coder: "opencode", view: TerminalView{Coder: "opencode", OpenCodeMode: "legacy"}}, true},
		{"opencode unset mode", &paneTab{coder: "opencode"}, true},
		{"opencode mini", &paneTab{coder: "opencode", view: TerminalView{Coder: "opencode", OpenCodeMode: "mini"}}, false},
		{"view coder fallback", &paneTab{view: TerminalView{Coder: "opencode"}}, true},
		{"tab coder wins over view", &paneTab{coder: "shell", view: TerminalView{Coder: "opencode"}}, false},
	}
	for _, tc := range cases {
		if got := openCodeScrollHack(tc.tab); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestOpenCodeScrollKeys(t *testing.T) {
	// Byte-exact with the web handlers: ESC EM up, ESC ENQ down.
	if got := openCodeScrollKeys(false); got != "\x1b\x19\x1b\x19\x1b\x19" {
		t.Fatalf("scroll up keys = %q", got)
	}
	if got := openCodeScrollKeys(true); got != "\x1b\x05\x1b\x05\x1b\x05" {
		t.Fatalf("scroll down keys = %q", got)
	}
}

// scrollFixture serves spawn plus a generic pane endpoint that answers the
// attach handshake and records raw client input bytes per pane.
type scrollFixture struct {
	srv    *httptest.Server
	spawns chan SpawnRequest
	inputs chan paneInputFrame
}

type paneInputFrame struct {
	pane  string
	input string
}

func newScrollFixture(t *testing.T) *scrollFixture {
	t.Helper()
	fx := &scrollFixture{spawns: make(chan SpawnRequest, 4), inputs: make(chan paneInputFrame, 16)}
	upgrade := websocket.Upgrader{}
	fx.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/terminals" && r.Method == http.MethodPost {
			var req SpawnRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			fx.spawns <- req
			id := "pane-" + req.Coder
			if req.OpenCodeMini {
				id += "-mini"
			}
			_ = json.NewEncoder(w).Encode(SpawnResponse{PaneID: id})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/ws/pane/") {
			id := strings.TrimPrefix(r.URL.Path, "/ws/pane/")
			ws, err := upgrade.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: 0}, nil))
			for {
				_, frame, err := ws.ReadMessage()
				if err != nil {
					return
				}
				if len(frame) > 0 && frame[0] == wireproto.FrameInput {
					fx.inputs <- paneInputFrame{pane: id, input: string(frame[1:])}
				}
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(fx.srv.Close)
	return fx
}

func (fx *scrollFixture) attachTab(t *testing.T, m *tuiModel, paneID, coder, mode string) (*paneTab, *paneActor) {
	t.Helper()
	origin := m.currentOrigin()
	spec := paneSpec{Key: paneKey{Origin: origin, ID: paneID}, Cols: 100, Rows: 30, Coder: coder}
	p, err := newPaneActor(t.Context(), mustAPI(t, fx.srv.URL), spec, m.events, stubBuild)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.close)
	tab := &paneTab{
		key:   spec.Key,
		coder: coder,
		view:  TerminalView{ID: paneID, Coder: coder, OpenCodeMode: mode},
		actor: p,
	}
	m.tabs[origin] = append(m.tabs[origin], tab)
	m.activeTab[origin] = len(m.tabs[origin]) - 1
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case ev := <-m.events:
			m.Update(msgPaneEvent{ev: ev})
			if ev.Key == spec.Key && ev.Kind == paneStatus && ev.Status == "connected" {
				return tab, p
			}
		case <-time.After(time.Until(deadline)):
			t.Fatal("actor did not connect")
		}
	}
}

func wheelInTerminal(m *tuiModel, down bool) {
	inner := m.terminalInner()
	button := tea.MouseWheelUp
	if down {
		button = tea.MouseWheelDown
	}
	m.handleMouse(tea.MouseWheelMsg{X: inner.X + 2, Y: inner.Y + 2, Button: button})
}

func TestOpenCodeWheelSendsKeysOnWire(t *testing.T) {
	fx := newScrollFixture(t)
	m := newModelWithServer(t, fx.srv)
	defer m.closeAll()
	m.project = "/work"
	tab, _ := fx.attachTab(t, m, "oc-pane", "opencode", "tui")
	if !openCodeScrollHack(tab) {
		t.Fatal("fixture tab should take the scroll hack")
	}
	wheelInTerminal(m, false)
	select {
	case got := <-fx.inputs:
		if got.pane != "oc-pane" || got.input != "\x1b\x19\x1b\x19\x1b\x19" {
			t.Fatalf("scroll up sent %+q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("scroll up sent nothing")
	}
	wheelInTerminal(m, true)
	select {
	case got := <-fx.inputs:
		if got.pane != "oc-pane" || got.input != "\x1b\x05\x1b\x05\x1b\x05" {
			t.Fatalf("scroll down sent %+q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("scroll down sent nothing")
	}
}

func TestShellWheelSendsNoKeys(t *testing.T) {
	fx := newScrollFixture(t)
	m := newModelWithServer(t, fx.srv)
	defer m.closeAll()
	m.project = "/work"
	tab, _ := fx.attachTab(t, m, "shell-pane", "shell", "")
	if openCodeScrollHack(tab) {
		t.Fatal("shell tab must not take the scroll hack")
	}
	wheelInTerminal(m, false)
	wheelInTerminal(m, true)
	select {
	case got := <-fx.inputs:
		t.Fatalf("shell wheel leaked input bytes: %+q", got)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestSendRawGuards(t *testing.T) {
	fx := newScrollFixture(t)
	m := newModelWithServer(t, fx.srv)
	defer m.closeAll()
	m.project = "/work"
	_, p := fx.attachTab(t, m, "guard-pane", "opencode", "tui")
	// Exited panes drop raw input with an error event, like keys.
	p.mu.Lock()
	p.exited = true
	p.mu.Unlock()
	p.sendRaw([]byte("\x1b\x19"))
	select {
	case ev := <-m.events:
		if ev.Kind != paneError {
			t.Fatalf("exited sendRaw produced %v, want paneError", ev.Kind)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exited sendRaw produced no guard event")
	}
	select {
	case got := <-fx.inputs:
		t.Fatalf("exited pane leaked bytes: %+q", got)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestNewSessionOpenCodeOffersMini(t *testing.T) {
	fx := newScrollFixture(t)
	m := newModelWithServer(t, fx.srv)
	defer m.closeAll()
	m.project = "/work"
	origin := m.currentOrigin()
	idx := -1
	for i, c := range m.data[origin].coders {
		if c.ID == "opencode" {
			idx = i
		}
	}
	if idx < 0 {
		m.data[origin].coders = append(m.data[origin].coders, CoderDescriptor{ID: "opencode", Name: "OpenCode"})
		idx = len(m.data[origin].coders) - 1
	}
	m.coderIdx = idx

	if cmd := m.newSession(); cmd != nil {
		t.Fatal("opencode new session should open the variant modal, not spawn")
	}
	if m.modal.kind != modalOpenCode {
		t.Fatalf("modal kind = %v, want modalOpenCode", m.modal.kind)
	}
	if len(m.modal.items) != 2 || m.modal.items[0].value != "full" || m.modal.items[1].value != "mini" {
		t.Fatalf("variant items = %+v", m.modal.items)
	}
	if m.modal.cursor != 0 {
		t.Fatal("full TUI must stay the default")
	}
	// Esc cancels without spawning.
	_, _ = m.handleModalKey(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.modal.kind != modalNone {
		t.Fatal("esc did not close the variant modal")
	}
	select {
	case req := <-fx.spawns:
		t.Fatalf("cancelled modal spawned: %+v", req)
	default:
	}
	// "Open" launches full; "Open Mini" sets the per-launch flag the
	// server turns into a mini backend, which the tab then retains.
	for _, tc := range []struct {
		cursor int
		mini   bool
	}{{0, false}, {1, true}} {
		m.openOpenCodeModal()
		m.modal.cursor = tc.cursor
		_, cmd := m.handleModalKey(tea.KeyPressMsg{Code: tea.KeyEnter})
		if cmd == nil {
			t.Fatal("variant enter produced no spawn command")
		}
		msg := cmd()
		done, ok := msg.(spawnDoneMsg)
		if !ok || done.err != "" {
			t.Fatalf("spawn failed: %+v", msg)
		}
		var req SpawnRequest
		select {
		case req = <-fx.spawns:
		case <-time.After(5 * time.Second):
			t.Fatal("variant choice spawned nothing")
		}
		if req.OpenCodeMini != tc.mini {
			t.Fatalf("cursor %d: OpenCodeMini = %v, want %v", tc.cursor, req.OpenCodeMini, tc.mini)
		}
		m.Update(done)
		tab := m.findTab(paneKey{Origin: origin, ID: done.resp.PaneID})
		if tab == nil {
			t.Fatal("spawned tab missing")
		}
		wantMode := ""
		if tc.mini {
			wantMode = "mini"
		}
		if tab.view.OpenCodeMode != wantMode {
			t.Fatalf("cursor %d: tab mode = %q, want %q", tc.cursor, tab.view.OpenCodeMode, wantMode)
		}
		if openCodeScrollHack(tab) == tc.mini {
			t.Fatalf("cursor %d: scroll hack mismatch for mode %q", tc.cursor, tab.view.OpenCodeMode)
		}
	}
}
