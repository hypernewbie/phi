package phic

import (
	"context"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// Sync board panel: the native reader/writer for the server's addressed
// key/value messages. The web Syncboard panel and the sync skills use the
// same REST surface; phic lists, reads, upserts, and deletes messages with
// identical semantics.

type syncView int

const (
	syncListView syncView = iota
	syncValueView
	syncEditView
)

type syncPanelState struct {
	rows    []SyncMessage
	cursor  int
	view    syncView
	scroll  int
	loading bool
	busy    bool
	err     string
	notice  string
	ticket  int

	keyField   textField
	valueField textField
	focusKey   bool
	// editingKey is empty for a new message and the locked key otherwise.
	editingKey string
	// deleteArmed requires a second d press before a delete is sent.
	deleteArmed bool
}

// syncLoadedMsg carries one ticketed list load.
type syncLoadedMsg struct {
	gen    int
	ticket int
	rows   []SyncMessage
	err    string
}

// syncMutationMsg carries one upsert/delete reply.
type syncMutationMsg struct {
	gen  int
	verb string // "saved" or "deleted"
	key  string
	err  string
}

const syncCallTimeout = 15 * time.Second

// openSyncPanel opens the board for the current server.
func (m *tuiModel) openSyncPanel() tea.Cmd {
	s := m.currentServer()
	if s == nil || s.api == nil {
		m.setStatus("no server for the sync board", true)
		return nil
	}
	m.modal.open(modalSync, "Sync board")
	m.modal.origin = m.currentOrigin()
	m.sync = syncPanelState{loading: true}
	m.sync.ticket++
	return m.loadSyncCmd(m.sync.ticket)
}

func (m *tuiModel) loadSyncCmd(ticket int) tea.Cmd {
	s := m.serverForOrigin(m.currentOrigin())
	if s == nil || s.api == nil {
		m.sync.loading = false
		m.sync.err = "server unavailable"
		return nil
	}
	api := s.api
	gen := m.gen
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), syncCallTimeout)
		defer cancel()
		out := syncLoadedMsg{gen: gen, ticket: ticket}
		rows, err := api.SyncMessages(ctx)
		if err != nil {
			out.err = err.Error()
			return out
		}
		out.rows = rows
		return out
	}
}

func (m *tuiModel) handleSyncLoadedMsg(msg syncLoadedMsg) tea.Cmd {
	if msg.gen != m.gen || m.modal.kind != modalSync || msg.ticket != m.sync.ticket {
		return nil
	}
	m.sync.loading = false
	m.sync.err = msg.err
	m.sync.rows = msg.rows
	if m.sync.cursor >= len(m.sync.rows) {
		m.sync.cursor = max(0, len(m.sync.rows)-1)
	}
	return nil
}

func (m *tuiModel) handleSyncMutationMsg(msg syncMutationMsg) tea.Cmd {
	if msg.gen != m.gen {
		return nil
	}
	if m.modal.kind == modalSync && !m.sync.busy {
		// Nothing was pending; ignore stray replies.
		return nil
	}
	m.setStatus(msg.verb+" "+msg.key, msg.err != "")
	if m.modal.kind != modalSync {
		return nil
	}
	m.sync.busy = false
	if msg.err != "" {
		m.sync.err = msg.err
		return nil
	}
	m.sync.notice = msg.verb + " " + msg.key
	// Every mutation returns to a fresh list, exactly like the web panel.
	m.sync.view = syncListView
	m.sync.deleteArmed = false
	m.sync.ticket++
	m.sync.loading = true
	return m.loadSyncCmd(m.sync.ticket)
}

// handleSyncModalKey drives all three views.
func (m *tuiModel) handleSyncModalKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.Key()
	k.Code = chromeKeyCode(k)
	if m.sync.busy {
		return m, nil
	}
	switch m.sync.view {
	case syncListView:
		return m.handleSyncListKey(k)
	case syncValueView:
		return m.handleSyncValueKey(k)
	case syncEditView:
		return m.handleSyncEditKey(msg, k)
	}
	return m, nil
}

func (m *tuiModel) handleSyncListKey(k tea.Key) (tea.Model, tea.Cmd) {
	switch k.Code {
	case tea.KeyEscape:
		m.closeModal()
		m.focus = focusTerminal
		return m, nil
	case tea.KeyUp, 'k':
		if m.sync.cursor > 0 {
			m.sync.cursor--
		}
	case tea.KeyDown, 'j':
		if m.sync.cursor < len(m.sync.rows)-1 {
			m.sync.cursor++
		}
	case tea.KeyEnter:
		if m.sync.cursor < len(m.sync.rows) {
			m.sync.view = syncValueView
			m.sync.scroll = 0
		}
	case 'n':
		m.sync.view = syncEditView
		m.sync.editingKey = ""
		m.sync.keyField = textField{}
		m.sync.valueField = textField{}
		m.sync.focusKey = true
		m.sync.err = ""
	case 'r':
		m.sync.ticket++
		m.sync.loading = true
		return m, m.loadSyncCmd(m.sync.ticket)
	}
	return m, nil
}

func (m *tuiModel) handleSyncValueKey(k tea.Key) (tea.Model, tea.Cmd) {
	switch k.Code {
	case tea.KeyEscape:
		m.sync.view = syncListView
		m.sync.deleteArmed = false
	case tea.KeyUp, 'k':
		if m.sync.scroll > 0 {
			m.sync.scroll--
		}
	case tea.KeyDown, 'j':
		m.sync.scroll++
	case 'e':
		if m.sync.cursor < len(m.sync.rows) {
			row := m.sync.rows[m.sync.cursor]
			m.sync.view = syncEditView
			m.sync.editingKey = row.Key
			m.sync.keyField.set(row.Key)
			m.sync.valueField.set(row.Value)
			m.sync.focusKey = false
			m.sync.err = ""
		}
	case 'd':
		return m, m.syncDeleteCmd()
	}
	return m, nil
}

func (m *tuiModel) handleSyncEditKey(msg tea.KeyPressMsg, k tea.Key) (tea.Model, tea.Cmd) {
	switch k.Code {
	case tea.KeyEscape:
		m.sync.view = syncListView
		return m, nil
	case tea.KeyTab:
		m.sync.focusKey = !m.sync.focusKey
		return m, nil
	case tea.KeyEnter:
		return m, m.syncUpsertCmd()
	case tea.KeyUp:
		return m, nil
	case tea.KeyDown:
		if m.sync.focusKey {
			return m, nil
		}
		return m, nil
	case tea.KeyLeft:
		if m.sync.focusKey {
			m.sync.keyField.left()
		} else {
			m.sync.valueField.left()
		}
		return m, nil
	case tea.KeyRight:
		if m.sync.focusKey {
			m.sync.keyField.right()
		} else {
			m.sync.valueField.right()
		}
		return m, nil
	case tea.KeyHome:
		if m.sync.focusKey {
			m.sync.keyField.home()
		} else {
			m.sync.valueField.home()
		}
		return m, nil
	case tea.KeyEnd:
		if m.sync.focusKey {
			m.sync.keyField.end()
		} else {
			m.sync.valueField.end()
		}
		return m, nil
	case tea.KeyBackspace:
		if m.sync.focusKey {
			m.sync.keyField.backspace()
		} else {
			m.sync.valueField.backspace()
		}
		return m, nil
	case tea.KeyDelete:
		if m.sync.focusKey {
			m.sync.keyField.deleteForward()
		} else {
			m.sync.valueField.deleteForward()
		}
		return m, nil
	}
	if k.Text != "" && k.Mod == 0 {
		if m.sync.focusKey {
			m.sync.keyField.insert(k.Text)
		} else {
			m.sync.valueField.insert(k.Text)
		}
		return m, nil
	}
	_ = msg
	return m, nil
}

// syncUpsertCmd posts the edit form. A new message needs a non-blank key;
// an edit keeps its locked key.
func (m *tuiModel) syncUpsertCmd() tea.Cmd {
	key := strings.TrimSpace(m.sync.keyField.value)
	if m.sync.editingKey != "" {
		key = m.sync.editingKey
	}
	if key == "" {
		m.sync.err = "enter a key"
		return nil
	}
	if len(key) > 256 {
		m.sync.err = "key is too long"
		return nil
	}
	value := m.sync.valueField.value
	if len(value) > 1<<16 {
		m.sync.err = "value is too long"
		return nil
	}
	s := m.serverForOrigin(m.currentOrigin())
	if s == nil || s.api == nil {
		m.sync.err = "server unavailable"
		return nil
	}
	api := s.api
	gen := m.gen
	m.sync.busy = true
	m.sync.err = ""
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), syncCallTimeout)
		defer cancel()
		err := api.SyncUpsert(ctx, key, value)
		out := syncMutationMsg{gen: gen, verb: "saved", key: key}
		if err != nil {
			out.err = err.Error()
		}
		return out
	}
}

// syncDeleteCmd arms and then performs one delete; the second d press
// confirms so one slip cannot drop a message.
func (m *tuiModel) syncDeleteCmd() tea.Cmd {
	if m.sync.cursor >= len(m.sync.rows) {
		return nil
	}
	key := m.sync.rows[m.sync.cursor].Key
	if !m.sync.deleteArmed {
		m.sync.deleteArmed = true
		m.sync.notice = "press d again to delete " + key
		return nil
	}
	s := m.serverForOrigin(m.currentOrigin())
	if s == nil || s.api == nil {
		m.sync.err = "server unavailable"
		return nil
	}
	api := s.api
	gen := m.gen
	m.sync.busy = true
	m.sync.deleteArmed = false
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), syncCallTimeout)
		defer cancel()
		err := api.SyncDelete(ctx, key)
		out := syncMutationMsg{gen: gen, verb: "deleted", key: key}
		if err != nil {
			out.err = err.Error()
		}
		return out
	}
}

// renderSyncModal draws the active view.
func (m *tuiModel) renderSyncModal() string {
	accent := m.accentColor()
	var b strings.Builder
	b.WriteString(lg.NewStyle().Foreground(accent).Bold(true).Render("Sync board"))
	switch m.sync.view {
	case syncListView:
		b.WriteString(m.renderSyncList())
	case syncValueView:
		b.WriteString(m.renderSyncValue())
	case syncEditView:
		b.WriteString(m.renderSyncEdit())
	}
	content := b.String()
	return lg.NewStyle().
		Border(lg.RoundedBorder()).
		BorderForeground(accent).
		Padding(0, 1).
		MaxWidth(max(40, min(90, m.width-8))).
		Render(content)
}

func (m *tuiModel) renderSyncList() string {
	var b strings.Builder
	hint := lg.NewStyle().Foreground(tuiMuted).Render("  ↑↓ select   Enter read   n new   r refresh   Esc close")
	b.WriteString("\n" + hint + "\n\n")
	switch {
	case m.sync.loading:
		b.WriteString(lg.NewStyle().Foreground(tuiMuted).Render("loading…"))
	case m.sync.err != "":
		b.WriteString(lg.NewStyle().Foreground(tuiError).Render(m.sync.err))
	case len(m.sync.rows) == 0:
		b.WriteString(lg.NewStyle().Foreground(tuiMuted).Render("no messages on the board"))
	default:
		for i, row := range m.sync.rows {
			label := syncPreview(row, 52)
			if i == m.sync.cursor {
				b.WriteString(lg.NewStyle().Foreground(m.accentColor()).Background(lg.Color("#1d1f27")).Render("› " + label))
			} else {
				b.WriteString(lg.NewStyle().Foreground(tuiFgColor()).Render("  " + label))
			}
			b.WriteString("\n")
		}
	}
	if m.sync.notice != "" {
		b.WriteString("\n" + lg.NewStyle().Foreground(tuiMuted).Render(m.sync.notice))
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *tuiModel) renderSyncValue() string {
	if m.sync.cursor >= len(m.sync.rows) {
		m.sync.view = syncListView
		return m.renderSyncList()
	}
	row := m.sync.rows[m.sync.cursor]
	var b strings.Builder
	title := lg.NewStyle().Foreground(m.accentColor()).Bold(true).Render("  " + row.Key)
	hint := lg.NewStyle().Foreground(tuiMuted).Render("  ↑↓ scroll   e edit   d delete   Esc back")
	if m.sync.deleteArmed {
		hint = lg.NewStyle().Foreground(tuiError).Render("  d again confirms delete   Esc cancels")
	}
	b.WriteString("\n" + title + "\n" + hint + "\n\n")
	lines := strings.Split(row.Value, "\n")
	if m.sync.scroll > len(lines) {
		m.sync.scroll = len(lines)
	}
	lines = lines[min(m.sync.scroll, len(lines)):]
	shown := 12
	if len(lines) > shown {
		lines = lines[:shown]
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("… "+itoa(len(lines)-0)+" more lines below"))
	}
	for _, line := range lines {
		b.WriteString("  " + ansi.Truncate(line, 74, "…") + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func (m *tuiModel) renderSyncEdit() string {
	var b strings.Builder
	title := "New message"
	if m.sync.editingKey != "" {
		title = "Edit " + m.sync.editingKey
	}
	b.WriteString("\n" + lg.NewStyle().Foreground(m.accentColor()).Bold(true).Render("  "+title))
	keyStyle := lg.NewStyle().Foreground(tuiMuted)
	if m.sync.focusKey {
		keyStyle = lg.NewStyle().Foreground(m.accentColor())
	}
	valueStyle := lg.NewStyle().Foreground(tuiMuted)
	if !m.sync.focusKey {
		valueStyle = lg.NewStyle().Foreground(m.accentColor())
	}
	b.WriteString("\n\n")
	b.WriteString(keyStyle.Render("  key   ") + renderSyncField(&m.sync.keyField, m.sync.focusKey, m.sync.editingKey != ""))
	b.WriteString("\n")
	b.WriteString(valueStyle.Render("  value ") + renderSyncField(&m.sync.valueField, !m.sync.focusKey, false))
	b.WriteString("\n\n" + lg.NewStyle().Foreground(tuiMuted).Render("  Tab switch field   Enter save   Esc cancel"))
	if m.sync.err != "" {
		b.WriteString("\n\n" + lg.NewStyle().Foreground(tuiError).Render("  "+m.sync.err))
	}
	if m.sync.busy {
		b.WriteString("\n" + lg.NewStyle().Foreground(tuiMuted).Render("  working…"))
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderSyncField draws one editor line; a locked key is shown read-only.
func renderSyncField(f *textField, focused, locked bool) string {
	value := f.value
	if locked {
		return lg.NewStyle().Foreground(tuiMuted).Render(value + " (locked)")
	}
	runes := []rune(value)
	cursor := f.cursor
	if cursor > len(runes) {
		cursor = len(runes)
	}
	before := menuLabel(string(runes[:cursor]))
	after := menuLabel(string(runes[cursor:]))
	out := lg.NewStyle().Foreground(tuiFgColor()).Render(before)
	if focused {
		out += lg.NewStyle().Reverse(true).Render(" ")
	} else {
		out += " "
	}
	out += lg.NewStyle().Foreground(tuiFgColor()).Render(after)
	return ansi.Truncate(out, 72, "…")
}
