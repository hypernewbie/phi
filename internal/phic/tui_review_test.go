package phic

import (
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/hypernewbie/phi/internal/termemu"
	"strings"
	"testing"
)

func TestReviewFormsDoNotSwallowJK(t *testing.T) {
	for _, kind := range []modalKind{modalPassword, modalAddServer, modalRenamePane, modalProject} {
		m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
		m.modal.open(kind, "form")
		for _, r := range "hjk" {
			m.handleKey(tea.KeyPressMsg{Code: r, Text: string(r)})
		}
		if m.modal.field.value != "hjk" {
			t.Fatalf("form %v swallowed text: %q", kind, m.modal.field.value)
		}
	}
}

func TestReviewWidgetGeometryAndChromeBounds(t *testing.T) {
	m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
	for _, width := range []int{40, 60, 80, 120, 160} {
		m.width, m.height = width, 24
		m.status = strings.Repeat("long error ", 40)
		m.project = strings.Repeat("/long/project", 20)
		cols, rows := m.terminalSize()
		inner := m.terminalInner()
		if cols != inner.W || rows != inner.H {
			t.Errorf("%d: advertised %dx%d, actual %dx%d", width, cols, rows, inner.W, inner.H)
		}
		view := m.render()
		lines := strings.Split(view, "\n")
		if len(lines) != m.height {
			t.Errorf("%d: painted %d rows, want %d", width, len(lines), m.height)
		}
		for y, line := range lines {
			if lipgloss.Width(line) > width {
				t.Errorf("%d: row %d overflowed: %d", width, y, lipgloss.Width(line))
			}
		}
	}
}

func TestReviewDiffRefreshReplacesCommitListAndClearsOnFailure(t *testing.T) {
	m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
	m.project = "/p"
	m.applyDiffLoaded(diffLoadedMsg{gen: m.gen, project: "/p", commits: []GitCommit{{Hash: "ab12cd3", Subject: "new commit"}}})
	if len(m.diff.commits) != 1 || m.diff.commits[0].Hash != "ab12cd3" {
		t.Fatalf("commit list stale: %#v", m.diff.commits)
	}
	m.applyDiffLoaded(diffLoadedMsg{gen: m.gen, project: "/p", err: "gone"})
	if len(m.diff.commits) != 0 {
		t.Fatal("failed commit-list refresh retained old entries")
	}
}

func TestReviewRendererClipsAnOldWideFrame(t *testing.T) {
	m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
	f := termemu.Frame{Cols: 80, Rows: 1, Cells: [][]termemu.Cell{make([]termemu.Cell, 80)}}
	for i := range f.Cells[0] {
		f.Cells[0][i] = termemu.Cell{Text: "x", Width: 1}
	}
	lines := m.renderFrameLines(&paneTab{}, f, 20, 1)
	if lipgloss.Width(lines[0]) != 20 {
		t.Fatalf("old frame escaped viewport: %d", lipgloss.Width(lines[0]))
	}
}
