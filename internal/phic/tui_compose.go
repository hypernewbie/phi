package phic

import (
	"context"
	"strings"
	"time"

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

	// recall is the Pi prompt-history cycler, mirroring the web composer:
	// Up from an empty box walks newest-first entries, Down walks back,
	// and past the newest restores the saved draft. The cache belongs to
	// one pane and one bridge generation; a moved-on Pi refetches.
	recall composeRecall
}

type composeRecall struct {
	entries  []string
	cursor   int // -1 = free-form draft
	draft    string
	loaded   bool
	fetching bool
	pane     string
	gen      uint64
	genOK    bool
}

// recallEligible reports whether the compose tab's pane can serve the Pi
// prompt history. A pane without bridge state stays eligible: the fetch
// itself answers unavailable and the box simply keeps its empty draft.
func (m *tuiModel) recallEligible() bool {
	if !m.compose.open || m.compose.area == nil {
		return false
	}
	tab := m.findTab(m.compose.tab)
	return tab != nil && tab.actor != nil && (tab.coder == "pi" || tab.view.Coder == "pi")
}

// recallGeneration returns the bridge generation the cache is bound to.
func (m *tuiModel) recallGeneration() (uint64, bool) {
	tab := m.findTab(m.compose.tab)
	if tab == nil || tab.bridge == nil {
		return 0, false
	}
	return tab.bridge.generation, true
}

// fetchRecall loads the Pi prompt history for the compose pane. The reply
// is dropped unless the compose box is still open on the same pane.
type composeRecallMsg struct {
	gen         int
	tab         paneKey
	entries     []string
	unavailable bool
}

func (m *tuiModel) fetchRecallCmd() tea.Cmd {
	s := m.serverForOrigin(m.compose.tab.Origin)
	if s == nil || s.api == nil {
		return nil
	}
	api := s.api
	tab := m.compose.tab
	pane := m.compose.tab.ID
	gen := m.gen
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out := composeRecallMsg{gen: gen, tab: tab}
		hist, err := api.BridgePromptHistory(ctx, pane)
		if err != nil {
			out.unavailable = true
			return out
		}
		out.entries = hist.Entries
		out.unavailable = hist.Unavailable
		return out
	}
}

// applyRecallMsg installs one fetch reply when it is still current. The
// press that started the fetch is then replayed once, exactly like the web
// composer's deferred first cycle.
func (m *tuiModel) applyRecallMsg(msg composeRecallMsg) tea.Cmd {
	if msg.gen != m.gen || !m.compose.open || m.compose.tab != msg.tab || !m.compose.recall.fetching {
		return nil
	}
	m.compose.recall.loaded = true
	m.compose.recall.fetching = false
	if msg.unavailable {
		return nil
	}
	m.compose.recall.entries = msg.entries
	if m.compose.area != nil && m.compose.area.Value() == "" {
		m.recallStep(true)
	}
	return nil
}

// recallOlder walks one step into the history; recallNewer walks back out.
// Both return the value the box should show.
func (r *composeRecall) recallOlder(current string) (string, bool) {
	if len(r.entries) == 0 {
		return current, false
	}
	if r.cursor < 0 {
		r.draft = current
	}
	if r.cursor < len(r.entries)-1 {
		r.cursor++
		return r.entries[r.cursor], true
	}
	return current, false
}

func (r *composeRecall) recallNewer(current string) (string, bool) {
	if r.cursor < 0 || len(r.entries) == 0 {
		return current, false
	}
	r.cursor--
	if r.cursor < 0 {
		value := r.draft
		r.draft = ""
		return value, true
	}
	return r.entries[r.cursor], true
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
	if tab.coder == "pi" || tab.view.Coder == "pi" {
		ta.Placeholder = "Type a message, Enter to send · ↑ Pi history"
	}
	ta.DynamicHeight = true
	ta.MinHeight = 1
	ta.MaxHeight = m.composeMaxLines()
	ta.SetWidth(m.composeWidth())
	ta.SetValue(tab.composeDraft)
	m.compose = composeState{open: true, tab: tab.key, area: &ta, recall: composeRecall{cursor: -1, pane: tab.key.ID}}
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
	case k.Code == tea.KeyUp:
		// While a recall cycle is active or the box is empty on a Pi pane,
		// recall owns the key: it never reaches the textarea and never
		// resets the cycle, even parked at the oldest entry.
		if m.compose.recall.cursor >= 0 || (m.recallEligible() && m.compose.area.Value() == "") {
			if cmd := m.composeRecallUp(); cmd != nil {
				return m, cmd
			}
			m.recallStep(true)
			return m, nil
		}
	case k.Code == tea.KeyDown:
		if m.compose.recall.cursor >= 0 {
			m.recallStep(false)
			return m, nil
		}
	}
	if w := m.composeWidth(); w != m.compose.area.Width() {
		m.compose.area.SetWidth(w)
	}
	// Any direct edit ends the recall cycle; the draft stays whatever the
	// box currently shows.
	if m.compose.recall.cursor >= 0 {
		m.compose.recall.cursor = -1
	}
	next, cmd := m.compose.area.Update(msg)
	m.compose.area = &next
	return m, cmd
}

// composeRecallUp serves one Up press from the empty box: it starts the
// fetch when the cache is cold or stale and reports whether the press was
// consumed as a recall action.
func (m *tuiModel) composeRecallUp() tea.Cmd {
	if !m.recallEligible() || m.compose.area.Value() != "" && m.compose.recall.cursor < 0 {
		return nil
	}
	gen, genOK := m.recallGeneration()
	if !m.compose.recall.loaded && !m.compose.recall.fetching ||
		genOK != m.compose.recall.genOK || gen != m.compose.recall.gen {
		m.compose.recall.fetching = true
		m.compose.recall.gen, m.compose.recall.genOK = gen, genOK
		return m.fetchRecallCmd()
	}
	return nil
}

// recallStep applies one cached step and swaps the box value when it moved.
func (m *tuiModel) recallStep(older bool) bool {
	if !m.recallEligible() || m.compose.recall.fetching {
		return false
	}
	var value string
	var moved bool
	if older {
		value, moved = m.compose.recall.recallOlder(m.compose.area.Value())
	} else {
		value, moved = m.compose.recall.recallNewer(m.compose.area.Value())
	}
	if !moved {
		return false
	}
	m.compose.area.SetValue(value)
	m.compose.area.CursorEnd()
	return true
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
