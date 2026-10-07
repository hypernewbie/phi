package termemu

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// renderText is a stand-in for styled row rendering: it must be a pure
// function of the row cells for the cache contract to hold, exactly like the
// production styled renderer.
func renderText(y int, row []Cell, width int) string {
	var b strings.Builder
	for _, c := range row {
		if c.Width == 0 {
			continue
		}
		if c.Text == "" {
			b.WriteByte(' ')
		} else {
			b.WriteString(c.Text)
		}
		if c.Bold {
			b.WriteByte('*')
		}
	}
	s := b.String()
	if len(s) < width {
		s += strings.Repeat(" ", width-len(s))
	}
	return fmt.Sprintf("%02d:%s", y, s)
}

func fullRender(frame Frame, height, width int) []string {
	out := make([]string, height)
	for y := 0; y < height; y++ {
		var have []Cell
		if y < len(frame.Cells) {
			have = frame.Cells[y]
		}
		out[y] = renderText(y, have, width)
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func randomCell(r *rand.Rand) Cell {
	c := Cell{Width: 1}
	switch r.Intn(8) {
	case 0:
		c.Text = string(rune('a' + r.Intn(26)))
	case 1:
		c.Text = string(rune('0' + r.Intn(10)))
	case 2:
		c.Text = " "
	case 3:
		c.Text = ""
	case 4:
		// Wide grapheme plus its continuation cell, as the emulator emits.
		c.Text = "Ｘ"
		c.Width = 2
	case 5:
		c.Width = 0
	case 6:
		c.Text = "é"
	case 7:
		c.Bold = r.Intn(2) == 0
		c.Italic = r.Intn(2) == 0
		c.Text = string(rune('A' + r.Intn(26)))
	}
	if r.Intn(10) == 0 {
		c.Fg = Color{Kind: ColorPalette, Value: uint32(r.Intn(256))}
	}
	if r.Intn(10) == 0 {
		c.Bg = Color{Kind: ColorRGB, Value: uint32(r.Intn(1 << 24))}
	}
	if r.Intn(20) == 0 {
		c.Inverse = true
	}
	return c
}

func randomFrame(r *rand.Rand, cols, rows int) Frame {
	f := Frame{Cols: cols, Rows: rows, History: r.Intn(9000)}
	f.Cells = make([][]Cell, rows)
	for y := range f.Cells {
		f.Cells[y] = make([]Cell, cols)
		for x := range f.Cells[y] {
			f.Cells[y][x] = randomCell(r)
		}
	}
	return f
}

// mutate applies one small, realistic terminal change in place.
func mutate(r *rand.Rand, f *Frame) string {
	switch r.Intn(6) {
	case 0: // single character (spinner tick, typed key, progress digit)
		y, x := r.Intn(len(f.Cells)), r.Intn(f.Cols)
		f.Cells[y][x] = Cell{Text: string(rune('a' + r.Intn(26))), Width: 1}
		return "char"
	case 1: // a few characters on one line (prompt redraw)
		y := r.Intn(len(f.Cells))
		for i := 0; i < 3+r.Intn(5); i++ {
			x := r.Intn(f.Cols)
			f.Cells[y][x] = Cell{Text: string(rune('a' + r.Intn(26))), Width: 1}
		}
		return "word"
	case 2: // one full line (status line rewrite)
		y := r.Intn(len(f.Cells))
		for x := range f.Cells[y] {
			f.Cells[y][x] = Cell{Text: string(rune('a' + r.Intn(26))), Width: 1}
		}
		return "line"
	case 3: // attribute-only change (cursor block, selection highlight)
		y, x := r.Intn(len(f.Cells)), r.Intn(f.Cols)
		f.Cells[y][x].Inverse = !f.Cells[y][x].Inverse
		return "attr"
	case 4: // metadata-only change (cursor move, scroll): cells identical
		f.Cursor.X = (f.Cursor.X + 1) % max(f.Cols, 1)
		f.History++
		f.PageID++
		return "meta"
	default: // blank-line churn at the bottom of the screen
		y := len(f.Cells) - 1 - r.Intn(3)
		if y < 0 {
			y = 0
		}
		for x := range f.Cells[y] {
			f.Cells[y][x] = Cell{Width: 1}
		}
		return "blank"
	}
}

func TestChangedRowsExact(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	a := randomFrame(r, 20, 10)
	b := randomFrame(r, 20, 10)
	for y := range b.Cells {
		copy(b.Cells[y], a.Cells[y])
	}
	if got := ChangedRows(a, b); len(got) != 0 {
		t.Fatalf("identical frames reported %v", got)
	}
	b.Cells[4][7] = Cell{Text: "z", Width: 1}
	if got := ChangedRows(a, b); len(got) != 1 || got[0] != 4 {
		t.Fatalf("single-cell change reported %v", got)
	}
	// Metadata-only differences never count as row changes.
	b.Cursor.X, b.History, b.PageID, b.Alt = 9, 4242, 77, true
	if got := ChangedRows(a, b); len(got) != 1 || got[0] != 4 {
		t.Fatalf("metadata leaked into row diff: %v", got)
	}
	// Geometry differences report every row of the new frame.
	c := randomFrame(r, 30, 12)
	if got := ChangedRows(a, c); len(got) != 12 {
		t.Fatalf("geometry change reported %d rows, want 12", len(got))
	}
	d := randomFrame(r, 20, 10)
	d.Cells = d.Cells[:8]
	if got := ChangedRows(a, d); len(got) != 8 {
		t.Fatalf("row-count change reported %d rows, want 8", len(got))
	}
	var empty Frame
	if got := ChangedRows(empty, empty); len(got) != 0 {
		t.Fatalf("empty frames reported %v", got)
	}
}

func TestRowCacheMatchesFullRender(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	const cols, rows, width = 80, 24, 80
	var cache RowCache
	frame := randomFrame(r, cols, rows)
	var selGen uint64
	calls := 0
	render := func(y int, row []Cell) string { calls++; return renderText(y, row, width) }

	// Cold fill renders everything once.
	if got := cache.Update(frame, rows, width, selGen, render); !equalStrings(got, fullRender(frame, rows, width)) {
		t.Fatal("cold fill differs from full render")
	}
	if calls != rows {
		t.Fatalf("cold fill rendered %d rows, want %d", calls, rows)
	}
	// 200 small mutations: byte-identical output, minimal render calls.
	for i := 0; i < 200; i++ {
		kind := mutate(r, &frame)
		calls = 0
		got := cache.Update(frame, rows, width, selGen, render)
		if want := fullRender(frame, rows, width); !equalStrings(got, want) {
			t.Fatalf("step %d (%s): cached output differs from full render", i, kind)
		}
		if kind == "meta" && calls != 0 {
			t.Fatalf("step %d: metadata-only change rendered %d rows, want 0", i, calls)
		}
		if (kind == "char" || kind == "attr") && calls != 1 {
			t.Fatalf("step %d (%s): rendered %d rows, want 1", i, kind, calls)
		}
	}
	// Selection generation change restyles everything without cell changes.
	selGen++
	calls = 0
	renderSel := func(y int, row []Cell) string { calls++; return "SEL:" + renderText(y, row, width) }
	got := cache.Update(frame, rows, width, selGen, renderSel)
	for y := range got {
		if want := "SEL:" + fullRender(frame, rows, width)[y]; got[y] != want {
			t.Fatalf("row %d: selection render mismatch", y)
		}
	}
	if calls != rows {
		t.Fatalf("selection change rendered %d rows, want %d", calls, rows)
	}
	// Width change repads everything.
	calls = 0
	if got := cache.Update(frame, rows, width+10, selGen, func(y int, row []Cell) string {
		calls++
		return renderText(y, row, width+10)
	}); !equalStrings(got, fullRender(frame, rows, width+10)) {
		t.Fatal("width change differs from full render")
	}
	if calls != rows {
		t.Fatalf("width change rendered %d rows, want %d", calls, rows)
	}
	// Resize to fewer rows rebuilds exactly.
	small := randomFrame(r, cols, 10)
	if got := cache.Update(small, 10, width+10, selGen, func(y int, row []Cell) string {
		return renderText(y, row, width+10)
	}); !equalStrings(got, fullRender(small, 10, width+10)) {
		t.Fatal("resize differs from full render")
	}
}

func TestRowCacheOwnsItsCells(t *testing.T) {
	frame := Frame{Cols: 4, Cells: [][]Cell{
		{{Text: "a", Width: 1}, {Text: "b", Width: 1}, {Text: "c", Width: 1}, {Text: "d", Width: 1}},
		{{Text: "e", Width: 1}, {Text: "f", Width: 1}, {Text: "g", Width: 1}, {Text: "h", Width: 1}},
	}}
	var cache RowCache
	calls := 0
	render := func(y int, row []Cell) string { calls++; return renderText(y, row, 4) }
	first := cache.Update(frame, 2, 4, 0, render)
	if calls != 2 {
		t.Fatalf("cold fill rendered %d rows, want 2", calls)
	}
	// Mutate the frame's backing cells in place. The cache compared against
	// its own copy, so it must detect the change even though no new slice
	// was installed (the pane actor never mutates, but the cache must not
	// assume that across package boundaries).
	frame.Cells[0][0] = Cell{Text: "Z", Width: 1}
	calls = 0
	second := cache.Update(frame, 2, 4, 0, render)
	if calls != 1 {
		t.Fatalf("in-place mutation rendered %d rows, want 1", calls)
	}
	if second[0] == first[0] {
		t.Fatal("in-place mutation did not change the rendered row")
	}
	if second[1] != first[1] {
		t.Fatal("untouched row was not reused")
	}
}

func BenchmarkChangedRowsSingleChar(b *testing.B) {
	r := rand.New(rand.NewSource(3))
	prev := randomFrame(r, 200, 50)
	next := randomFrame(r, 200, 50)
	for y := range next.Cells {
		copy(next.Cells[y], prev.Cells[y])
	}
	next.Cells[25][100] = Cell{Text: "x", Width: 1}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if got := ChangedRows(prev, next); len(got) != 1 {
			b.Fatalf("got %v", got)
		}
	}
}

func BenchmarkRowCacheSingleChar(b *testing.B) {
	r := rand.New(rand.NewSource(5))
	frame := randomFrame(r, 200, 50)
	var cache RowCache
	render := func(y int, row []Cell) string { return renderText(y, row, 200) }
	cache.Update(frame, 50, 200, 0, render)
	frame.Cells[25][100] = Cell{Text: "x", Width: 1}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		out := cache.Update(frame, 50, 200, 0, render)
		if len(out) != 50 {
			b.Fatal("short output")
		}
	}
}
