package phic

import (
	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (m *tuiModel) railLabel(s *serverState) string {
	if d := m.data[s.profile.Origin]; d != nil && d.identity.Hostname != "" {
		return strings.ToUpper(menuLabel(d.identity.Hostname))
	}
	// API origins are canonical; profile origins can retain a root slash.
	if s.api != nil {
		if d := m.data[s.api.base.String()]; d != nil && d.identity.Hostname != "" {
			return strings.ToUpper(menuLabel(d.identity.Hostname))
		}
	}
	label := s.label()
	if u, err := url.Parse(s.profile.Origin); err == nil && (label == u.Host || label == u.Hostname() || label == s.profile.Origin) {
		label = u.Hostname()
	} else if at := strings.LastIndex(label, ":"); at > 0 {
		if _, err := strconv.Atoi(label[at+1:]); err == nil {
			label = label[:at]
		}
	}
	return strings.ToUpper(menuLabel(label))
}
func (m *tuiModel) spawnBtop() tea.Cmd {
	cmd := m.spawnForCoder(m.shellCoderID(), false, "", "btop")
	if cmd == nil {
		return nil
	}
	return func() tea.Msg {
		msg := cmd()
		if out, ok := msg.(spawnDoneMsg); ok {
			out.capture.startupInput = "btop\r"
			return out
		}
		return msg
	}
}

const chromeEscapeWindow = 600 * time.Millisecond

type chromeEscapeExpiredMsg struct{ token int }

func (m *tuiModel) chromeEscape() (tea.Model, tea.Cmd) {
	if !m.chromeEscAt.IsZero() && time.Since(m.chromeEscAt) < chromeEscapeWindow {
		m.chromeEscAt = time.Time{}
		m.chromeEscToken++
		m.modal.open(modalQuit, "Quit phic?")
		return m, nil
	}
	m.chromeEscAt = time.Now()
	m.chromeEscToken++
	token := m.chromeEscToken
	return m, tea.Tick(chromeEscapeWindow, func(time.Time) tea.Msg { return chromeEscapeExpiredMsg{token: token} })
}
func (m *tuiModel) handleQuitKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.Key().Code {
	case 'q':
		return m, tea.Quit
	case tea.KeyEscape, tea.KeyEnter, 'c':
		m.closeModal()
	}
	return m, nil
}
func (m *tuiModel) handleQuitMouse(x, y int) (tea.Model, tea.Cmd) {
	content := m.renderModal()
	ox, oy := max(0, (m.width-lg.Width(content))/2), max(0, (m.height-lg.Height(content))/2)
	for row, line := range strings.Split(content, "\n") {
		if y != oy+row {
			continue
		}
		plain := ansi.Strip(line)
		for _, label := range []string{"[q] Quit client", "[Esc] Cancel"} {
			at := strings.Index(plain, label)
			if at < 0 {
				continue
			}
			start := ox + ansi.StringWidth(plain[:at])
			if x >= start && x < start+len(label) {
				if label == "[q] Quit client" {
					return m, tea.Quit
				}
				m.closeModal()
				return m, nil
			}
		}
	}
	return m, nil
}
func (m *tuiModel) toggleSidebar() tea.Cmd {
	m.sidebarHidden = !m.sidebarHidden
	m.focus = focusTerminal
	return m.persistIntent()
}
func (m *tuiModel) sessionPanelWidth() int { return min(max(20, m.sidebarWidth), max(20, m.width/2)) }
func (m *tuiModel) readerPanelWidth() int {
	if m.width < 120 {
		return min(max(40, m.readerWidth), m.width)
	}
	left := 0
	if m.showSidebar() {
		left = m.sessionPanelWidth()
	}
	return min(max(24, m.readerWidth), max(24, m.width-left-24))
}
func (m *tuiModel) resizePanel(left bool, delta int) tea.Cmd {
	if left {
		m.sidebarWidth = max(20, min(max(20, m.width/2), m.sessionPanelWidth()+delta))
	} else {
		m.readerWidth = max(24, min(max(24, m.width-24), m.readerPanelWidth()+delta))
	}
	return m.persistIntent()
}
func (m *tuiModel) refreshConsole() tea.Cmd {
	// Clear the host display, not the backend VT state or server process.
	return tea.Batch(tea.ClearScreen, m.reloadServersCmd())
}
func (m *tuiModel) handlePanelDrag(msg tea.MouseMsg) (bool, tea.Cmd) {
	mouse := msg.Mouse()
	if _, ok := msg.(tea.MouseReleaseMsg); ok && m.panelDrag != 0 {
		m.panelDrag = 0
		return true, m.persistIntent()
	}
	if _, ok := msg.(tea.MouseMotionMsg); ok && m.panelDrag != 0 {
		if m.panelDrag == 1 {
			m.sidebarWidth = max(20, min(m.width/2, mouse.X+1))
		} else {
			m.readerWidth = max(24, min(m.width-24, m.width-mouse.X))
		}
		return true, nil
	}
	if _, ok := msg.(tea.MouseClickMsg); ok && mouse.Button == tea.MouseLeft && mouse.Y >= 3 && mouse.Y < m.height-1 {
		if m.showSidebar() && (mouse.X == m.sessionPanelWidth()-1 || mouse.X == m.sessionPanelWidth()) {
			m.panelDrag = 1
			return true, nil
		}
		if m.showDiffPanel() && (mouse.X == m.diffRect().X || mouse.X == m.diffRect().X-1) {
			m.panelDrag = 2
			return true, nil
		}
	}
	return false, nil
}

// Empty terminal landing mirrors the web empty state (web/index.html
// .empty-logo/.empty-title/.empty-subtitle): accent Phi glyph, default-fg
// title, muted multiplexer tagline. No box border, no box-art logo.
func (m *tuiModel) renderEmptyTerminal(w, h int) []string {
	accent := lg.NewStyle().Foreground(m.accentColor()).Bold(true)
	title := lg.NewStyle().Foreground(tuiFgColor()).Bold(true)
	muted := lg.NewStyle().Foreground(tuiMuted)
	content := []string{accent.Render("Φ"), "", title.Render("Phi"), "", muted.Render("Terminal Multiplexer for AI Coding Agents"), "", accent.Render("Ctrl-] n   New Session"), muted.Render("Ctrl-] s   Sessions   ·   Ctrl-] ?   Help")}
	lines := make([]string, 0, h)
	top := max(0, (h-len(content))/2)
	for i := 0; i < top; i++ {
		lines = append(lines, "")
	}
	for _, s := range content {
		if len(lines) >= h {
			break
		}
		s = ansi.Truncate(s, w, "")
		lines = append(lines, strings.Repeat(" ", max(0, (w-lg.Width(s))/2))+s)
	}
	for len(lines) < h {
		lines = append(lines, "")
	}
	return lines
}
