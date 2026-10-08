package phic

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/hypernewbie/phi/internal/phic/textarea"
)

// Staged native input box. Typing goes straight to the terminal by default;
// Ctrl-] e stages text in this box (Charm bubbles textarea: multiline,
// auto-growing, capped) and Enter sends it to the backend. Send semantics
// mirror web sendStagedInput: bracketed-paste wrap for codex, long, or
// multiline payloads, then a final carriage return.
type composeState struct {
	open bool
	tab  paneKey
	area *textarea.Model
}

// composeMaxLines is the sensible multiline cap: the box grows with content
// up to ten lines or a third of the terminal, whichever is smaller.
func (m *tuiModel) composeMaxLines() int {
	h := m.terminalInner().H
	if h < 1 {
		h = m.height
	}
	return max(1, min(10, h/3))
}

func (m *tuiModel) composeWidth() int {
	w := m.terminalInner().W
	if w < 1 {
		w = m.width
	}
	return max(10, w-2)
}

// openCompose stages input for the active tab. The tab keeps its draft:
// reopening restores unsent text, sending clears it.
func (m *tuiModel) openCompose() tea.Cmd {
	tab := m.activeTabModel()
	if tab == nil || tab.actor == nil {
		m.setStatus("no live terminal to compose for", true)
		return nil
	}
	ta := textarea.New()
	ta.Windowed = true
	ta.Prompt = ""
	ta.ShowLineNumbers = false
	ta.Placeholder = "Type a message, Enter to send…"
	ta.DynamicHeight = true
	ta.MinHeight = 1
	ta.MaxHeight = m.composeMaxLines()
	ta.SetWidth(m.composeWidth())
	ta.SetValue(tab.composeDraft)
	m.compose = composeState{open: true, tab: tab.key, area: &ta}
	return ta.Focus()
}

func (m *tuiModel) closeCompose() {
	if !m.compose.open {
		return
	}
	if tab := m.findTab(m.compose.tab); tab != nil && m.compose.area != nil {
		tab.composeDraft = m.compose.area.Value()
	}
	if m.compose.area != nil {
		m.compose.area.Blur()
	}
	m.compose = composeState{}
	m.focus = focusTerminal
}

// composePayload mirrors web sendStagedInput: long (>16), multiline, or
// codex payloads travel inside bracketed paste so the backend takes them
// verbatim, then a final carriage return submits.
func composePayload(coder, text string) string {
	if coder == "codex" || len(text) > 16 || strings.Contains(text, "\n") {
		text = "\x1b[200~" + text + "\x1b[201~"
	}
	return text + "\r"
}

func (m *tuiModel) sendCompose() {
	tab := m.findTab(m.compose.tab)
	if tab == nil || tab.actor == nil || m.compose.area == nil {
		m.closeCompose()
		return
	}
	text := m.compose.area.Value()
	if strings.TrimSpace(text) == "" {
		return // nothing staged; stay open
	}
	tab.actor.sendRaw([]byte(composePayload(tab.coder, text)))
	m.compose.area.SetValue("")
	m.closeCompose()
}

func (m *tuiModel) handleComposeKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.compose.area == nil {
		m.closeCompose()
		return m, nil
	}
	k := msg.Key()
	switch {
	case k.Code == tea.KeyEscape:
		m.closeCompose()
		return m, nil
	case k.Code == tea.KeyEnter && k.Mod == 0:
		m.sendCompose()
		return m, nil
	case k.Code == tea.KeyEnter && (k.Mod.Contains(tea.ModAlt) || k.Mod.Contains(tea.ModCtrl)):
		m.compose.area.InsertRune('\n')
		return m, nil
	}
	if w := m.composeWidth(); w != m.compose.area.Width() {
		m.compose.area.SetWidth(w)
	}
	next, cmd := m.compose.area.Update(msg)
	m.compose.area = &next
	return m, cmd
}

// forwardComposeMsg feeds non-key messages (cursor blink ticks and friends)
// to the staged box. Keys and pastes arrive through their own handlers so
// Enter-to-send stays intercepted. Unknown messages are ignored by the
// textarea; normal model processing continues afterwards.
func (m *tuiModel) forwardComposeMsg(msg tea.Msg) tea.Cmd {
	if !m.compose.open || m.compose.area == nil {
		return nil
	}
	switch msg.(type) {
	case tea.KeyPressMsg, tea.PasteMsg:
		return nil
	}
	next, cmd := m.compose.area.Update(msg)
	m.compose.area = &next
	return cmd
}

// composeBox builds the staged box bottom-anchored inside the terminal
// panel, returning the content and its screen position. The backend
// geometry never changes: the box overlays the bottom rows while open. It
// renders only for the tab it was opened on with no other modal up.
func (m *tuiModel) composeBox() (box string, x, y int) {
	if !m.compose.open || m.compose.area == nil || m.modal.kind != modalNone {
		return "", 0, 0
	}
	if m.compose.tab != m.activeTabKeyOrZero() {
		return "", 0, 0
	}
	r := m.terminalRect()
	if r.empty() {
		return "", 0, 0
	}
	accent := m.accentColor()
	hint := lg.NewStyle().Foreground(tuiMuted).Render("Enter send · Alt+Enter newline · Esc cancel")
	box = lg.NewStyle().Border(lg.RoundedBorder()).BorderForeground(accent).
		Width(max(12, r.W-2)).Render(m.compose.area.ViewWindow() + "\n" + hint)
	h := lg.Height(box)
	y = r.Y + r.H - h
	if y < r.Y {
		y = r.Y
	}
	return box, r.X + 1, y
}
