package phic

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

type refreshReplayStub struct{ termemu.Terminal }

func (p refreshReplayStub) Feed(b []byte, source termemu.Source) error {
	return p.Terminal.Feed(b, termemu.SourceLive)
}

func TestExplicitRefreshClosesAllClientsAndRebuildsEachOriginWithoutDeletingPanes(t *testing.T) {
	var phase atomic.Int32
	var deletes atomic.Int32
	closed := make(chan string, 8)
	makeServer := func(label string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodDelete {
				deletes.Add(1)
				w.WriteHeader(200)
				return
			}
			state := []byte(label + " OLD")
			if phase.Load() > 0 {
				state = []byte(label + " REBUILT")
			}
			if strings.HasSuffix(r.URL.Path, "/recording") {
				h, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: 0, End: uint64(len(state))})
				var prefix [4]byte
				binary.BigEndian.PutUint32(prefix[:], uint32(len(h)))
				_, _ = w.Write(append(append(prefix[:], h...), state...))
				return
			}
			if !strings.HasPrefix(r.URL.Path, "/ws/pane/") {
				http.NotFound(w, r)
				return
			}
			conn, err := (&websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}).Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			_ = conn.WriteMessage(websocket.BinaryMessage, testAttachCkpt(t, 7, uint64(len(state)), "ansi-v1", uint64(len(state)), 80, 20, state))
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					closed <- label
					return
				}
			}
		}))
	}
	a, b := makeServer("FIRST"), makeServer("SECOND")
	defer a.Close()
	defer b.Close()
	m := newModelWithServer(t, a)
	m.build = func(o termemu.Options) (termemu.Terminal, error) {
		p, err := stubBuild(o)
		return refreshReplayStub{p}, err
	}
	m.servers = append(m.servers, &serverState{api: mustAPI(t, b.URL), profile: desktopProfile{ID: "b", Origin: b.URL}})
	defer m.closeAll()
	first := m.ensureTab(m.currentOrigin(), "p", spawnCapture{title: "first", coder: "shell", project: "/work"})
	second := m.ensureTab(m.originFor(1), "p", spawnCapture{title: "second", coder: "shell", project: "/elsewhere"})
	m.attachTab(first)
	m.attachTab(second)
	oldFirst, oldSecond := first.actor, second.actor
	for i := 0; i < 2; i++ {
		waitPaneEvent(t, m.events, paneOutput)
	}
	phase.Store(1)
	m.mouseCapture = true
	m.panelDrag = 1
	sequence := m.refreshConsole()
	if first.actor != nil || second.actor != nil || m.mouseCapture || m.panelDrag != 0 {
		t.Fatal("old display/input owners survived refresh admission")
	}
	if m.refreshConsole() == nil || m.refreshToken != 1 {
		t.Fatal("repeated refresh was not coalesced")
	}
	cmds := reflect.ValueOf(sequence())
	if cmds.Len() != 4 {
		t.Fatalf("missing clear/size/stop/reload sequence: %v", cmds.Len())
	}
	reset := cmds.Index(2).Interface().(tea.Cmd)().(consoleResetMsg)
	for i := 0; i < 2; i++ {
		select {
		case <-closed:
		case <-t.Context().Done():
			t.Fatal("old socket was not closed")
		}
	}
	m.Update(reset)
	if first.actor == nil || second.actor == nil || first.actor == oldFirst || second.actor == oldSecond {
		t.Fatal("refresh did not create new parser owners")
	}
	if m.active != 0 || len(m.tabs[first.key.Origin]) != 1 || len(m.tabs[second.key.Origin]) != 1 {
		t.Fatal("refresh lost server selection or tab identities")
	}
	if deletes.Load() != 0 {
		t.Fatal("refresh terminated backend panes")
	}
	awaiting := map[*paneActor]bool{first.actor: true, second.actor: true}
	for len(awaiting) > 0 {
		ev := waitPaneEvent(t, m.events, paneOutput)
		delete(awaiting, ev.Actor)
	}
	for _, tab := range []*paneTab{first, second} {
		frame, ok := tab.actorSnapshot()
		if !ok || !strings.Contains(frameText(frame), "REBUILT") {
			t.Fatalf("%s retained old/corrupt display: %q", tab.key, frameText(frame))
		}
	}
	m.handlePaneEvent(paneEvent{Actor: oldFirst, Key: first.key, Kind: paneExited, Code: 42})
	if first.exited || m.actors[first.key] != first.actor {
		t.Fatal("late old-client event corrupted the replacement")
	}
}

func TestRefreshConsoleResetsServerIdentityAndMetadata(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	origin := m.currentOrigin()

	// Setup known server metadata for active server and a secondary server
	m.data[origin].identity = serverIdentity{Theme: "indigo", Hostname: "callisto"}
	m.data[origin].loaded = true
	m.data[origin].health = "up"
	m.data[origin].project = "/my/project"
	m.data[origin].worktree = "/my/worktree"
	m.data[origin].coderID = "pi"
	m.servers[0].identity = serverIdentity{Theme: "indigo", Hostname: "callisto"}
	m.servers[0].health = "up"
	m.cpuTiers = map[string]cpuTier{origin: cpuModerate}
	m.identityPolls = map[string]time.Time{origin: time.Now()}

	otherOrigin := "http://jupiter:7070"
	otherAPI, _ := newAPIClient(otherOrigin)
	m.servers = append(m.servers, &serverState{
		profile:  desktopProfile{ID: "jupiter", Origin: otherOrigin},
		api:      otherAPI,
		identity: serverIdentity{Theme: "emerald", Hostname: "jupiter"},
		health:   "up",
	})
	m.data[otherOrigin] = &serverData{
		identity: serverIdentity{Theme: "emerald", Hostname: "jupiter"},
		loaded:   true,
		health:   "up",
	}

	// Trigger manual refresh
	_ = m.refreshConsole()

	// Verify active server metadata was reset for cold repopulation
	d := m.data[origin]
	if d.identity.present() {
		t.Fatalf("refreshConsole did not reset serverData identity: %+v", d.identity)
	}
	if d.loaded {
		t.Fatal("refreshConsole did not reset serverData loaded")
	}
	if d.health != "" {
		t.Fatal("refreshConsole did not reset serverData health")
	}
	if m.servers[0].identity.present() {
		t.Fatalf("refreshConsole did not reset serverState identity: %+v", m.servers[0].identity)
	}
	if m.servers[0].health != "" {
		t.Fatal("refreshConsole did not reset serverState health")
	}
	if m.cpuTiers != nil {
		t.Fatal("refreshConsole did not reset cpuTiers")
	}
	if m.identityPolls != nil {
		t.Fatal("refreshConsole did not reset identityPolls")
	}

	// Verify non-active server metadata was preserved
	otherD := m.data[otherOrigin]
	if otherD.identity.Theme != "emerald" || otherD.identity.Hostname != "jupiter" {
		t.Fatalf("refreshConsole unexpectedly wiped non-active serverData identity: %+v", otherD.identity)
	}
	if m.servers[1].identity.Theme != "emerald" || m.servers[1].identity.Hostname != "jupiter" {
		t.Fatalf("refreshConsole unexpectedly wiped non-active serverState identity: %+v", m.servers[1].identity)
	}
	if otherD.health != "up" || m.servers[1].health != "up" {
		t.Fatal("refreshConsole unexpectedly wiped non-active server health")
	}

	// Verify user intent/context was preserved
	if d.project != "/my/project" || d.worktree != "/my/worktree" || d.coderID != "pi" {
		t.Fatalf("refreshConsole lost project/worktree/coder context: %q, %q, %q", d.project, d.worktree, d.coderID)
	}

	// Verify subsequent server load repopulates the new theme and updates accentHex
	m.applyServerLoaded(serverLoadedMsg{
		gen:      m.gen,
		index:    0,
		identity: serverIdentity{Theme: "coral", Hostname: "callisto"},
		health:   "up",
	})
	if d.identity.Theme != "coral" {
		t.Fatalf("expected d.identity.Theme = coral, got %q", d.identity.Theme)
	}
	if m.servers[0].identity.Theme != "coral" {
		t.Fatalf("expected serverState.identity.Theme = coral, got %q", m.servers[0].identity.Theme)
	}
	if hex := m.accentHex(); hex != strings.TrimPrefix(phiAccents["coral"], "#") {
		t.Fatalf("expected accentHex = coral (%q), got %q", strings.TrimPrefix(phiAccents["coral"], "#"), hex)
	}
}
