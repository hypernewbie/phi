package phic

import (
	"github.com/hypernewbie/phi/internal/termemu"
	"strings"
	"testing"
)

// Measures actual native history scrolling, screen snapshot and full console
// render against a 10,000-row scrollback, not only the row-delta helper.
func BenchmarkConsoleHistoryScroll(b *testing.B) {
	m := deltaTestModel()
	m.width, m.height = 160, 45
	tab := deltaTestTab(m)
	r := m.terminalInner()
	emu, err := termemu.NewGhostty(termemu.Options{Cols: r.W, Rows: r.H, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
	if err != nil {
		b.Skip(err)
	}
	defer emu.Close()
	output := []byte(strings.Repeat("\x1b[36mhistory book 你🙂\x1b[0m\r\n", 120000))
	if err = emu.Feed(output, termemu.SourceLive); err != nil {
		b.Fatal(err)
	}
	tab.actor = &paneActor{emu: emu, frameOK: true}
	if err = emu.(interface{ ScrollViewport(int) error }).ScrollViewport(-9000); err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(output)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		delta := 1
		if i%2 == 0 {
			delta = -1
		}
		if err = emu.(interface{ ScrollViewport(int) error }).ScrollViewport(delta); err != nil {
			b.Fatal(err)
		}
		if err = tab.actor.refreshFrame(); err != nil {
			b.Fatal(err)
		}
		m.View()
	}
}
