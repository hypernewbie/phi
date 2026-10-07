package phic

import (
	"strings"
	"testing"

	"github.com/hypernewbie/phi/internal/termemu"
)

// deltaTestFrame builds a frame with plain text, styled runs, a wide
// grapheme, and blank cells: enough variety to catch a stale row cache.
func deltaTestFrame(cols, rows int) termemu.Frame {
	f := termemu.Frame{Cols: cols, Rows: rows}
	f.Cells = make([][]termemu.Cell, rows)
	for y := range f.Cells {
		f.Cells[y] = make([]termemu.Cell, cols)
		for x := range f.Cells[y] {
			f.Cells[y][x] = termemu.Cell{Text: string(rune('a' + (x+y)%26)), Width: 1}
		}
	}
	f.Cells[1][2].Bold = true
	f.Cells[1][3].Bold = true
	f.Cells[2][0].Fg = termemu.Color{Kind: termemu.ColorPalette, Value: 200}
	f.Cells[3][5] = termemu.Cell{Text: "Ｘ", Width: 2}
	f.Cells[3][6] = termemu.Cell{Width: 0}
	f.Cells[4][0] = termemu.Cell{Width: 1}
	return f
}

func deltaTestModel() *tuiModel {
	m := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
	m.width, m.height = 100, 30
	return m
}

// deltaTestTab registers tab as the model's active tab so selection
// highlighting (active-tab only, as in production) engages in tests.
func deltaTestTab(m *tuiModel) *paneTab {
	tab := &paneTab{key: paneKey{ID: "p"}}
	m.tabs[""] = []*paneTab{tab}
	m.activeTab[""] = 0
	return tab
}

func TestRenderFrameLinesDeltaMatchesCold(t *testing.T) {
	m := deltaTestModel()
	tab := deltaTestTab(m)
	frame := deltaTestFrame(40, 10)

	first := m.renderFrameLines(tab, frame, 40, 10)
	cold := m.renderFrameLines(&paneTab{key: tab.key}, frame, 40, 10)
	if strings.Join(first, "\n") != strings.Join(cold, "\n") {
		t.Fatal("warming render differs from cold render")
	}
	// One changed character: exactly one row changes, and the delta
	// output equals a from-scratch render of the new frame.
	frame.Cells[6][7] = termemu.Cell{Text: "Z", Width: 1}
	second := m.renderFrameLines(tab, frame, 40, 10)
	fresh := m.renderFrameLines(&paneTab{key: tab.key}, frame, 40, 10)
	if strings.Join(second, "\n") != strings.Join(fresh, "\n") {
		t.Fatal("delta render differs from cold render after single-char change")
	}
	changed := 0
	for i := range first {
		if first[i] != second[i] {
			changed++
			if i != 6 {
				t.Fatalf("row %d changed for a single-cell edit on row 6", i)
			}
		}
	}
	if changed != 1 {
		t.Fatalf("single-char change altered %d rows, want 1", changed)
	}
	// An identical frame reuses everything: output stable, no work implied.
	third := m.renderFrameLines(tab, frame, 40, 10)
	if strings.Join(second, "\n") != strings.Join(third, "\n") {
		t.Fatal("identical frame did not reproduce cached output")
	}
}

func TestRenderFrameLinesSelectionInvalidates(t *testing.T) {
	m := deltaTestModel()
	tab := deltaTestTab(m)
	frame := deltaTestFrame(40, 10)

	plain := m.renderFrameLines(tab, frame, 40, 10)
	m.selection = selectionState{active: true, start: cellPos{X: 0, Y: 2}, end: cellPos{X: 10, Y: 3}}
	sel := m.renderFrameLines(tab, frame, 40, 10)
	if sel[2] == plain[2] || sel[3] == plain[3] {
		t.Fatal("active selection did not restyle covered rows")
	}
	if sel[0] != plain[0] || sel[5] != plain[5] {
		t.Fatal("selection restyle leaked onto uncovered rows")
	}
	// Dragging the selection must never show a stale highlight.
	m.selection.end = cellPos{X: 20, Y: 5}
	dragged := m.renderFrameLines(tab, frame, 40, 10)
	want := m.renderFrameLines(&paneTab{key: tab.key}, frame, 40, 10)
	if strings.Join(dragged, "\n") != strings.Join(want, "\n") {
		t.Fatal("dragged selection render differs from cold render")
	}
	if dragged[5] == plain[5] {
		t.Fatal("extended selection did not cover the new row")
	}
	// Clearing the selection restores the exact original strings.
	m.selection = selectionState{}
	cleared := m.renderFrameLines(tab, frame, 40, 10)
	if strings.Join(cleared, "\n") != strings.Join(plain, "\n") {
		t.Fatal("cleared selection did not restore original rows")
	}
}

func TestRenderFrameLinesWidthChange(t *testing.T) {
	m := deltaTestModel()
	tab := deltaTestTab(m)
	frame := deltaTestFrame(40, 10)

	wide := m.renderFrameLines(tab, frame, 40, 10)
	narrow := m.renderFrameLines(tab, frame, 30, 10)
	fresh := m.renderFrameLines(&paneTab{key: tab.key}, frame, 30, 10)
	if strings.Join(narrow, "\n") != strings.Join(fresh, "\n") {
		t.Fatal("width change differs from cold render")
	}
	if strings.Join(wide, "\n") == strings.Join(narrow, "\n") {
		t.Fatal("width change did not repad rows")
	}
}

func BenchmarkRenderFrameLinesFull(b *testing.B) {
	m := deltaTestModel()
	frame := deltaTestFrame(200, 50)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tab := &paneTab{}
		if out := m.renderFrameLines(tab, frame, 200, 50); len(out) != 50 {
			b.Fatal("short output")
		}
	}
}

func BenchmarkRenderFrameLinesDelta(b *testing.B) {
	m := deltaTestModel()
	tab := &paneTab{}
	frame := deltaTestFrame(200, 50)
	m.renderFrameLines(tab, frame, 200, 50)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Flip one cell every pass so each iteration diffs and
		// re-renders exactly one row: the realistic spinner-tick cost.
		if i%2 == 0 {
			frame.Cells[25][100] = termemu.Cell{Text: "x", Width: 1}
		} else {
			frame.Cells[25][100] = termemu.Cell{Text: "y", Width: 1}
		}
		if out := m.renderFrameLines(tab, frame, 200, 50); len(out) != 50 {
			b.Fatal("short output")
		}
	}
}
