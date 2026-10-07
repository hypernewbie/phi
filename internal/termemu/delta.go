// Exact, non-compressed screen deltas shared by every terminal surface.
//
// A single changed character must not pay for a full-screen rebuild. The
// helpers here gate row reuse on cell-for-cell equality: no hashing, no
// digests, no compression. A reused row is byte-identical to rendering it
// fresh, because reuse happens only when every cell compares equal.
//
// The pane actor's frame cache is untouched by design: the actor keeps taking
// full snapshots every paint, so its cache stays exactly as correct as
// today. The delta applies on top, at render time, where the expensive
// styled-string work happens.
package termemu

// SameRow reports whether two rows hold exactly the same cells. Cell is a
// comparable struct, so this is a field-by-field equality check with no
// fingerprinting: equal means interchangeable on screen.
func SameRow(a, b []Cell) bool {
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

// ChangedRows returns the indices of the rows in next whose cells differ
// from prev. It returns nil when the visible cells are identical, even if
// cursor, history, alternate-screen, or revision metadata changed: the
// renderer draws only cells, so metadata-only changes repaint nothing.
//
// A geometry or row-count difference reports every row of next; the caller
// then rebuilds instead of diffing. Either way the result describes next
// exactly, never an approximation.
func ChangedRows(prev, next Frame) []int {
	if prev.Cols != next.Cols || len(prev.Cells) != len(next.Cells) {
		all := make([]int, len(next.Cells))
		for i := range all {
			all[i] = i
		}
		return all
	}
	var changed []int
	for y := range next.Cells {
		if !SameRow(prev.Cells[y], next.Cells[y]) {
			changed = append(changed, y)
		}
	}
	return changed
}

// RowCache reuses fully rendered row strings across frames. Stored rows own
// a deep copy of the cells they were rendered from, so later snapshot
// replacement by the pane actor can never alias the cache into staleness:
// the next Update compares against the owned copy, not live memory.
type RowCache struct {
	rows   []cachedRow
	width  int
	selGen uint64
	live   bool
}

type cachedRow struct {
	cells []Cell
	text  string
}

// Reset drops every cached row. The next Update renders everything fresh.
// Callers rarely need this: geometry, width, and selection-generation
// changes already force a full rebuild inside Update.
func (c *RowCache) Reset() {
	c.rows = nil
	c.live = false
}

// Update returns one final rendered string per visible row, byte-identical
// to rendering every row fresh. render is invoked only for rows whose cells
// differ from the cached copy, or for all rows when the viewport width, the
// row count, or the selection generation changed. A nil row means the frame
// holds no cells there; render still decides its text (usually "").
//
// width is the padded viewport width the final strings target, and selGen
// is a caller-owned counter bumped whenever selection state changes, since
// selection restyles rows without touching frame cells.
func (c *RowCache) Update(frame Frame, height, width int, selGen uint64, render func(y int, row []Cell) string) []string {
	if height < 0 {
		height = 0
	}
	if !c.live || c.width != width || c.selGen != selGen || len(c.rows) != height {
		out := make([]string, height)
		rows := make([]cachedRow, height)
		for y := 0; y < height; y++ {
			var have []Cell
			if y < len(frame.Cells) {
				have = frame.Cells[y]
			}
			out[y] = render(y, have)
			rows[y] = cachedRow{cells: append([]Cell(nil), have...), text: out[y]}
		}
		c.rows, c.width, c.selGen, c.live = rows, width, selGen, true
		return out
	}
	out := make([]string, height)
	for y := 0; y < height; y++ {
		var have []Cell
		if y < len(frame.Cells) {
			have = frame.Cells[y]
		}
		if SameRow(c.rows[y].cells, have) {
			out[y] = c.rows[y].text
			continue
		}
		out[y] = render(y, have)
		c.rows[y] = cachedRow{cells: append([]Cell(nil), have...), text: out[y]}
	}
	c.selGen = selGen
	return out
}
