package phic

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/gorilla/websocket"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestBtopMatchesWebsiteFreshShellThenInputOnce(t *testing.T) {
	requests := make(chan SpawnRequest, 2)
	inputs := make(chan string, 4)
	upgrade := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/terminals":
			var req SpawnRequest
			json.NewDecoder(r.Body).Decode(&req)
			requests <- req
			json.NewEncoder(w).Encode(SpawnResponse{PaneID: "btop-pane"})
		case "/ws/pane/btop-pane":
			ws, err := upgrade.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			ws.WriteMessage(websocket.BinaryMessage, testAttach(t, 7, 0))
			for {
				_, frame, err := ws.ReadMessage()
				if err != nil {
					return
				}
				decoded, derr := wireproto.DecodeClientFrame(frame)
				if derr == nil {
					if in, ok := decoded.GetPayload().(*wspb.TerminalClientFrame_Input); ok {
						inputs <- string(in.Input)
					}
				}
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	m := newModelWithServer(t, srv)
	defer m.closeAll()
	m.worktree = "/work/feature"
	rail := ansi.Strip(m.renderRail())
	at := strings.Index(rail, "[▥]")
	if at < 0 {
		t.Fatal("btop button not rendered")
	}
	_, cmd := m.handleMouse(tea.MouseClickMsg{X: ansi.StringWidth(rail[:at]), Y: 0, Button: tea.MouseLeft})
	if cmd == nil {
		t.Fatal("click on btop icon did not launch")
	}
	m.worktree = "/different" // Dispatch owns the old server/cwd, like New Session.
	msg := cmd()
	req := <-requests
	if req.Title != "btop" || req.Coder != "shell" || req.Dir != "/work/feature" || req.Workspace != "/work" || req.SessionID != "" {
		t.Fatalf("wrong monitor launch: %+v", req)
	}
	m.Update(msg)
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case ev := <-m.events:
			m.Update(msgPaneEvent{ev: ev})
		case input := <-inputs:
			if input != "btop\r" {
				t.Fatalf("unexpected startup input %q", input)
			}
			tab := m.activeTabModel()
			if tab == nil || tab.startupInput != "" {
				t.Fatal("btop input could repeat after reconnect")
			}
			return
		case <-deadline.C:
			t.Fatal("monitor command was not delivered after attach")
		}
	}
}
func TestServerRailUsesUppercasePCNameWithoutPortAndCorrectHits(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	s := m.currentServer()
	s.profile.Name = "charon:7070"
	if m.railLabel(s) != "CHARON" {
		t.Fatal("port/name presentation was not compact")
	}
	m.current().identity.Hostname = "CHARON"
	line := ansi.Strip(m.renderRail())
	if !strings.Contains(line, "CHARON") || strings.Contains(line, "charon:7070") {
		t.Fatalf("wrong PC label: %q", line)
	}
	if !strings.Contains(line, "[▥]") {
		t.Fatal("missing monitor icon")
	}
	at := strings.Index(line, "CHARON")
	if index, ok := m.railHit(ansi.StringWidth(line[:at])); !ok || index != m.active {
		t.Fatal("shortened label changed server click target")
	}
	// Menu/HTTP identity remains the original saved name and address.
	if s.profile.Name != "charon:7070" {
		t.Fatal("display change rewrote shared profile")
	}
}
