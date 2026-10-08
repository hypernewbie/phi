package phic

import (
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/internal/termemu/stub"
	"testing"
)

func TestOverlayMatchesCompositor(t *testing.T) {
	for _, base := range []string{"abcdefghijklmnop\nqrstuvwxyz123456", "你你🙂abcdefghijkl\nabcdefghijklmnop", "\x1b[31mabcdefghijklmnop\x1b[0m\nqrstuvwxyz123456", "\x1b[1;31mabcdef\x1b[0mgh\x1b[44mijklmnop\x1b[0m\nqrstuvwxyz123456"} {
		for _, box := range []string{"╭──╮\n╰──╯", "\x1b[44;33m你界\x1b[0m"} {
			for _, x := range []int{-2, 0, 1, 2, 3, 9, 14, 15} {
				expected := lg.NewCompositor(lg.NewLayer(base), lg.NewLayer(box).X(x).Y(0).Z(1)).Render()
				actual := overlayLines(base, box, x, 0, 16, 2)
				read := func(s string) termemu.Frame {
					e, _ := stub.New(termemu.Options{Cols: 16, Rows: 2, ScrollbackBytes: 4096, ScrollbackLines: 32})
					defer e.Close()
					e.Feed([]byte(s), termemu.SourceReplay)
					f, _ := e.Snapshot()
					return f
				}
				// Independent ANSI geometry catches style leaks and wide-glyph cuts.
				if ansi.Truncate(ansi.Strip(actual), 16, "") == "" {
					t.Fatal("empty overlay")
				}
				a, b := read(actual), read(expected)
				for y := 0; y < 2; y++ {
					for col := 0; col < 16; col++ {
						if a.Cells[y][col] != b.Cells[y][col] {
							t.Fatalf("overlay differs x=%d cell=%d,%d base=%q box=%q actual=%q expected=%q", x, col, y, base, box, actual, expected)
						}
					}
				}
			}
		}
	}
}
