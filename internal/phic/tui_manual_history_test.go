package phic

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestScrollAtOlderBoundaryNeverRequestsHistory(t *testing.T) {
	for _, archived := range []bool{false, true} {
		t.Run(strconv.FormatBool(archived), func(t *testing.T) {
			live := historyReviewTerminal(t)
			defer live.Close()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "unexpected history request", http.StatusInternalServerError)
			}))
			defer srv.Close()
			p := &paneActor{ctx: ctx, emu: live, api: mustAPI(t, srv.URL), frontier: 8192, epoch: 7, historyOffset: -9, frame: termemu.Frame{History: 10}, histories: make(chan historyResult, 1)}
			if archived {
				p.history = live
				p.historyThrough = 4096
			}
			for range 3 {
				if err := p.handleInput(paneInput{Kind: paneInputScroll, Scroll: -3}); err != nil {
					t.Fatal(err)
				}
			}
			if p.historyPending || p.historyGen != 0 || p.historyOffset != -10 || len(live.scrolls) != 3 {
				t.Fatalf("scroll fetched history instead of clamping locally: pending=%v gen=%d offset=%d scrolls=%v", p.historyPending, p.historyGen, p.historyOffset, live.scrolls)
			}
		})
	}
}

func TestManualHistoryRequestsOneBookPerActionAndStopsAtOldest(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.String())
		q := r.URL.Query()
		through, _ := strconv.ParseUint(q.Get("through"), 10, 64)
		var header []byte
		var body []byte
		if strings.HasSuffix(r.URL.Path, "/state") {
			header, _ = json.Marshal(wireproto.AttachHeadHeader{Epoch: 7, Head: through, Ckpt: &wireproto.CheckpointHeader{Kind: "ghostty-ready-v1", Through: through, Cols: 80, Rows: 24}})
		} else {
			from, _ := strconv.ParseUint(q.Get("from"), 10, 64)
			header, _ = json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: through})
			body = []byte(strings.Repeat("x", int(through-from)))
		}
		var prefix [4]byte
		binary.BigEndian.PutUint32(prefix[:], uint32(len(header)))
		_, _ = w.Write(append(append(prefix[:], header...), body...))
	}))
	defer srv.Close()
	live := historyReviewTerminal(t)
	defer live.Close()
	p := &paneActor{ctx: ctx, emu: live, spec: paneSpec{Key: paneKey{ID: "p"}}, api: mustAPI(t, srv.URL), frontier: 8192, epoch: 7, histories: make(chan historyResult, 1), build: func(termemu.Options) (termemu.Terminal, error) { return historyReviewTerminal(t), nil }}
	for _, through := range []uint64{4096, 0} {
		if err := p.handleInput(paneInput{Kind: paneInputHistory}); err != nil {
			t.Fatal(err)
		}
		gen := p.historyGen
		if err := p.handleInput(paneInput{Kind: paneInputHistory}); err != nil {
			t.Fatal(err)
		}
		if !p.historyPending || p.historyGen != gen {
			t.Fatal("duplicate request was not suppressed")
		}
		var result historyResult
		select {
		case result = <-p.histories:
		case <-timeAfter():
			t.Fatal("manual history request did not complete")
		}
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.through != through {
			t.Fatalf("book starts at %d, want %d", result.through, through)
		}
		if err := p.applyHistory(result); err != nil {
			t.Fatal(err)
		}
		if p.historyPending || p.history == nil {
			t.Fatal("requested book was not installed")
		}
	}
	if err := p.refreshFrame(); err != nil {
		t.Fatal(err)
	}
	if p.historyViewCopy().Older {
		t.Fatal("oldest book still advertises older output")
	}
	gen := p.historyGen
	if err := p.handleInput(paneInput{Kind: paneInputHistory}); err != nil {
		t.Fatal(err)
	}
	if p.historyGen != gen || p.historyPending || len(requests) != 4 {
		t.Fatalf("extra request at oldest book: %v", requests)
	}
	if err := p.handleInput(paneInput{Kind: paneInputLive}); err != nil {
		t.Fatal(err)
	}
	if p.history != nil || p.historyOffset != 0 {
		t.Fatal("explicit live action kept archived view")
	}
}

func TestHistoryPrefixShortcutsDoNotStealBackendKeys(t *testing.T) {
	m := deltaTestModel()
	m.focus = focusTerminal
	tab := deltaTestTab(m)
	tab.actor = &paneActor{ctx: t.Context(), conn: &websocket.Conn{}, inbox: make(chan paneInput, 4)}
	admitted := func() paneInput {
		select {
		case in := <-tab.actor.inbox:
			return in
		default:
			t.Fatal("key action was not admitted")
			return paneInput{}
		}
	}
	for _, key := range []rune{tea.KeyPgUp, tea.KeyEnd} {
		m.Update(tea.KeyPressMsg{Code: key})
		in := admitted()
		if in.Kind != paneInputKey {
			t.Fatal("unprefixed key did not reach backend")
		}
		m.Update(tea.KeyPressMsg{Code: 0x1d})
		m.Update(tea.KeyPressMsg{Code: key})
		in = admitted()
		want := paneInputHistory
		if key == tea.KeyEnd {
			want = paneInputLive
		}
		if in.Kind != want || m.prefix {
			t.Fatalf("prefix key %v produced %v", key, in.Kind)
		}
	}
	m.openHelp()
	if !strings.Contains(m.modal.help, "Ctrl-] PgUp") || !strings.Contains(m.modal.help, "Ctrl-] End") {
		t.Fatal("history shortcuts missing from help")
	}
}

type manualHistoryTerminal struct {
	*reviewHistoryTerminal
	frame termemu.Frame
}

func (t *manualHistoryTerminal) Snapshot() (termemu.Frame, error) { return t.frame, nil }
func (t *manualHistoryTerminal) Mode(mode termemu.Mode) (bool, error) {
	if mode == termemu.ModeAlternateScreen {
		return t.frame.Alt, nil
	}
	return t.reviewHistoryTerminal.Mode(mode)
}

func TestHistoryFooterTracksNearTopLoadingAndAlternateScreen(t *testing.T) {
	live := &manualHistoryTerminal{reviewHistoryTerminal: historyReviewTerminal(t), frame: termemu.Frame{Cols: 80, Rows: 24, History: 100}}
	defer live.Close()
	p := &paneActor{emu: live, frontier: 8192, historyOffset: -3}
	m := deltaTestModel()
	m.width = 160
	m.focus = focusTerminal
	deltaTestTab(m).actor = p
	for _, tc := range []struct {
		offset             int
		loading, alt, show bool
	}{
		{-3, false, false, false}, {-76, false, false, true}, {-100, false, false, true}, {-100, true, false, false}, {-100, false, true, false},
	} {
		p.historyOffset, p.historyPending, live.frame.Alt = tc.offset, tc.loading, tc.alt
		if err := p.refreshFrame(); err != nil {
			t.Fatal(err)
		}
		footer := ansi.Strip(m.renderFooter())
		if strings.Contains(footer, "Ctrl-] PgUp older") != tc.show || strings.Contains(footer, "Loading older history") != tc.loading {
			t.Fatalf("unexpected history hint: %s", footer)
		}
	}
	p.historyPending = false
	p.api = &apiClient{}
	p.requestHistory() // Alternate-screen input belongs to the application.
	if p.historyPending {
		t.Fatal("history shortcut replaced a live alternate screen")
	}
}
