package phic

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestCoderClickUsesActualRenderedCellsAtEveryWidth(t *testing.T) {
	for _, width := range []int{50, 69, 70, 80, 99, 100, 120, 160, 240, 360} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			m, _, _ := closeControlsModel(t)
			m.width, m.height = width, 40
			m.project = "/work/界🙂project"
			m.worktree = "/work/界🙂branch"
			m.current().coders = []CoderDescriptor{{ID: "pi", Name: "Π界🙂 Pi"}, {ID: "shell", Name: "Shell"}}
			row := ansi.Strip(strings.Split(m.render(), "\n")[1])
			at := strings.Index(row, "[c]")
			if at < 0 {
				t.Fatalf("coder control absent from visible row: %q", row)
			}
			x := ansi.StringWidth(row[:at])
			m.Update(tea.MouseClickMsg{X: x, Y: 1, Button: tea.MouseLeft})
			if m.modal.kind != modalCoder {
				t.Fatalf("click on visible [c] at %d opened %v, row %q", x, m.modal.kind, row)
			}
		})
	}
}

func TestPickerMouseSelectsTheRenderedCoderWithoutSendingBackendInput(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.width, m.height = 140, 40
	m.current().coders = []CoderDescriptor{{ID: "pi", Name: "Pi"}, {ID: "shell", Name: "Shell"}}
	m.openCoderModal()
	content := m.renderModal()
	ox, oy := max(0, (m.width-lg.Width(content))/2), max(0, (m.height-lg.Height(content))/2)
	rows := strings.Split(ansi.Strip(content), "\n")
	for y, row := range rows {
		if at := strings.Index(row, "Shell"); at >= 0 {
			m.Update(tea.MouseClickMsg{X: ox + ansi.StringWidth(row[:at]), Y: oy + y, Button: tea.MouseLeft})
			if m.modal.kind != modalNone || m.selectedCoderID() != "shell" {
				t.Fatal("visible picker row was not clickable")
			}
			return
		}
	}
	t.Fatal("Shell picker row missing")
}

func TestContextWhitespaceAndOffscreenCoordinatesDoNotActivateControls(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.width, m.height = 240, 40
	m.current().coders = []CoderDescriptor{{ID: "pi", Name: "Pi"}}
	for _, x := range []int{-1, 0, 180, 240, 400} {
		m.Update(tea.MouseClickMsg{X: x, Y: 1, Button: tea.MouseLeft})
		if m.modal.kind != modalNone || m.diff.open {
			t.Fatalf("empty/offscreen cell %d activated chrome", x)
		}
	}
}
