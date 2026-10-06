package phic

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func closeControlsModel(t *testing.T) (*tuiModel, *paneTab, *atomic.Int32) {
	t.Helper()
	count := new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			count.Add(1)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	m := newModelWithServer(t, srv)
	tab := m.ensureTab(m.currentOrigin(), "p", spawnCapture{title: "Shell", project: "/work", coder: "shell"})
	m.focus = focusTerminal
	t.Cleanup(m.closeAll)
	return m, tab, count
}

func TestCloseControlsDirectPrefixAndUndo(t *testing.T) {
	m, tab, count := closeControlsModel(t)
	m.Update(tea.KeyPressMsg{Code: 0x1d})
	_, cmd := m.Update(tea.KeyPressMsg{Code: 'x', Text: "x"})
	if cmd == nil || !tab.closing {
		t.Fatal("Ctrl-] x did not close the active terminal")
	}
	if count.Load() != 0 {
		t.Fatal("soft close terminated the pane before Undo grace")
	}
	if _, ok := m.activeTabKey(); ok {
		t.Fatal("soft-closed pane still receives active input")
	}
	m.Update(tea.KeyPressMsg{Code: 0x1d})
	m.Update(tea.KeyPressMsg{Code: 'u', Text: "u"})
	if tab.closing || m.activeTabModel() != tab {
		t.Fatal("Ctrl-] u did not restore the same pane")
	}
	if count.Load() != 0 {
		t.Fatal("Undo issued DELETE")
	}
}

func TestCloseControlsVisibleMouseButtons(t *testing.T) {
	m, tab, count := closeControlsModel(t)
	line := ansi.Strip(m.renderTabs())
	at := strings.LastIndex(line, "[x] close")
	if at < 0 {
		t.Fatal("no visible close affordance")
	}
	_, cmd := m.Update(tea.MouseClickMsg{X: ansi.StringWidth(line[:at]) + 1, Y: 2, Button: tea.MouseLeft})
	if cmd == nil || !tab.closing {
		t.Fatal("clicking [x] close did nothing")
	}
	line = ansi.Strip(m.renderTabs())
	at = strings.LastIndex(line, "[u] undo")
	m.Update(tea.MouseClickMsg{X: ansi.StringWidth(line[:at]) + 1, Y: 2, Button: tea.MouseLeft})
	if tab.closing || m.activeTabModel() != tab {
		t.Fatal("clicking [u] undo did nothing")
	}
	if count.Load() != 0 {
		t.Fatal("click/Undo killed the process")
	}
}

func TestCloseControlsTabTitleIsNotAButton(t *testing.T) {
	m, tab, _ := closeControlsModel(t)
	tab.title = "[x] close is my title"
	plain := ansi.Strip(m.renderTabs())
	at := strings.Index(plain, "[x] close")
	m.Update(tea.MouseClickMsg{X: ansi.StringWidth(plain[:at]) + 1, Y: 2, Button: tea.MouseLeft})
	if tab.closing {
		t.Fatal("a button-like tab title terminated the pane")
	}
}
