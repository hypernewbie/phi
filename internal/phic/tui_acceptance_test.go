package phic

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/internal/termemu/stub"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// TestTUIBackendFocusReceivesControlKeys pins UX/VT gate behavior: Ctrl-C,
// Tab, arrows, and ordinary digits reach the backend unchanged in meaning.
func TestTUIBackendFocusReceivesControlKeys(t *testing.T) {
	up := wsUpgrader()
	inputs := make(chan string, 16)
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
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if len(msg) > 0 && msg[0] == wireproto.FrameInput {
				inputs <- string(msg[1:])
			}
		}
	}))
	defer srv.Close()

	m := newModelWithServer(t, srv)
	m.build = func(o termemu.Options) (termemu.Terminal, error) {
		st, err := stub.New(o)
		if err != nil {
			return nil, err
		}
		st.KeyFn = func(ev termemu.KeyEvent) []byte {
			return []byte(fmt.Sprintf("k%d:%d:%s", ev.Key, ev.Mods, ev.Text))
		}
		return st, nil
	}
	tab := attachPaneForTest(t, m)
	waitFor(t, "backend input connection", func() bool { return tab.actor.getConn() != nil })

	keys := []tea.Key{
		{Code: 'c', Mod: tea.ModCtrl, BaseCode: 'c'},
		{Code: tea.KeyTab},
		{Code: tea.KeyUp},
		{Code: '7', Text: "7", BaseCode: '7'},
	}
	for _, k := range keys {
		m.Update(tea.KeyPressMsg(k))
	}
	for _, k := range keys {
		ev, ok := teaKeyEvent(k, termemu.KeyPress)
		if !ok {
			t.Fatalf("key %v rejected by translation", k)
		}
		want := fmt.Sprintf("k%d:%d:%s", ev.Key, ev.Mods, ev.Text)
		select {
		case got := <-inputs:
			if got != want {
				t.Fatalf("backend bytes for %v = %q, want %q", k, got, want)
			}
		case <-timeAfter():
			t.Fatalf("backend never received %v", k)
		}
	}
}

// TestTUIRawPrefixByteArmsTheApplication keeps Ctrl-] usable on terminals
// that deliver it as a raw 0x1d control byte.
func TestTUIRawPrefixByteArmsTheApplication(t *testing.T) {
	m := newModelWithServer(t, httptest.NewServer(http.NotFoundHandler()))
	m.Update(tea.KeyPressMsg(tea.Key{Code: 0x1d}))
	if !m.prefix {
		t.Fatal("raw Ctrl-] did not arm the prefix")
	}
	m.Update(tea.KeyPressMsg(tea.Key{Code: '?'}))
	if m.prefix || m.modal.kind != modalHelp {
		t.Fatalf("prefix key after raw Ctrl-] failed: prefix=%v modal=%v", m.prefix, m.modal.kind)
	}
}

// TestTUIResizeCollapsesPanels covers UX-08: narrow and wide geometry keeps a
// valid widget; tiny windows keep normal input/rendering rather than a size gate.
func TestTUIResizeCollapsesPanels(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	m := newModelWithServer(t, srv)
	defer m.closeAll()
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	if !m.showSidebar() {
		t.Fatal("wide layout dropped the sidebar")
	}
	wide, wideRows := m.terminalSize()
	if wide <= 0 || wideRows <= 0 {
		t.Fatalf("wide widget geometry invalid: %dx%d", wide, wideRows)
	}

	m.Update(tea.WindowSizeMsg{Width: 60, Height: 24})
	if m.showSidebar() {
		t.Fatal("narrow layout kept the sidebar without focus")
	}
	narrow, narrowRows := m.terminalSize()
	if narrow <= 0 || narrowRows <= 0 {
		t.Fatalf("narrow widget geometry invalid: %dx%d", narrow, narrowRows)
	}
	if narrow != 58 {
		t.Fatalf("narrow terminal did not reclaim the sidebar width: %d, want 58", narrow)
	}

	m.Update(tea.WindowSizeMsg{Width: 30, Height: 8})
	if out := m.render(); strings.Contains(out, "terminal too small") || out == "phic" {
		t.Fatalf("tiny layout did not render the normal console:\n%s", out)
	}
	if c, r := m.terminalSize(); c < 1 || r < 1 {
		t.Fatal("tiny layout blocked the backend geometry")
	}
}

// TestTUILockedServerOpensPasswordModal covers UX-12: a locked server asks for
// the password instead of silently looping.
func TestTUILockedServerOpensPasswordModal(t *testing.T) {
	m := newModelWithServer(t, httptest.NewServer(http.NotFoundHandler()))
	m.Update(serverLoadedMsg{gen: m.gen, index: 0, needAuth: true, auth: authStatus{Enabled: true}})
	if m.modal.kind != modalPassword {
		t.Fatalf("locked server did not open the password dialog: %v", m.modal.kind)
	}
	if !m.data[m.currentOrigin()].needAuth {
		t.Fatal("locked state not recorded")
	}
}

// TestTUIHistoryFetchIsBounded covers HIST-01: browsing asks for a bounded
// tail of the recording and ends exactly at the attach head.
func TestTUIHistoryFetchIsBounded(t *testing.T) {
	head := uint64(historyWindowBytes + 100)
	var mu sync.Mutex
	var queries [][2]uint64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/recording") {
			http.NotFound(w, r)
			return
		}
		from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
		through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
		mu.Lock()
		queries = append(queries, [2]uint64{from, through})
		mu.Unlock()
		hdr, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: through})
		var size [4]byte
		binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
		_, _ = w.Write(size[:])
		_, _ = w.Write(hdr)
		_, _ = w.Write(make([]byte, through-from))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if _, err := fetchHistoryText(ctx, mustAPI(t, srv.URL), "p", 7, head, stubBuild); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(queries) == 0 {
		t.Fatal("history made no recording requests")
	}
	if queries[0][0] != head-historyWindowBytes {
		t.Fatalf("history window start = %d, want %d", queries[0][0], head-historyWindowBytes)
	}
	if queries[len(queries)-1][1] != head {
		t.Fatalf("history did not end at the attach head: %+v", queries)
	}
	total := uint64(0)
	for _, q := range queries {
		total += q[1] - q[0]
	}
	if total != historyWindowBytes {
		t.Fatalf("history fetched %d bytes, want %d", total, historyWindowBytes)
	}
}

// TestTUIFinalCloseUsesCapturedOrigin covers UX-10: a final close reaches the
// pane's original server even after the rail switched elsewhere.
func TestTUIFinalCloseUsesCapturedOrigin(t *testing.T) {
	var deletesA, deletesB atomic.Int32
	countDeletes := func(counter *atomic.Int32) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodDelete {
				counter.Add(1)
				w.WriteHeader(http.StatusOK)
				return
			}
			http.NotFound(w, r)
		}))
	}
	first, second := countDeletes(&deletesA), countDeletes(&deletesB)
	defer first.Close()
	defer second.Close()

	m := newTUIModel("test", config{}, nil, []*serverState{
		{profile: desktopProfile{ID: "s1", Name: "one", Origin: first.URL}, api: mustAPI(t, first.URL)},
		{profile: desktopProfile{ID: "s2", Name: "two", Origin: second.URL}, api: mustAPI(t, second.URL)},
	}, 0, stubBuild)
	tab := &paneTab{key: paneKey{Origin: first.URL, ID: "p"}, title: "shell"}
	m.tabs[first.URL] = []*paneTab{tab}
	m.active = 1 // the user switched to the other server first

	cmd := m.closeTab(tab, true)
	msg, ok := cmd().(deleteDoneMsg)
	if !ok || msg.err != "" {
		t.Fatalf("final close failed: %+v", msg)
	}
	if deletesA.Load() != 1 || deletesB.Load() != 0 {
		t.Fatalf("DELETE went to the wrong origin: first=%d second=%d", deletesA.Load(), deletesB.Load())
	}
}
