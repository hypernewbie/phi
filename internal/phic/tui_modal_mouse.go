package phic

import (
	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"strings"
)

func (m *tuiModel) visibleModalItems(limit int) (int, int) {
	start := max(0, m.modal.cursor-limit+1)
	return start, min(len(m.modal.items), start+limit)
}

func (m *tuiModel) handlePickerMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if m.modal.busy {
		return m, nil
	}
	mouse := msg.Mouse()
	if mouse.X < 0 || mouse.X >= m.width || mouse.Y < 0 || mouse.Y >= m.height {
		return m, nil
	}
	content := m.renderModal()
	w, h := lg.Width(content), lg.Height(content)
	ox, oy := max(0, (m.width-w)/2), max(0, (m.height-h)/2)
	if mouse.X <= ox || mouse.X >= ox+w-1 || mouse.Y <= oy || mouse.Y >= oy+h-1 {
		return m, nil
	}
	limit, itemY := 0, oy+3 // border, title, blank row
	switch m.modal.kind {
	case modalProject:
		limit, itemY = 10, oy+4 // project text field precedes its list
	case modalCoder, modalWorktree, modalOpenCode, modalDiffSelect:
		limit = 14
	}
	if _, ok := msg.(tea.MouseWheelMsg); ok && limit > 0 {
		code := tea.KeyUp
		if mouse.Button == tea.MouseWheelDown {
			code = tea.KeyDown
		}
		return m.handleModalKey(tea.KeyPressMsg{Code: code})
	}
	if _, ok := msg.(tea.MouseClickMsg); !ok || mouse.Button != tea.MouseLeft {
		return m, nil
	}
	if limit > 0 {
		start, end := m.visibleModalItems(limit)
		if index := start + mouse.Y - itemY; mouse.Y >= itemY && index < end {
			m.modal.cursor = index
			return m.submitModal()
		}
	}
	// Only the rendered footer is a button; labels containing these words are
	// data, not controls. Keep outside clicks from leaking into backend input.
	lines := strings.Split(content, "\n")
	if mouse.Y == oy+len(lines)-2 {
		plain := ansi.Strip(lines[len(lines)-2])
		for _, label := range []string{"Enter confirm", "Esc cancel"} {
			at := strings.Index(plain, label)
			if at < 0 {
				continue
			}
			x := ox + ansi.StringWidth(plain[:at])
			if mouse.X >= x && mouse.X < x+len(label) {
				if label == "Esc cancel" {
					m.closeModal()
					return m, nil
				}
				return m.submitModal()
			}
		}
	}
	return m, nil
}
