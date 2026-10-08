package phic

import (
	tea "charm.land/bubbletea/v2"
	"fmt"
	"strings"
	"testing"
)

func performanceCompose(size int) *tuiModel {
	m := deltaTestModel()
	m.width, m.height = 160, 45
	tab := deltaTestTab(m)
	r := m.terminalInner()
	tab.actor = &paneActor{frame: deltaTestFrame(r.W, r.H), frameOK: true}
	m.openCompose()
	if !m.compose.open {
		panic("compose benchmark did not open its editor")
	}
	if size > 0 {
		m.handlePaste(tea.PasteMsg{Content: strings.Repeat("large pasted input with Unicode 你 🙂 and spaces ", size/55+1)})
	}
	_ = tab
	return m
}

func BenchmarkComposeLargeInput(b *testing.B) {
	for _, size := range []int{8 << 10, 64 << 10, 512 << 10} {
		b.Run(fmt.Sprint(size), func(b *testing.B) {
			m := performanceCompose(size)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				m.View()
			}
		})
	}
}
func BenchmarkComposeKeyAfterLargePaste(b *testing.B) {
	text := strings.Repeat("pasted input line with Unicode 你 🙂\n", 10000)
	m := performanceCompose(0)
	m.handlePaste(tea.PasteMsg{Content: text})
	m.View()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		m.handleComposeKey(composeKey('x', "x"))
		m.View()
		// Keep a fixed workload: otherwise benchmark calibration grows a
		// progressively longer last line and measures a different editor.
		m.handleComposeKey(composeKey(tea.KeyBackspace, ""))
		m.View()
	}
	b.StopTimer()
	b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(2*b.N), "ns/key-paint")
	if got := m.compose.area.Value(); got != text {
		b.Fatal("edit cycle changed the pasted value")
	}
}

func BenchmarkComposePasteAndPaint(b *testing.B) {
	line := "pasted input with Unicode 你 🙂\n"
	for _, size := range []int{8 << 10, 64 << 10, 512 << 10} {
		text := strings.Repeat(line, size/len(line)+1)
		b.Run(fmt.Sprint(len(text)), func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(text)))
			for i := 0; i < b.N; i++ {
				m := performanceCompose(0)
				m.handlePaste(tea.PasteMsg{Content: text})
				m.View()
			}
		})
	}
}
