package phic

import (
	"charm.land/lipgloss/v2"
	"github.com/hypernewbie/phi/internal/termemu"
	"testing"
)

func TestReviewPanelSizesAreActualInnerGeometry(t *testing.T) {
	m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
	m.width, m.height = 120, 36
	r := m.terminalRect()
	// Fill the panel just like a native snapshot, including space-only rows.
	f := termemu.Frame{Cells: make([][]termemu.Cell, r.H-2)}
	for y := range f.Cells {
		f.Cells[y] = make([]termemu.Cell, r.W-2)
		for x := range f.Cells[y] {
			f.Cells[y][x] = termemu.Cell{Width: 1, Text: " "}
		}
	}
	lines := m.renderFrameLines(&paneTab{}, f, r.W-2, r.H-2)
	p := m.panelStyle(r.W-2, r.H-2, true).Render(joinReview(lines))
	if lipgloss.Width(p) != r.W || lipgloss.Height(p) != r.H {
		t.Fatalf("painted panel %dx%d, geometry %dx%d", lipgloss.Width(p), lipgloss.Height(p), r.W, r.H)
	}
	sidebar := m.renderSidebar()
	sr := m.sidebarRect()
	if lipgloss.Width(sidebar) != sr.W || lipgloss.Height(sidebar) != sr.H {
		t.Fatalf("sidebar %dx%d, geometry %dx%d", lipgloss.Width(sidebar), lipgloss.Height(sidebar), sr.W, sr.H)
	}
}
func joinReview(lines []string) string {
	s := ""
	for i, l := range lines {
		if i > 0 {
			s += "\n"
		}
		s += l
	}
	return s
}
