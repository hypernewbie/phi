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
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestTinyConsoleAttachesAndForwardsNormalInputWithoutRecoveryMode(t *testing.T) {
	input := make(chan string, 20)
	upgrade := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ws/pane/p":
			ws, err := upgrade.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: 0}, nil))
			for {
				_, b, err := ws.ReadMessage()
				if err != nil {
					return
				}
				if len(b) > 0 && b[0] == 1 {
					input <- string(b[1:])
				}
			}
		case "/api/terminals":
			var req SpawnRequest
			json.NewDecoder(r.Body).Decode(&req)
			if req.Cols != 1 || req.Rows != 1 {
				t.Errorf("tiny launch sent invalid geometry: %+v", req)
			}
			json.NewEncoder(w).Encode(SpawnResponse{PaneID: "new"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	m := newModelWithServer(t, srv)
	defer m.closeAll()
	if probe, err := termemu.NewGhostty(termemu.Options{Cols: 1, Rows: 1}); err == nil {
		probe.Close()
		m.build = termemu.NewGhostty
	}
	m.width, m.height = 1, 1
	tab := m.ensureTab(m.currentOrigin(), "p", spawnCapture{project: "/work", coder: "shell"})
	m.activateCurrentTab()
	if tab.actor == nil {
		t.Fatal("1x1 window prevented initial attachment")
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	connected := false
	for !connected {
		select {
		case ev := <-m.events:
			m.Update(msgPaneEvent{ev: ev})
			connected = ev.Kind == paneStatus && ev.Status == "connected"
		case <-deadline.C:
			t.Fatal("tiny pane could not bootstrap")
		}
	}
	for i, size := range [][2]int{{1, 1}, {2, 2}, {5, 3}, {30, 8}, {100, 30}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m.focus = focusTerminal
		if strings.Contains(m.render(), "terminal too small") {
			t.Fatal("normal render replaced by a deadlock screen")
		}
		c, r := m.terminalSize()
		if c < 1 || r < 1 {
			t.Fatal("zero backend geometry")
		}
		key := string(rune('a' + i))
		m.Update(tea.KeyPressMsg{Code: rune('a' + i), Text: key})
		select {
		case got := <-input:
			if got != key {
				t.Fatalf("%dx%d input %q, want %q", size[0], size[1], got, key)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%dx%d input stalled", size[0], size[1])
		}
	}
	m.width, m.height = 1, 1
	if cmd := m.newSession(); cmd == nil {
		t.Fatal("tiny console prevented a new pane launch")
	} else if msg := cmd().(spawnDoneMsg); msg.err != "" || msg.resp.PaneID != "new" {
		t.Fatalf("tiny launch failed: %+v", msg)
	}
}
