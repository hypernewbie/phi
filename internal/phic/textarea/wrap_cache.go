package textarea

import "slices"

// A single large logical line needs exact comparison, not repeated UTF-8
// conversion and digest allocation. The frozen runes detect in-place edits.
// Only one such line is retained; short lines use the existing bounded cache.
type wrapEntry struct {
	runes []rune
	width int
	rows  [][]rune
}

func (e *wrapEntry) get(r []rune, width int) [][]rune {
	if e.width == width && slices.Equal(e.runes, r) {
		return e.rows
	}
	e.runes = append(e.runes[:0], r...)
	e.width = width
	e.rows = wrap(r, width)
	return e.rows
}
