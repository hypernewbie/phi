package phic

import (
	"path"
	"strings"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

const markdownCloseLabel = "[×]"
const markdownCopyLabel = "[y] Copy Markdown"
const markdownFilenameLabel = "[f] Insert Filename"

func (m *tuiModel) markdownFilename() string {
	if i := m.markdown.cursor; i >= 0 && i < len(m.markdown.files) && m.markdown.files[i].Path == m.markdown.path {
		return m.markdown.files[i].Name
	}
	return path.Base(strings.ReplaceAll(m.markdown.path, "\\", "/"))
}
func (m *tuiModel) closeMarkdownModal() {
	m.markdown.ticket++ // A late file response cannot reopen or replace the list.
	m.markdown.reading = false
	m.markdown.loading = false
	m.markdown.err = ""
	m.closeModal()
	m.focus = focusDiff
}
func (m *tuiModel) copyMarkdown() tea.Cmd {
	if m.markdown.loading || m.markdown.err != "" {
		return nil
	}
	m.setStatus("clipboard copy requested; terminal permission may be required", false)
	return tea.SetClipboard(m.markdown.source)
}
func (m *tuiModel) handleMarkdownModalKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.Key().Code {
	case tea.KeyEscape, tea.KeyLeft, tea.KeyBackspace, 'q', 'b':
		m.closeMarkdownModal()
	case 'y':
		return m, m.copyMarkdown()
	case 'f':
		m.insertMarkdownFilename()
	case 'r':
		return m, m.openMarkdownFile(m.markdown.cursor)
	case tea.KeyUp, 'k':
		m.markdown.scroll = max(0, m.markdown.scroll-1)
	case tea.KeyDown, 'j':
		m.markdown.scroll = min(max(0, len(m.markdown.lines)-1), m.markdown.scroll+1)
	case tea.KeyPgUp:
		m.markdown.scroll = max(0, m.markdown.scroll-max(1, m.height-6))
	case tea.KeyPgDown:
		m.markdown.scroll = min(max(0, len(m.markdown.lines)-1), m.markdown.scroll+max(1, m.height-6))
	case tea.KeyHome:
		m.markdown.scroll = 0
	case tea.KeyEnd:
		m.markdown.scroll = max(0, len(m.markdown.lines)-1)
	}
	return m, nil
}

// insertMarkdownFilename types the viewed file's name into the active
// terminal instead of copying it: f means "use this file here".
func (m *tuiModel) insertMarkdownFilename() {
	if m.markdown.loading || m.markdown.err != "" {
		return
	}
	name := m.markdownFilename()
	tab := m.activeTabModel()
	if tab == nil || tab.actor == nil {
		m.setStatus("no active terminal for filename", true)
		return
	}
	m.closeMarkdownModal()
	m.focus = focusTerminal
	tab.actor.sendPaste([]byte(name))
	m.setStatus("inserted "+name+" into terminal", false)
}
func (m *tuiModel) handleMarkdownModalMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	mouse := msg.Mouse()
	if mouse.Button == tea.MouseWheelDown {
		m.markdown.scroll = min(max(0, len(m.markdown.lines)-1), m.markdown.scroll+3)
		return m, nil
	}
	if mouse.Button == tea.MouseWheelUp {
		m.markdown.scroll = max(0, m.markdown.scroll-3)
		return m, nil
	}
	if _, ok := msg.(tea.MouseClickMsg); !ok || mouse.Button != tea.MouseLeft {
		return m, nil
	}
	if mouse.Y == 1 && mouse.X >= m.width-1-ansi.StringWidth(markdownCloseLabel) && mouse.X < m.width-1 {
		m.closeMarkdownModal()
		return m, nil
	}
	if mouse.Y == 2 {
		if mouse.X >= 2 && mouse.X < 2+len(markdownCopyLabel) {
			return m, m.copyMarkdown()
		}
		start := 2 + len(markdownCopyLabel) + 2
		if mouse.X >= start && mouse.X < start+len(markdownFilenameLabel) {
			m.insertMarkdownFilename()
			return m, nil
		}
	}
	return m, nil
}
func (m *tuiModel) renderMarkdownModal() string {
	w, h := max(1, m.width-2), max(1, m.height-2)
	accent := lg.NewStyle().Foreground(m.accentColor()).Bold(true)
	close := accent.Render(markdownCloseLabel)
	title := accent.Render(ansi.Truncate(" Markdown · "+menuLabel(m.markdownFilename()), max(0, w-ansi.StringWidth(markdownCloseLabel)-1), "…"))
	header := title + strings.Repeat(" ", max(0, w-lg.Width(title)-lg.Width(close))) + close
	toolbar := accent.Render(" " + markdownCopyLabel + "  " + markdownFilenameLabel)
	lines := []string{header, toolbar, lg.NewStyle().Foreground(tuiMuted).Render(" " + ansi.Truncate(menuLabel(m.markdown.path), max(1, w-1), "…"))}
	visible := max(1, h-4)
	if m.markdown.loading {
		lines = append(lines, " Loading…")
	} else if m.markdown.err != "" {
		lines = append(lines, " "+menuLabel(m.markdown.err))
	} else {
		for i := m.markdown.scroll; i < len(m.markdown.lines) && i < m.markdown.scroll+visible; i++ {
			lines = append(lines, " "+ansi.Truncate(m.markdown.lines[i], m.markdownWidth(), ""))
		}
	}
	for len(lines) < h-1 {
		lines = append(lines, "")
	}
	if len(lines) > h-1 {
		lines = lines[:h-1]
	}
	hint := " Esc close · ↑↓/wheel scroll · PgUp/PgDn · r refresh"
	if m.status != "" && strings.HasPrefix(m.status, "clipboard copy requested") {
		hint = " Copy requested · Esc close · ↑↓ scroll"
	}
	lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render(ansi.Truncate(hint, w, "")))
	return m.panelStyle(w, h, true).Render(strings.Join(lines, "\n"))
}
