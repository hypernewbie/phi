package phic

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/gorilla/websocket"
)

func TestMarkdownModalUsesViewportNotDiffWidthAndHasClickableActions(t *testing.T) {
	m, tab, _ := closeControlsModel(t)
	m.width = 140
	m.height = 40
	m.diff.open = true
	m.diff.markdown = true
	source := "# Title\r\n\tThis is readable prose, not one word per line.  \r\n"
	m.markdown = markdownState{origin: m.currentOrigin(), dir: m.markdownDir(), path: "/work/temp/proposal.md", files: []markdownFile{{Path: "/work/temp/proposal.md", Name: "proposal.md"}}, reading: true, source: source, raw: source}
	m.modal.open(modalMarkdown, "Markdown")
	if m.markdownWidth() != 136 {
		t.Fatal("Markdown still uses the thin Diff width")
	}
	lines, err := renderMarkdownText(source, m.markdownWidth(), m.markdownAccent())
	if err != nil {
		t.Fatal(err)
	}
	m.markdown.lines = lines
	view := ansi.Strip(m.render())
	if !strings.Contains(view, "one word per line") || !strings.Contains(view, "[×]") || !strings.Contains(view, "Copy Markdown") || !strings.Contains(view, "Insert Filename") {
		t.Fatalf("fullscreen controls/content missing: %q", view)
	}
	if len(strings.Split(view, "\n")) != m.height {
		t.Fatal("modal did not fill viewport")
	}
	_, cmd := m.Update(tea.MouseClickMsg{X: 3, Y: 2, Button: tea.MouseLeft})
	if cmd == nil || fmt.Sprintf("%s", cmd()) != source {
		t.Fatal("copy button changed source whitespace")
	}
	tab.actor = &paneActor{ctx: t.Context(), conn: &websocket.Conn{}, inbox: make(chan paneInput, 4)}
	m.Update(tea.MouseClickMsg{X: 23, Y: 2, Button: tea.MouseLeft})
	if m.modal.kind != modalNone || m.focus != focusTerminal {
		t.Fatal("filename button did not type into the terminal")
	}
	select {
	case in := <-tab.actor.inbox:
		if in.Kind != paneInputPaste || string(in.Paste) != "proposal.md" {
			t.Fatalf("filename button typed %+v, want paste proposal.md", in)
		}
	default:
		t.Fatal("filename button sent no terminal input")
	}
	// Hand-rolled actor has no run loop; detach before closeAll cleanup.
	tab.actor = nil
	// The filename action closed the viewer; reopen it for the close-button check.
	m.modal.open(modalMarkdown, "Markdown")
	m.markdown.reading = true
	m.Update(tea.MouseClickMsg{X: m.width - 3, Y: 1, Button: tea.MouseLeft})
	if m.modal.kind != modalNone || m.markdown.reading || m.focus != focusDiff {
		t.Fatal("Unicode close button did not return to file list")
	}
}
func TestEscapeCannotQuitTerminalOrMarkdownAndChromeRequiresConfirmation(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	if _, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape}); cmd != nil {
		t.Fatal("terminal Escape became a client quit command")
	}
	m.modal.open(modalMarkdown, "Markdown")
	m.markdown.reading = true
	_, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if cmd != nil || m.modal.kind != modalNone {
		t.Fatal("Markdown Escape quit instead of closing modal")
	}
	m.focus = focusSessions
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	_, cmd = m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if cmd != nil || m.modal.kind != modalQuit {
		t.Fatal("double chrome Escape did not open confirmation only")
	}
	_, cmd = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd != nil || m.modal.kind != modalNone {
		t.Fatal("Enter default in quit dialog must cancel")
	}
	m.focus = focusSessions
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	_, cmd = m.Update(tea.KeyPressMsg{Code: 'q', Text: "q"})
	if cmd == nil {
		t.Fatal("explicit confirmation did not quit")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("confirmation returned wrong command")
	}
}
func TestSidebarShortcutAndPanelDividerDragUseSameGeometry(t *testing.T) {
	m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
	defer m.closeAll()
	m.width, m.height = 160, 40
	m.diff.open = true
	before, _ := m.terminalSize()
	m.Update(tea.KeyPressMsg{Code: 0x1d})
	m.Update(tea.KeyPressMsg{Code: 'b', Text: "B", Mod: tea.ModShift})
	wider, _ := m.terminalSize()
	if m.showSidebar() || wider <= before {
		t.Fatal("hide shortcut did not release sidebar width")
	}
	m.Update(tea.KeyPressMsg{Code: 0x1d})
	m.Update(tea.KeyPressMsg{Code: 'b', Text: "B", Mod: tea.ModShift})
	m.Update(tea.MouseClickMsg{X: m.sessionPanelWidth() - 1, Y: 5, Button: tea.MouseLeft})
	m.Update(tea.MouseMotionMsg{X: 39, Y: 5, Button: tea.MouseLeft})
	m.Update(tea.MouseReleaseMsg{X: 39, Y: 5, Button: tea.MouseLeft})
	if m.sessionPanelWidth() != 40 || m.panelDrag != 0 {
		t.Fatal("left divider drag did not resize/release")
	}
	old := m.readerPanelWidth()
	x := m.diffRect().X
	m.Update(tea.MouseClickMsg{X: x, Y: 5, Button: tea.MouseLeft})
	m.Update(tea.MouseMotionMsg{X: x - 12, Y: 5, Button: tea.MouseLeft})
	m.Update(tea.MouseReleaseMsg{X: x - 12, Y: 5, Button: tea.MouseLeft})
	if m.readerPanelWidth() != old+12 {
		t.Fatal("right divider drag did not resize")
	}
	c, _ := m.terminalSize()
	if c != m.terminalRect().W-2 || c < 22 {
		t.Fatal("drag left invalid terminal/widget geometry")
	}
	for _, width := range []int{40, 80, 120, 160, 300} {
		m.width = width
		m.resizePanel(true, 10000)
		m.resizePanel(false, 10000)
		c, _ = m.terminalSize()
		if c < 1 {
			t.Fatalf("%d: resized panels consumed terminal", width)
		}
	}
}
func TestEmptyPhiLandingAndCompactChrome(t *testing.T) {
	m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
	defer m.closeAll()
	m.width, m.height = 120, 36
	view := ansi.Strip(m.render())
	for _, text := range []string{"Φ", "Phi", "Terminal Multiplexer for AI Coding Agents", "Ctrl-] n", "[↻]", "▣"} {
		if !strings.Contains(view, text) {
			t.Fatalf("missing %q", text)
		}
	}
	if strings.Contains(view, "TERMINALS") || strings.Contains(view, "switching to") || strings.Contains(view, "signed in") || strings.Contains(view, "Ready to code") || strings.Contains(view, "╭──") {
		t.Fatal("routine verbose chrome remains")
	}
}
