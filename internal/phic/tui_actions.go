package phic

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/hypernewbie/phi/internal/termemu"
)

// sidebarRowKind distinguishes the mixed sidebar list.
type sidebarRowKind int

const (
	rowNewSession sidebarRowKind = iota
	rowSession
	rowLivePane
)

type sidebarRow struct {
	kind    sidebarRowKind
	session Session
	pane    TerminalView
	label   string
}

// sidebarRows builds the Sessions list: New Session, saved sessions for the
// selected coder/project, then live panes that are not attached tabs.
func (m *tuiModel) sidebarRows() []sidebarRow {
	var rows []sidebarRow
	rows = append(rows, sidebarRow{kind: rowNewSession, label: "New Session"})
	d := m.current()
	if d == nil {
		return rows
	}
	query := strings.ToLower(m.sessionSearch.value)
	items := append([]Session{}, d.sessions...)
	sortSessions(items)
	tabIDs := map[string]bool{}
	for _, t := range m.tabs[m.currentOrigin()] {
		tabIDs[t.key.ID] = true
	}
	for _, s := range items {
		if query != "" && !strings.Contains(strings.ToLower(s.Title), query) {
			continue
		}
		rows = append(rows, sidebarRow{kind: rowSession, session: s, label: s.Title})
	}
	for _, p := range d.panes {
		if tabIDs[p.ID] {
			continue
		}
		if !MatchDir(p.Dir, m.project) {
			continue
		}
		label := p.Title
		if label == "" {
			label = p.Coder + " · " + menuLabel(p.Dir)
		}
		if query != "" && !strings.Contains(strings.ToLower(label), query) {
			continue
		}
		rows = append(rows, sidebarRow{kind: rowLivePane, pane: p, label: label})
	}
	return rows
}

// ---- key dispatch ----

func (m *tuiModel) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.compose.open {
		return m.handleComposeKey(msg)
	}
	if m.modal.kind != modalNone {
		return m.handleModalKey(msg)
	}
	if m.prefix {
		return m.handlePrefixKey(msg)
	}
	k := msg.Key()
	if k.Code == tea.KeyEscape && m.focus != focusTerminal && !m.searchActive && !m.diff.searchActive {
		return m.chromeEscape()
	}
	m.chromeEscAt = time.Time{}
	m.chromeEscToken++
	if (k.Code == ']' && k.Mod.Contains(tea.ModCtrl)) || k.Code == 0x1d {
		m.prefix = true
		return m, nil
	}
	if k.Code == tea.KeyTab && m.focus != focusTerminal && m.focus != focusDiff {
		delta := 1
		if k.Mod.Contains(tea.ModShift) {
			delta = -1
		}
		m.cycleFocus(delta)
		return m, nil
	}
	switch m.focus {
	case focusTerminal:
		return m.handleTerminalKey(msg)
	case focusRail:
		return m.handleRailKey(msg)
	case focusSessions:
		return m.handleSessionsKey(msg)
	case focusTabs:
		return m.handleTabsKey(msg)
	case focusDiff:
		return m.handleDiffKey(msg)
	}
	return m, nil
}

func (m *tuiModel) handleKeyRelease(msg tea.KeyReleaseMsg) (tea.Model, tea.Cmd) {
	if m.compose.open || m.modal.kind != modalNone || m.focus != focusTerminal {
		return m, nil
	}
	ev, ok := teaKeyEvent(msg.Key(), termemu.KeyRelease)
	if !ok {
		return m, nil
	}
	if tab := m.activeTabModel(); tab != nil && tab.actor != nil {
		tab.actor.sendKey(ev)
	}
	return m, nil
}

func (m *tuiModel) activeTabModel() *paneTab {
	key, ok := m.activeTabKey()
	if !ok {
		return nil
	}
	return m.findTab(key)
}

// handleTerminalKey forwards everything except the application prefix to the
// backend. Tab, arrows, digits, Escape, and Ctrl-C keep their backend meaning.
func (m *tuiModel) handleTerminalKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.Key()
	// Ctrl-] is either normalized (Code ']' + Ctrl) or still a raw 0x1d
	// control byte on legacy terminals.
	if (k.Code == ']' && k.Mod.Contains(tea.ModCtrl)) || k.Code == 0x1d {
		m.prefix = true
		m.setStatus("prefix: press a command key (Ctrl-] again sends a literal prefix)", false)
		return m, nil
	}
	action := termemu.KeyPress
	if k.IsRepeat {
		action = termemu.KeyRepeat
	}
	ev, ok := teaKeyEvent(k, action)
	if !ok {
		return m, nil
	}
	if tab := m.activeTabModel(); tab != nil && tab.actor != nil {
		tab.actor.sendKey(ev)
	}
	return m, nil
}

// handlePrefixKey performs documented second-key actions. Unknown keys cancel
// the prefix without reaching the backend, so an accidental prefix cannot
// inject bytes.
func chromeKeyCode(k tea.Key) rune {
	// Bubble Tea normalizes ASCII Shift+letter to lowercase Code + ModShift.
	// This applies only to chrome commands, never backend key encoding.
	if k.Mod.Contains(tea.ModShift) && k.Code >= 'a' && k.Code <= 'z' {
		return k.Code - 'a' + 'A'
	}
	return k.Code
}

func (m *tuiModel) handlePrefixKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	m.prefix = false
	k := msg.Key()
	k.Code = chromeKeyCode(k)
	if (k.Code == ']' && k.Mod.Contains(tea.ModCtrl)) || k.Code == 0x1d {
		if tab := m.activeTabModel(); tab != nil && tab.actor != nil {
			tab.actor.sendKey(termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyRune, Text: "\x1d"})
		}
		return m, nil
	}
	if k.Code == tea.KeyEscape {
		return m, nil
	}
	switch k.Code {
	case '1', '2', '3', '4', '5', '6', '7', '8', '9':
		index := int(k.Code - '1')
		if index < len(m.servers) {
			return m, m.switchServer(index)
		}
		return m, nil
	case 'T':
		return m, m.spawnBtop()
	case 'B':
		return m, m.toggleSidebar()
	case 'R':
		return m, m.refreshConsole()
	case 'b':
		m.focus = focusRail
	case 's':
		m.focus = focusSessions
	case 't':
		m.focus = focusTabs
	case 'x':
		if tab := m.activeTabModel(); tab != nil {
			return m, m.closeTab(tab, false)
		}
	case 'u':
		m.undoLastClose()
	case 'd':
		m.diff.open = !m.diff.open
		if m.diff.open {
			m.focus = focusDiff
			return m, tea.Batch(m.refreshDiff(), m.persistIntent())
		}
		m.focus = focusTerminal
		return m, m.persistIntent()
	case 'e':
		return m, m.openCompose()
	case 'M':
		return m, m.showMarkdown()
	case 'h':
		return m, m.openHistory()
	case 'D':
		if tab := m.activeTabModel(); tab != nil && tab.actor != nil {
			tab.actor.close()
			tab.actor = nil
			tab.attached = false
			delete(m.actors, tab.key)
			m.setStatus("detached; the server's normal disconnect grace applies", false)
		}
		return m, nil
	case 'p':
		m.openProjectModal()
	case 'w':
		return m, m.openWorktreeModal()
	case 'c':
		m.openCoderModal()
	case 'n':
		return m, m.newSession()
	case 'S':
		return m, m.spawnForCoder(m.shellCoderID(), false, "")
	case 'o':
		return m, m.spawnForCoder("opencode", true, "")
	case 'm':
		m.openRenameServer()
	case 'a':
		m.openAddServer()
	case 'r':
		return m, m.reloadServersCmd()
	case 'y':
		return m, m.copyActiveText()
	case '?':
		m.openHelp()
	case 'q':
		return m, tea.Quit
	}
	return m, nil
}

func (m *tuiModel) handleRailKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.Key()
	switch k.Code {
	case tea.KeyLeft, 'h':
		if m.active > 0 {
			return m, m.switchServer(m.active - 1)
		}
	case tea.KeyRight, 'l':
		if m.active < len(m.servers)-1 {
			return m, m.switchServer(m.active + 1)
		}
	case tea.KeyEnter:
		return m, m.switchServer(m.active)
	case tea.KeyEscape:
		m.focus = focusTerminal
	case tea.KeyTab:
		m.focus = focusSessions
	case 'a':
		m.openAddServer()
	case 'm':
		m.openRenameServer()
	case 'r':
		return m, m.reloadServersCmd()
	case 'x':
		return m, m.removeActiveServer()
	case 'K':
		if m.active > 0 {
			return m, m.reorderServer(m.active, m.active-1)
		}
	case 'J':
		if m.active < len(m.servers)-1 {
			return m, m.reorderServer(m.active, m.active+2)
		}
	case 'c':
		s := m.currentServer()
		if s != nil {
			return m, tea.SetClipboard(s.profile.Origin)
		}
	case '?':
		m.openHelp()
	}
	return m, nil
}

func (m *tuiModel) handleSessionsKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.Key()
	if !m.searchActive {
		if k.Code == '[' {
			return m, m.resizePanel(true, -4)
		}
		if k.Code == ']' {
			return m, m.resizePanel(true, 4)
		}
	}
	if m.searchActive {
		switch k.Code {
		case tea.KeyEscape:
			m.searchActive = false
		case tea.KeyEnter:
			m.searchActive = false
			m.sessionCursor = 0
		case tea.KeyBackspace:
			m.sessionSearch.backspace()
			m.sessionCursor = 0
		case tea.KeyLeft:
			m.sessionSearch.left()
		case tea.KeyRight:
			m.sessionSearch.right()
		default:
			if k.Text != "" {
				m.sessionSearch.insert(k.Text)
				m.sessionCursor = 0
			}
		}
		return m, nil
	}
	rows := m.sidebarRows()
	switch k.Code {
	case tea.KeyUp, 'k':
		if m.sessionCursor > 0 {
			m.sessionCursor--
		}
	case tea.KeyDown, 'j':
		if m.sessionCursor < len(rows)-1 {
			m.sessionCursor++
		}
	case tea.KeyEnter:
		if m.sessionCursor >= 0 && m.sessionCursor < len(rows) {
			return m, m.activateSidebarRow(rows[m.sessionCursor])
		}
	case '/':
		m.searchActive = true
	case tea.KeyEscape:
		m.focus = focusTerminal
	case tea.KeyTab:
		m.focus = focusTabs
	case 'n':
		return m, m.newSession()
	case 'c':
		m.openCoderModal()
	case 'p':
		m.openProjectModal()
	case 'w':
		return m, m.openWorktreeModal()
	case 'r':
		d := m.current()
		if d != nil {
			d.sessionsCoder = ""
		}
		return m, m.refreshSessions()
	case '?':
		m.openHelp()
	}
	return m, nil
}

func (m *tuiModel) activateSidebarRow(row sidebarRow) tea.Cmd {
	switch row.kind {
	case rowNewSession:
		return m.newSession()
	case rowSession:
		return m.resumeSession(row.session)
	case rowLivePane:
		p := row.pane
		origin := m.currentOrigin()
		tab := m.ensureTab(origin, p.ID, spawnCapture{
			origin: origin, index: m.active, project: p.Dir, coder: p.Coder, title: p.Title,
		})
		tab.view = p
		tab.title = p.Title
		tab.coder = p.Coder
		tab.dir = p.Dir
		m.activateTab(origin, tab)
		m.focus = focusTerminal
		return m.persistIntent()
	}
	return nil
}

func (m *tuiModel) handleTabsKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	origin := m.currentOrigin()
	tabs := m.tabs[origin]
	k := msg.Key()
	k.Code = chromeKeyCode(k)
	switch k.Code {
	case tea.KeyLeft, 'h':
		if m.activeTab[origin] > 0 {
			m.activeTab[origin]--
			m.activateCurrentTab()
		}
	case tea.KeyRight, 'l':
		if m.activeTab[origin] < len(tabs)-1 {
			m.activeTab[origin]++
			m.activateCurrentTab()
		}
	case tea.KeyEnter:
		m.activateCurrentTab()
		m.focus = focusTerminal
	case tea.KeyEscape:
		m.focus = focusTerminal
	case tea.KeyTab:
		if m.diff.open {
			m.focus = focusDiff
		} else {
			m.focus = focusTerminal
		}
	case 'x':
		if tab := m.activeTabModel(); tab != nil {
			return m, m.closeTab(tab, false)
		}
	case 'X':
		if tab := m.activeTabModel(); tab != nil {
			return m, m.closeTab(tab, true)
		}
	case 'u':
		m.undoLastClose()
	case 'r':
		m.openRenamePane()
	case 'p':
		if tab := m.activeTabModel(); tab != nil {
			pinned := !tab.view.Pinned
			id := tab.key.ID
			status := "unpinned"
			if pinned {
				status = "pinned"
			}
			return m, m.paneActionCmd(tab.key, status, func(ctx context.Context, api *apiClient) error {
				return api.SetPanePinned(ctx, id, pinned)
			})
		}
	case 'm':
		if tab := m.activeTabModel(); tab != nil {
			marked := !tab.view.Marked
			id := tab.key.ID
			status := "unmarked"
			if marked {
				status = "marked"
			}
			return m, m.paneActionCmd(tab.key, status, func(ctx context.Context, api *apiClient) error {
				return api.SetPaneMarked(ctx, id, marked)
			})
		}
	case 'n':
		return m, m.newSession()
	}
	return m, nil
}

func (m *tuiModel) handleDiffKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.diff.markdown {
		return m.handleMarkdownKey(msg)
	}
	k := msg.Key()
	k.Code = chromeKeyCode(k)
	if !m.diff.searchActive {
		if k.Code == '[' {
			return m, m.resizePanel(false, -4)
		}
		if k.Code == ']' {
			return m, m.resizePanel(false, 4)
		}
	}
	if m.diff.searchActive {
		switch k.Code {
		case tea.KeyEscape:
			m.diff.searchActive = false
		case tea.KeyEnter:
			m.diff.searchActive = false
		case tea.KeyBackspace:
			m.diff.search.backspace()
			m.diff.recomputeMatches()
		case tea.KeyLeft:
			m.diff.search.left()
		case tea.KeyRight:
			m.diff.search.right()
		default:
			if k.Text != "" {
				m.diff.search.insert(k.Text)
				m.diff.recomputeMatches()
			}
		}
		return m, nil
	}
	switch k.Code {
	case tea.KeyUp, 'k':
		if m.diff.scroll > 0 {
			m.diff.scroll--
		}
	case tea.KeyDown, 'j':
		if m.diff.scroll < len(m.diff.lines)-1 {
			m.diff.scroll++
		}
	case tea.KeyPgUp:
		m.diff.scroll = max(0, m.diff.scroll-10)
	case tea.KeyPgDown:
		m.diff.scroll = min(max(0, len(m.diff.lines)-1), m.diff.scroll+10)
	case tea.KeyHome:
		m.diff.scroll = 0
	case tea.KeyEnd:
		m.diff.scroll = max(0, len(m.diff.lines)-1)
	case 'm', tea.KeyTab:
		return m, m.showMarkdown()
	case 'r':
		return m, m.refreshDiff()
	case '/':
		m.diff.searchActive = true
	case 'n':
		m.diff.nextMatch(1)
	case 'N':
		m.diff.nextMatch(-1)
	case 'y':
		if m.diff.text != "" {
			return m, tea.SetClipboard(m.diff.text)
		}
	case tea.KeyEscape:
		m.focus = focusTerminal
	case 'd':
		m.diff.open = false
		m.focus = focusTerminal
		return m, m.persistIntent()
	}
	return m, nil
}

// ---- modal input ----

func (m *tuiModel) handleModalKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.modal.kind == modalMarkdown {
		return m.handleMarkdownModalKey(msg)
	}
	if m.modal.kind == modalQuit {
		return m.handleQuitKey(msg)
	}
	k := msg.Key()
	if m.modal.kind == modalHistory {
		switch k.Code {
		case tea.KeyUp, 'k':
			if m.history.scroll > 0 {
				m.history.scroll--
			}
		case tea.KeyDown, 'j':
			if m.history.scroll < len(m.history.lines)-1 {
				m.history.scroll++
			}
		case '[':
			if m.history.start > 0 {
				return m, m.historyPage(m.history.start)
			}
		case ']':
			if m.history.end < m.history.head {
				return m, m.historyPage(min(m.history.head, m.history.end+historyWindowBytes))
			}
		case 'x':
			m.toggleHistoryHex()
		case tea.KeyPgUp:
			m.history.scroll = max(0, m.history.scroll-10)
		case tea.KeyPgDown:
			m.history.scroll = min(max(0, len(m.history.lines)-1), m.history.scroll+10)
		case tea.KeyEscape, 'q':
			m.history.open = false
			m.closeModal()
		case 'y':
			if m.history.text != "" {
				return m, tea.SetClipboard(m.history.text)
			}
		}
		return m, nil
	}
	if m.modal.kind == modalHelp {
		m.closeModal()
		return m, nil
	}
	if k.Code == tea.KeyEscape {
		m.closeModal()
		return m, nil
	}
	if m.modal.busy {
		return m, nil
	}
	if k.Mod.Contains(tea.ModCtrl) {
		switch k.Code {
		case 'u':
			m.modal.field = textField{}
			return m, nil
		case 'a':
			m.modal.field.home()
			return m, nil
		case 'e':
			m.modal.field.end()
			return m, nil
		}
	}
	switch k.Code {
	case tea.KeyEnter:
		return m.submitModal()
	case tea.KeyTab:
		if len(m.modal.items) > 0 {
			m.modal.cursor = (m.modal.cursor + 1) % len(m.modal.items)
		}
		return m, nil
	case tea.KeyUp:
		if len(m.modal.items) > 0 && m.modal.cursor > 0 {
			m.modal.cursor--
		}
		return m, nil
	case tea.KeyDown:
		if len(m.modal.items) > 0 && m.modal.cursor < len(m.modal.items)-1 {
			m.modal.cursor++
		}
		return m, nil
	case tea.KeyLeft:
		m.modal.field.left()
		return m, nil
	case tea.KeyRight:
		m.modal.field.right()
		return m, nil
	case tea.KeyHome:
		m.modal.field.home()
		return m, nil
	case tea.KeyEnd:
		m.modal.field.end()
		return m, nil
	case tea.KeyBackspace:
		m.modal.field.backspace()
		return m, nil
	case tea.KeyDelete:
		m.modal.field.deleteForward()
		return m, nil
	}
	if k.Text != "" && (m.modal.kind == modalAddServer || m.modal.kind == modalRenameServer || m.modal.kind == modalRenamePane || m.modal.kind == modalPassword || m.modal.kind == modalProject) {
		m.modal.field.insert(k.Text)
		if m.modal.kind == modalProject {
			m.modal.cursor = -1
		}
	}
	return m, nil
}

func (m *tuiModel) submitModal() (tea.Model, tea.Cmd) {
	switch m.modal.kind {
	case modalAddServer:
		raw := strings.TrimSpace(m.modal.field.value)
		if raw == "" {
			m.modal.err = "enter at least one server URL"
			return m, nil
		}
		return m, m.addServerCmd(raw)
	case modalRenameServer:
		s := m.currentServer()
		if s == nil {
			m.closeModal()
			return m, nil
		}
		name := strings.TrimSpace(m.modal.field.value)
		return m, m.storeOpCmd(func(store *desktopStore) (string, error) {
			if err := store.rename(s.profile.ID, name); err != nil {
				return "", err
			}
			return "renamed server", nil
		}, true)
	case modalRenamePane:
		tab := m.activeTabModel()
		if tab == nil {
			m.closeModal()
			return m, nil
		}
		id := tab.key.ID
		title := strings.TrimSpace(m.modal.field.value)
		return m, m.paneActionCmd(tab.key, "renamed tab", func(ctx context.Context, api *apiClient) error {
			return api.SetPaneTitle(ctx, id, title)
		})
	case modalPassword:
		status := m.modal.auth
		index := m.modal.index
		password := m.modal.field.value
		m.modal.field = textField{}
		m.modal.busy = true
		return m, m.loginCmd(index, status, password)
	case modalProject:
		value := strings.TrimSpace(m.modal.field.value)
		if m.modal.cursor >= 0 && m.modal.cursor < len(m.modal.items) {
			value = m.modal.items[m.modal.cursor].value
		}
		if value == "" {
			m.modal.err = "choose a project or enter an absolute server path"
			return m, nil
		}
		if !serverAbsolutePath(value) {
			m.modal.err = "enter an absolute server path"
			return m, nil
		}
		m.project = value
		m.worktree = ""
		m.finishContextSelection()
		m.setStatus("project: "+menuLabel(value), false)
		return m, tea.Batch(m.refreshSessions(), m.persistIntent(), m.refreshDiff())
	case modalWorktree:
		if m.modal.cursor >= 0 && m.modal.cursor < len(m.modal.items) {
			m.worktree = m.modal.items[m.modal.cursor].value
			m.setStatus("worktree: "+menuLabel(m.worktree), false)
		}
		m.finishContextSelection()
		return m, tea.Batch(m.persistIntent(), m.refreshSessions(), m.refreshDiff())
	case modalOpenCode:
		mini := m.modal.cursor >= 0 && m.modal.cursor < len(m.modal.items) &&
			m.modal.items[m.modal.cursor].value == "mini"
		m.closeModal()
		m.focus = focusTerminal
		return m, m.spawnForCoder("opencode", mini, "")
	case modalCoder:
		if m.modal.cursor >= 0 && m.modal.cursor < len(m.modal.items) {
			m.coderIdx = m.modal.cursor
			d := m.current()
			if d != nil {
				d.coderID = m.selectedCoderID()
				d.sessionsCoder = ""
			}
		}
		m.finishContextSelection()
		return m, tea.Batch(m.refreshSessions(), m.persistIntent())
	}
	m.closeModal()
	return m, nil
}

// ---- paste and mouse ----

func (m *tuiModel) handlePaste(msg tea.PasteMsg) (tea.Model, tea.Cmd) {
	if m.compose.open && m.compose.area != nil {
		next, cmd := m.compose.area.Update(msg)
		m.compose.area = &next
		return m, cmd
	}
	if m.modal.kind != modalNone {
		switch m.modal.kind {
		case modalAddServer, modalRenameServer, modalRenamePane, modalPassword, modalProject:
			m.modal.field.insert(msg.Content)
			if m.modal.kind == modalProject {
				m.modal.cursor = -1
			}
		}
		return m, nil
	}
	if m.searchActive {
		m.sessionSearch.insert(msg.Content)
		return m, nil
	}
	if m.focus == focusDiff && !m.diff.markdown && m.diff.searchActive {
		m.diff.search.insert(msg.Content)
		m.diff.recomputeMatches()
		return m, nil
	}
	if m.focus == focusTerminal {
		if tab := m.activeTabModel(); tab != nil && tab.actor != nil {
			tab.actor.sendPaste([]byte(msg.Content))
		}
	}
	return m, nil
}

// openCodeScrollHack mirrors web isOpenCodeMini (web/terminal.js wheel and
// touch handlers): legacy and v2-full OpenCode run a full-screen TUI that
// scrolls via injected ESC Ctrl-Y (up) / ESC Ctrl-E (down) navigation keys,
// while Mini uses normal scrollback. Like the web capture-phase handler,
// the hack wins over backend mouse forwarding for these tabs.
func openCodeScrollHack(tab *paneTab) bool {
	if tab == nil {
		return false
	}
	coder := tab.coder
	if coder == "" {
		coder = tab.view.Coder
	}
	return coder == "opencode" && tab.view.OpenCodeMode != "mini"
}

// openCodeScrollKeys repeats the web's per-line scroll sequence to match a
// standard wheel notch: the web scales |deltaY|/40 clamped 1..8, and a
// notch is ~100, so one notch is three lines.
func openCodeScrollKeys(down bool) string {
	seq := "\x1b\x19"
	if down {
		seq = "\x1b\x05"
	}
	return strings.Repeat(seq, 3)
}

func (m *tuiModel) handleMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if m.modal.kind == modalMarkdown {
		return m.handleMarkdownModalMouse(msg)
	}
	if m.modal.kind == modalQuit {
		mouse := msg.Mouse()
		if _, ok := msg.(tea.MouseClickMsg); ok && mouse.Button == tea.MouseLeft {
			return m.handleQuitMouse(mouse.X, mouse.Y)
		}
		return m, nil
	}
	mouse := msg.Mouse()
	if m.compose.open {
		return m, nil
	}
	if m.modal.kind != modalNone {
		return m, nil
	}
	if handled, cmd := m.handlePanelDrag(msg); handled {
		return m, cmd
	}
	inner := m.terminalInner()
	inTerminal := mouse.X >= inner.X && mouse.X < inner.X+inner.W &&
		mouse.Y >= inner.Y && mouse.Y < inner.Y+inner.H

	switch mouse.Button {
	case tea.MouseWheelUp, tea.MouseWheelDown:
		if r := m.diffRect(); !r.empty() && mouse.X >= r.X && mouse.X < r.X+r.W && mouse.Y >= r.Y && mouse.Y < r.Y+r.H {
			m.focus = focusDiff
			delta := -3
			if mouse.Button == tea.MouseWheelDown {
				delta = 3
			}
			if m.diff.markdown {
				if m.markdown.reading {
					m.markdown.scroll = max(0, min(len(m.markdown.lines)-1, m.markdown.scroll+delta))
				} else {
					m.markdown.cursor = max(0, min(len(m.markdown.files)-1, m.markdown.cursor+delta))
				}
			} else {
				m.diff.scroll = max(0, min(len(m.diff.lines)-1, m.diff.scroll+delta))
			}
			return m, nil
		}
		if inTerminal {
			tab := m.activeTabModel()
			if tab != nil && tab.actor != nil && tab.actor.getConn() != nil && openCodeScrollHack(tab) {
				tab.actor.sendRaw([]byte(openCodeScrollKeys(mouse.Button == tea.MouseWheelDown)))
			} else if tab != nil && tab.actor != nil && tab.actor.mouseOwned() {
				action := termemu.MouseWheelUp
				if mouse.Button == tea.MouseWheelDown {
					action = termemu.MouseWheelDown
				}
				tab.actor.sendMouse(action, termemu.MouseNone, teaMods(mouse.Mod), mouse.X-inner.X, mouse.Y-inner.Y)
			} else if tab != nil && tab.actor != nil {
				delta := -3
				if mouse.Button == tea.MouseWheelDown {
					delta = 3
				}
				tab.actor.scroll(delta)
			}
		}
		return m, nil
	}

	if _, isMotion := msg.(tea.MouseMotionMsg); isMotion {
		if m.mouseCapture || (inTerminal && !m.selection.active) {
			if tab := m.activeTabModel(); tab != nil && tab.actor != nil && tab.actor.mouseOwned() {
				tab.actor.sendMouse(termemu.MouseMotion, m.mouseButton, teaMods(mouse.Mod), mouse.X-inner.X, mouse.Y-inner.Y)
			}
		}
		if m.selection.active {
			m.selection.end = cellPos{X: mouse.X - inner.X, Y: mouse.Y - inner.Y}
			return m, nil
		}
		return m, nil
	}
	if _, isRelease := msg.(tea.MouseReleaseMsg); isRelease {
		if m.mouseCapture {
			if tab := m.activeTabModel(); tab != nil && tab.actor != nil {
				tab.actor.sendMouse(termemu.MouseRelease, m.mouseButton, teaMods(mouse.Mod), mouse.X-inner.X, mouse.Y-inner.Y)
			}
			m.mouseCapture = false
		}
		if m.selection.active {
			m.selection.end = cellPos{X: mouse.X - inner.X, Y: mouse.Y - inner.Y}
			text := m.selectionText()
			m.selection = selectionState{}
			if text != "" {
				m.setStatus(fmt.Sprintf("copy requested for %d characters", len([]rune(text))), false)
				return m, tea.SetClipboard(text)
			}
			return m, nil
		}
		return m, nil
	}
	if _, isClick := msg.(tea.MouseClickMsg); !isClick {
		return m, nil
	}

	switch {
	case mouse.Y == 0:
		plain := ansi.Strip(m.renderRail())
		if at := strings.LastIndex(plain, "[▥]"); at >= 0 && mouse.X >= ansi.StringWidth(plain[:at]) && mouse.X < ansi.StringWidth(plain[:at])+3 {
			return m, m.spawnBtop()
		}
		if at := strings.LastIndex(plain, "[↻]"); at >= 0 && mouse.X >= ansi.StringWidth(plain[:at]) && mouse.X < ansi.StringWidth(plain[:at])+3 {
			return m, m.refreshConsole()
		}
		if at := strings.Index(plain, "[+]"); at >= 0 && mouse.X >= ansi.StringWidth(plain[:at]) && mouse.X < ansi.StringWidth(plain[:at])+3 {
			m.openAddServer()
			return m, nil
		}
		m.focus = focusRail
		if index, ok := m.railHit(mouse.X); ok {
			return m, m.switchServer(index)
		}
		return m, nil
	case mouse.Y == 1:
		plain := ansi.Strip(m.renderContext())
		if at := strings.Index(plain, "[n]"); at >= 0 && mouse.X >= ansi.StringWidth(plain[:at]) && mouse.X < ansi.StringWidth(plain[:at])+len("[n] New Session") {
			return m, m.newSession()
		}
		if at := strings.Index(plain, "[w]"); at >= 0 && mouse.X >= max(0, ansi.StringWidth(plain[:at])-15) && mouse.X <= ansi.StringWidth(plain[:at])+3 {
			return m, m.openWorktreeModal()
		}
		if mouse.X >= m.width-10 {
			m.diff.open = !m.diff.open
			if m.diff.open {
				return m, tea.Batch(m.refreshDiff(), m.persistIntent())
			}
			return m, m.persistIntent()
		}
		if mouse.X < m.width/3 {
			m.openProjectModal()
		} else if mouse.X < (2*m.width)/3 {
			m.openCoderModal()
		}
		return m, nil
	case mouse.Y == 2:
		if mouse.Button == tea.MouseLeft {
			switch m.tabControlHit(mouse.X) {
			case "close":
				if tab := m.activeTabModel(); tab != nil {
					return m, m.closeTab(tab, false)
				}
				return m, nil
			case "undo":
				m.undoLastClose()
				return m, nil
			}
		}
		m.focus = focusTabs
		if index, ok := m.tabHit(mouse.X); ok {
			m.activeTab[m.currentOrigin()] = index
			m.activateCurrentTab()
			m.focus = focusTerminal
		}
		return m, nil
	case mouse.Y == m.height-1:
		return m, nil
	}

	if (m.showSidebar() || (!m.showSidebar() && m.focus == focusSessions)) && mouse.X < m.sessionPanelWidth() {
		m.focus = focusSessions
		row := mouse.Y - 6 + m.sidebarStart() // border, heading, blank row
		rows := m.sidebarRows()
		if row >= 0 && row < len(rows) {
			m.sessionCursor = row
			return m, m.activateSidebarRow(rows[row])
		}
		return m, nil
	}
	if r := m.diffRect(); !r.empty() && mouse.X >= r.X {
		m.focus = focusDiff
		if mouse.Button == tea.MouseLeft {
			return m.handleReaderClick(mouse.X, mouse.Y)
		}
		return m, nil
	}
	if inTerminal {
		m.focus = focusTerminal
		tab := m.activeTabModel()
		if tab == nil || tab.actor == nil {
			return m, nil
		}
		if tab.actor.mouseOwned() && !mouse.Mod.Contains(tea.ModShift) {
			button := termemu.MouseLeft
			if mouse.Button == tea.MouseRight {
				button = termemu.MouseRight
			}
			if mouse.Button == tea.MouseMiddle {
				button = termemu.MouseMiddle
			}
			m.mouseCapture, m.mouseButton = true, button
			tab.actor.sendMouse(termemu.MousePress, button, teaMods(mouse.Mod), mouse.X-inner.X, mouse.Y-inner.Y)
			return m, nil
		}
		m.selection = selectionState{active: true, start: cellPos{X: mouse.X - inner.X, Y: mouse.Y - inner.Y}, end: cellPos{X: mouse.X - inner.X, Y: mouse.Y - inner.Y}}
		return m, nil
	}
	return m, nil
}

// Hit only the rendered suffix, never a button-like string inside a tab title.
func (m *tuiModel) tabControlHit(x int) string {
	plain := ansi.Strip(m.renderTabs())
	at := strings.LastIndex(plain, tabControls)
	if at < 0 || x < 0 || x >= m.width {
		return ""
	}
	start := ansi.StringWidth(plain[:at])
	if x >= start+1 && x < start+1+len("[x] close") {
		return "close"
	}
	undo := start + len(" [x] close  ")
	if x >= undo && x < undo+len("[u] undo") {
		return "undo"
	}
	return ""
}

func (m *tuiModel) undoLastClose() {
	var latest *paneTab
	for _, tab := range m.tabs[m.currentOrigin()] {
		if tab.closing && (latest == nil || tab.closeAt.After(latest.closeAt)) {
			latest = tab
		}
	}
	if latest != nil {
		m.undoClose(latest)
	}
}

func (m *tuiModel) railHit(x int) (int, bool) {
	offset := 3 // " Φ "
	glyphs := serverGlyphs(m.servers)
	for i, s := range m.servers {
		label := " " + glyphs[i] + " " + m.railLabel(s) + " "
		w := ansi.StringWidth(label)
		if x >= offset && x < offset+w {
			return i, true
		}
		offset += w
	}
	return 0, false
}

func (m *tuiModel) tabHit(x int) (int, bool) {
	tabs := m.tabs[m.currentOrigin()]
	if len(tabs) == 0 {
		return 0, false
	}
	active := m.activeTab[m.currentOrigin()]
	if active < 0 || active >= len(tabs) {
		active = 0
	}
	widths := make([]int, len(tabs))
	total := 0
	for i, t := range tabs {
		title := m.tabTitle(t)
		label := " ● " + title + " "
		if t.unread && i != active {
			label = " ● " + title + "• "
		}
		if t.view.Pinned {
			label = " ● " + title + " ⌂ "
		}
		widths[i] = ansi.StringWidth(label)
		total += widths[i]
	}
	avail := m.width - ansi.StringWidth(" TERMINALS ") - ansi.StringWidth(" [x] close  [u] undo") - 6
	start, end := 0, len(tabs)
	if total > avail {
		start, end = active, active+1
		used := widths[active]
		for end < len(tabs) && used+widths[end] <= avail-4 {
			used += widths[end]
			end++
		}
		for start > 0 && used+widths[start-1] <= avail-4 {
			start--
			used += widths[start]
		}
	}
	offset := ansi.StringWidth(" TERMINALS ")
	if start > 0 {
		offset += ansi.StringWidth(fmt.Sprintf("+%d ", start))
	}
	for i := start; i < end; i++ {
		if x >= offset && x < offset+widths[i] {
			return i, true
		}
		offset += widths[i]
	}
	return 0, false
}

type cellPos struct{ X, Y int }

type selectionState struct {
	active bool
	start  cellPos
	end    cellPos
}

func (m *tuiModel) selectionText() string {
	tab := m.activeTabModel()
	if tab == nil || tab.actor == nil {
		return ""
	}
	frame, ok := tab.actor.snapshotCopy()
	if !ok {
		return ""
	}
	s, e := m.selection.start, m.selection.end
	if s.Y > e.Y || (s.Y == e.Y && s.X > e.X) {
		s, e = e, s
	}
	var b strings.Builder
	for y := s.Y; y <= e.Y && y < len(frame.Cells); y++ {
		if y < 0 {
			continue
		}
		row := frame.Cells[y]
		x0, x1 := 0, len(row)-1
		if y == s.Y {
			x0 = max(0, s.X)
		}
		if y == e.Y {
			x1 = min(len(row)-1, e.X)
		}
		for x := x0; x <= x1 && x < len(row); x++ {
			if x < 0 {
				continue
			}
			c := row[x]
			if c.Width == 0 {
				continue
			}
			if c.Text == "" {
				b.WriteByte(' ')
			} else {
				b.WriteString(c.Text)
			}
		}
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *tuiModel) copyActiveText() tea.Cmd {
	if m.focus == focusDiff {
		if m.diff.markdown {
			return nil
		}
		if m.diff.text != "" {
			return tea.SetClipboard(m.diff.text)
		}
	}
	if text := m.selectionText(); text != "" {
		return tea.SetClipboard(text)
	}
	if tab := m.activeTabModel(); tab != nil && tab.actor != nil {
		if frame, ok := tab.actor.snapshotCopy(); ok {
			var b strings.Builder
			for _, row := range frame.Cells {
				for _, c := range row {
					if c.Width == 0 {
						continue
					}
					if c.Text == "" {
						b.WriteByte(' ')
					} else {
						b.WriteString(c.Text)
					}
				}
				b.WriteByte('\n')
			}
			return tea.SetClipboard(strings.TrimRight(b.String(), "\n"))
		}
	}
	return nil
}

// ---- actions ----

func (m *tuiModel) activateCurrentTab() {
	key, ok := m.activeTabKey()
	if !ok {
		return
	}
	tab := m.findTab(key)
	if tab == nil {
		return
	}
	m.activateTab(m.currentOrigin(), tab)
}

func (m *tuiModel) cycleFocus(delta int) {
	order := []focusRegion{focusTerminal, focusRail, focusSessions, focusTabs}
	if m.diff.open {
		order = append(order, focusDiff)
	}
	index := 0
	for i, f := range order {
		if f == m.focus {
			index = i
			break
		}
	}
	index = (index + delta + len(order)) % len(order)
	m.focus = order[index]
}

func (m *tuiModel) switchServer(index int) tea.Cmd {
	if index < 0 || index >= len(m.servers) {
		return nil
	}
	if m.active == index {
		m.focus = focusTerminal
		if d := m.current(); d != nil && d.needAuth {
			m.openPassword(index, d.auth)
			return nil
		}
		if d := m.current(); d == nil || d.err != "" || !d.loaded {
			return m.loadServerCmd(index)
		}
		m.activateCurrentTab()
		// Opening a server is also an explicit live-pane refresh.
		return m.loadServerCmd(index)
	}
	persist := m.persistIntent()
	if d := m.current(); d != nil {
		d.project, d.worktree, d.coderID = m.project, m.worktree, m.selectedCoderID()
	}
	m.gen++
	m.active = index
	m.project, m.worktree = "", ""
	if d := m.current(); d != nil {
		m.project, m.worktree = d.project, d.worktree
	}
	m.quitOnce = false
	m.focus = focusTerminal
	m.diff = diffState{open: m.diff.open, markdown: m.diff.markdown}
	m.markdown = markdownState{}
	m.coderIdx = 0
	m.sessionCursor = 0
	m.sessionSearch = textField{}
	origin := m.originFor(index)
	if origin != "" && m.data[origin] == nil {
		m.data[origin] = &serverData{}
	}
	m.restoreCoderSelection()
	m.setStatus("", false)
	cmds := []tea.Cmd{persist, m.loadServerCmd(index)}
	if s := m.servers[index]; s != nil {
		cmds = append(cmds, m.touchLastUsed(s.profile.ID))
	}
	return tea.Batch(cmds...)
}

func (m *tuiModel) touchLastUsed(id string) tea.Cmd {
	store := m.store
	if store == nil || id == "" {
		return nil
	}
	return func() tea.Msg {
		if err := store.setLastUsed(id); err != nil {
			return storeDoneMsg{err: "update last-used: " + err.Error()}
		}
		return nil
	}
}

func (m *tuiModel) newSession() tea.Cmd {
	coder := m.selectedCoderID()
	if coder == "" {
		m.setStatus("no coder is advertised by this server", true)
		return nil
	}
	if coder == "opencode" {
		m.openOpenCodeModal()
		return nil
	}
	return m.spawnForCoder(coder, false, "")
}

// openOpenCodeModal offers the per-launch Open/Open Mini choice. Full TUI
// stays the default (cursor starts on Open); Mini is an explicit opt-in
// whose mode the tab then retains.
func (m *tuiModel) openOpenCodeModal() {
	m.modal.open(modalOpenCode, "OpenCode")
	m.modal.items = []modalItem{{label: "Open", value: "full"}, {label: "Open Mini", value: "mini"}}
	m.modal.cursor = 0
}

// shellCoderID resolves the server's advertised shell backend. The literal
// "shell" is only a fallback for servers that omit the descriptor flag.
func (m *tuiModel) shellCoderID() string {
	if d := m.current(); d != nil {
		for _, c := range d.coders {
			if c.IsShell {
				return c.ID
			}
		}
	}
	return "shell"
}

// paneActionCmd runs one metadata mutation against the pane's captured origin
// and refreshes the pane list afterward.
func (m *tuiModel) paneActionCmd(key paneKey, status string, fn func(ctx context.Context, api *apiClient) error) tea.Cmd {
	gen := m.gen
	s := m.serverForOrigin(key.Origin)
	return func() tea.Msg {
		out := paneActionDoneMsg{gen: gen, status: status}
		if s == nil {
			out.err = "the pane origin is no longer available"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := fn(ctx, s.api); err != nil {
			out.err = err.Error()
		}
		return out
	}
}

// spawnForCoder captures origin, project, worktree, coder, presentation, and
// widget geometry at activation. One POST creates a fresh pane with an empty
// resume identity.
func (m *tuiModel) spawnForCoder(coder string, mini bool, sessionID string, titles ...string) tea.Cmd {
	origin := m.currentOrigin()
	if origin == "" {
		m.setStatus("select a server first", true)
		return nil
	}
	if m.pendingSpawn[origin] {
		m.setStatus("a spawn is already pending for this server", false)
		return nil
	}
	s := m.currentServer()
	if s == nil || s.api == nil {
		m.setStatus("select a server first", true)
		return nil
	}
	if m.project == "" {
		m.setStatus("choose a project before creating a session", true)
		m.openProjectModal()
		return nil
	}
	cols, rows := m.terminalSize()
	cap := spawnCapture{
		origin:    origin,
		index:     m.active,
		project:   m.project,
		worktree:  m.worktree,
		coder:     coder,
		mini:      mini,
		sessionID: sessionID,
		cols:      cols,
		rows:      rows,
	}
	if len(titles) > 0 {
		cap.title = titles[0]
	} else if sessionID == "" {
		name := coder
		if d := m.current(); d != nil {
			for _, c := range d.coders {
				if c.ID == coder {
					name = c.Name
					break
				}
			}
		}
		cap.title = "+ " + name
	}
	m.pendingSpawn[origin] = true
	return m.spawnCmd(cap)
}

// resumeSession sends the exact saved-session identity. It never guesses a
// missing session or falls back to --last.
func (m *tuiModel) resumeSession(s Session) tea.Cmd {
	coder := s.Coder
	if coder == "" {
		coder = m.selectedCoderID()
	}
	resumeID := s.ID
	if s.SessionPath != "" {
		resumeID = s.SessionPath
	}
	if resumeID == "" {
		m.setStatus("saved session has no resume identity", true)
		return nil
	}
	return m.spawnForCoder(coder, false, resumeID, s.Title)
}

// openPaneDirect implements --pane: attach the exact pane without a project,
// coder, or session picker.
func (m *tuiModel) openPaneDirect(id string) tea.Cmd {
	d := m.current()
	if d == nil {
		return nil
	}
	for _, p := range d.panes {
		if p.ID == id {
			origin := m.currentOrigin()
			tab := m.ensureTab(origin, p.ID, spawnCapture{
				origin: origin, index: m.active, project: p.Dir, coder: p.Coder, title: p.Title,
			})
			tab.view = p
			m.activateTab(origin, tab)
			m.focus = focusTerminal
			return nil
		}
	}
	m.setStatus("pane is not live: "+QuotedID(id), true)
	return nil
}

// ---- shared-store operations ----

func (m *tuiModel) addServerCmd(raw string) tea.Cmd {
	urls := parseServerURLs(raw)
	if len(urls) == 0 {
		m.modal.err = "enter at least one server URL"
		return nil
	}
	m.modal.busy = true
	m.modal.err = ""
	return m.storeOpCmd(func(store *desktopStore) (string, error) {
		var added []string
		for _, u := range urls {
			p, err := store.add(u)
			if err != nil {
				return "", err
			}
			added = append(added, p.Name)
		}
		if len(added) == 0 {
			return "no servers added", nil
		}
		return "added " + strings.Join(added, ", "), nil
	}, true)
}

func (m *tuiModel) removeActiveServer() tea.Cmd {
	s := m.currentServer()
	if s == nil {
		return nil
	}
	id := s.profile.ID
	name := s.profile.Name
	m.forgetIntent(id)
	return m.storeOpCmd(func(store *desktopStore) (string, error) {
		if err := store.remove(id); err != nil {
			return "", err
		}
		return "removed " + name, nil
	}, true)
}

func (m *tuiModel) reorderServer(from, before int) tea.Cmd {
	if from < 0 || from >= len(m.servers) {
		return nil
	}
	id := m.servers[from].profile.ID
	beforeID := ""
	if before >= 0 && before < len(m.servers) {
		beforeID = m.servers[before].profile.ID
	}
	return m.storeOpCmd(func(store *desktopStore) (string, error) {
		return "", store.reorder(id, beforeID)
	}, true)
}

// storeOpCmd runs one shared-document mutation in the background. The
// operation rereads the document before writing, so desktop edits made during
// this run are adopted rather than overwritten.
func (m *tuiModel) storeOpCmd(fn func(store *desktopStore) (string, error), reload bool) tea.Cmd {
	gen := m.gen
	store := m.store
	return func() tea.Msg {
		out := storeDoneMsg{gen: gen, reload: reload}
		if store == nil {
			out.err = "no shared profile store"
			return out
		}
		status, err := fn(store)
		if err != nil {
			out.err = err.Error()
			return out
		}
		out.status = status
		return out
	}
}
