package phic

import (
	tea "charm.land/bubbletea/v2"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"strings"
	"testing"
)

func TestScrollAtLocalBoundaryDoesNotReplaceTheParser(t *testing.T) {
	live := historyReviewTerminal(t)
	defer live.Close()
	p := &paneActor{emu: live, frame: termemu.Frame{History: 10}, historyOffset: -9}
	for range 3 {
		if err := p.handleInput(paneInput{Kind: paneInputScroll, Scroll: -3}); err != nil {
			t.Fatal(err)
		}
	}
	if p.emu != live || p.historyOffset != -10 || len(live.scrolls) != 3 {
		t.Fatal("scroll did not clamp within the local parser")
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
