package textarea

import (
	tea "charm.land/bubbletea/v2"
	"fmt"
	"github.com/charmbracelet/x/ansi"
	"strings"
	"testing"
)

func TestWindowedComposeKeepsEveryPastedLineAndPagesTheCursor(t *testing.T) {
	var source strings.Builder
	for i := 0; i < 12000; i++ {
		fmt.Fprintf(&source, "row-%05d 你🙂\n", i)
	}
	m := New()
	m.Windowed = true
	m.DynamicHeight = true
	m.MinHeight = 1
	m.MaxHeight = 8
	m.SetWidth(32)
	m.Focus()
	m, _ = m.Update(tea.PasteMsg{Content: source.String()})
	if got := m.Value(); got != source.String() {
		t.Fatalf("large paste was truncated or reordered: got bytes=%d want=%d lines=%d max=%d", len(got), source.Len()-1, m.LineCount(), m.MaxHeight)
	}
	visible := ansi.Strip(m.ViewWindow())
	if !strings.Contains(visible, "row-11999") || strings.Contains(visible, "row-00000") {
		t.Fatalf("compose viewport does not show only its latest page: %q", visible)
	}
	m.PageUp()
	m.PageUp()
	earlier := ansi.Strip(m.ViewWindow())
	if !strings.Contains(earlier, "row-11990") || strings.Contains(earlier, "row-11999") {
		t.Fatalf("page-up did not move the editable viewport: %q", earlier)
	}
	if got := m.Value(); got != source.String() {
		t.Fatal("scrolling changed staged bytes")
	}
}

func TestWindowedComposeMouseWheelPreservesTextAndChangesOnlyViewport(t *testing.T) {
	m := New()
	m.Windowed = true
	m.DynamicHeight = true
	m.MaxHeight = 5
	m.SetWidth(24)
	m.Focus()
	var source strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&source, "book-%03d\n", i)
	}
	m, _ = m.Update(tea.PasteMsg{Content: source.String()})
	value := m.Value()
	before := m.windowTop
	m.viewport.MouseWheelEnabled = true
	m, _ = m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelUp})
	if m.windowTop >= before {
		t.Fatalf("wheel-up did not expose earlier text: before=%d after=%d lines=%d height=%d manual=%t", before, m.windowTop, m.LineCount(), m.height, m.windowManual)
	}
	if m.Value() != value {
		t.Fatal("wheel-up modified staged input")
	}
}
