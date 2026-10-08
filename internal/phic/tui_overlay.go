package phic

import (
	"github.com/charmbracelet/x/ansi"
	"strings"
)

// The base and overlay are already rendered ANSI rows. Splice the covered
// cells without allocating and parsing an entire screen-sized compositor.
// Cut restores styles at slice boundaries and never splits a wide grapheme.
func overlayLines(base, box string, x, y, width, height int) string {
	rows := strings.Split(base, "\n")
	for i, line := range strings.Split(box, "\n") {
		at := y + i
		if at < 0 || at >= height || at >= len(rows) {
			continue
		}
		left, right := max(0, x), min(width, x+ansi.StringWidth(line))
		if right <= left {
			continue
		}
		part := ansi.Cut(line, left-x, right-x)
		rows[at] = ansi.Cut(rows[at], 0, left) + part + ansi.Cut(rows[at], right, width)
	}
	return strings.Join(rows, "\n")
}
