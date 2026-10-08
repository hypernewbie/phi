package textarea

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func reviewEditor(width int) Model {
	m := New()
	m.Windowed = true
	m.Prompt = ""
	m.ShowLineNumbers = false
	m.DynamicHeight = true
	m.MaxHeight = 3
	m.MinHeight = 1
	m.SetWidth(width)
	m.Focus()
	return m
}

func TestWindowedVisualRowsMatchWrapping(t *testing.T) {
	for _, text := range []string{"12345678\ntail", "你你你你\ntail", "🙂🙂🙂🙂\ntail", "abcd\n12345678\ntail", "你你你\n你你你你\ntail"} {
		t.Run(text, func(t *testing.T) {
			m := reviewEditor(8)
			m.SetValue(text)
			want := 0
			for _, line := range m.value {
				want += len(wrap(line, m.width))
			}
			if got := m.totalVisualLines(); got != want {
				t.Fatalf("visual rows=%d want=%d", got, want)
			}
			wantCursor := 0
			for _, line := range m.value[:m.row] {
				wantCursor += len(wrap(line, m.width))
			}
			wantCursor += m.LineInfo().RowOffset
			if got := m.cursorLineNumber(); got != wantCursor {
				t.Fatalf("cursor row=%d want=%d", got, wantCursor)
			}
			if rows := strings.Count(ansi.Strip(m.ViewWindow()), "\n") + 1; rows != m.Height() {
				t.Fatalf("bounded renderer returned %d rows for height %d", rows, m.Height())
			}
			full := strings.Split(m.view(), "\n")
			window := strings.TrimSuffix(m.ViewWindow(), "\n")
			wantView := strings.Join(full[m.windowTop:m.windowTop+m.Height()], "\n")
			if ansi.Strip(window) != ansi.Strip(wantView) {
				t.Fatalf("viewport differs\ngot %q\nwant %q", window, wantView)
			}
		})
	}
}

func TestWindowedReplaceSelectionShrinksAndResetReturnsToTop(t *testing.T) {
	for _, msg := range []tea.Msg{tea.PasteMsg{Content: "x"}, tea.KeyPressMsg{Code: 'x', Text: "x"}} {
		m := reviewEditor(20)
		m.SetValue(strings.Repeat("row\n", 100))
		m.SelectAll()
		m, _ = m.Update(msg)
		if m.Value() != "x" || m.Height() != 1 || m.windowTop != 0 {
			t.Fatalf("replacement left stale geometry: value=%q height=%d top=%d", m.Value(), m.Height(), m.windowTop)
		}
	}
	m := reviewEditor(20)
	m.SetValue(strings.Repeat("row\n", 100))
	m.windowManual = true
	m.Reset()
	if m.windowTop != 0 || m.windowManual {
		t.Fatalf("reset retained historical view: top=%d manual=%t", m.windowTop, m.windowManual)
	}
}

func TestWindowedSelectionUsesVisibleRows(t *testing.T) {
	m := reviewEditor(20)
	m.SetValue(strings.Repeat("first\n", 20) + "visible row\nlast")
	top := m.windowTop
	if top == 0 {
		t.Fatal("test did not scroll")
	}
	if m.ScrollYOffset() != top {
		t.Fatal("reported scroll offset differs from view")
	}
	if pos := m.PositionAt(0, 0); pos.Row != top {
		t.Fatalf("click selected row %d instead of visible row %d", pos.Row, top)
	}
	m.BeginSelection(0, 0)
	m.ExtendSelection(3, 0)
	m.EndSelection()
	if want := string(m.value[top][:3]); m.SelectedText() != want {
		t.Fatalf("selected %q want %q", m.SelectedText(), want)
	}
}

func TestWindowedUpdatesKeepWrapCacheAndResetCursorOnVerticalMove(t *testing.T) {
	m := reviewEditor(20)
	m.SetValue("first\nsecond")
	cache := m.cache
	m.virtualCursor.IsBlinked = true
	m, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	if m.cache != cache {
		t.Fatal("each input discards the wrap cache")
	}
	if m.virtualCursor.IsBlinked {
		t.Fatal("vertical movement left cursor invisible")
	}
}
