//go:build termemu_ghostty

package termemu

import (
	"strings"
	"testing"
)

func newTestTerminal(t *testing.T, cols, rows int, opts *Options) Terminal {
	t.Helper()
	o := Options{Cols: cols, Rows: rows, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000}
	if opts != nil {
		o.Events = opts.Events
	}
	term, err := NewGhostty(o)
	if err != nil {
		t.Fatalf("NewGhostty: %v", err)
	}
	t.Cleanup(func() { _ = term.Close() })
	return term
}

func rowText(f Frame, y int) string {
	var b strings.Builder
	for _, c := range f.Cells[y] {
		b.WriteString(c.Text)
	}
	return b.String()
}

func TestGhosttyScreenTextAndCursor(t *testing.T) {
	term := newTestTerminal(t, 20, 5, nil)
	if err := term.Feed([]byte("hello\r\nworld"), SourceLive); err != nil {
		t.Fatal(err)
	}
	f, err := term.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if f.Cols != 20 || f.Rows != 5 {
		t.Fatalf("geometry = %dx%d, want 20x5", f.Cols, f.Rows)
	}
	if got := rowText(f, 0); !strings.HasPrefix(got, "hello") {
		t.Fatalf("row0 = %q", got)
	}
	if got := rowText(f, 1); !strings.HasPrefix(got, "world") {
		t.Fatalf("row1 = %q", got)
	}
	if f.Cursor.X != 5 || f.Cursor.Y != 1 {
		t.Fatalf("cursor = %+v, want (5,1)", f.Cursor)
	}
}

func TestGhosttyColors(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	if err := term.Feed([]byte("\x1b[31mR\x1b[38;2;1;2;3mT"), SourceLive); err != nil {
		t.Fatal(err)
	}
	f, err := term.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	red := f.Cells[0][0]
	if red.Fg.Kind != ColorPalette || red.Fg.Value != 1 {
		t.Fatalf("palette cell fg = %+v, want palette 1", red.Fg)
	}
	true := f.Cells[0][1]
	if true.Fg.Kind != ColorRGB || true.Fg.Value != 0x010203 {
		t.Fatalf("rgb cell fg = %+v, want rgb 010203", true.Fg)
	}
}

func TestGhosttyStyles(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	if err := term.Feed([]byte("\x1b[1;2;3;4;9mS"), SourceLive); err != nil {
		t.Fatal(err)
	}
	f, err := term.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	c := f.Cells[0][0]
	if !c.Bold || !c.Faint || !c.Italic || c.Underline != UnderlineStraight || !c.Strikethrough {
		t.Fatalf("style = %+v", c)
	}
}

func TestGhosttyModesAndAlternateScreen(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	for mode, seq := range map[Mode]string{
		ModeApplicationCursor:  "\x1b[?1h",
		ModeApplicationKeypad:  "\x1b[?66h",
		ModeBracketedPaste:     "\x1b[?2004h",
		ModeMouseButton:        "\x1b[?1000h",
		ModeMouseMotion:        "\x1b[?1002h",
		ModeMouseAny:           "\x1b[?1003h",
		ModeMouseSgr:           "\x1b[?1006h",
		ModeMouseUrxvt:         "\x1b[?1015h",
		ModeSynchronizedOutput: "\x1b[?2026h",
	} {
		if err := term.Feed([]byte(seq), SourceLive); err != nil {
			t.Fatal(err)
		}
		on, err := term.Mode(mode)
		if err != nil {
			t.Fatalf("mode %d: %v", mode, err)
		}
		if !on {
			t.Fatalf("mode %d not enabled by %q", mode, seq)
		}
	}
	if err := term.Feed([]byte("\x1b[?1049h"), SourceLive); err != nil {
		t.Fatal(err)
	}
	if on, _ := term.Mode(ModeAlternateScreen); !on {
		t.Fatal("alternate screen not active")
	}
	if err := term.Feed([]byte("\x1b[?1049l"), SourceLive); err != nil {
		t.Fatal(err)
	}
	if on, _ := term.Mode(ModeAlternateScreen); on {
		t.Fatal("alternate screen still active")
	}
}

func TestGhosttyKeyApplicationCursor(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	got, err := term.EncodeKey(KeyEvent{Action: KeyPress, Key: KeyArrowUp})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x1b[A" {
		t.Fatalf("normal arrow = %q, want ESC[A", got)
	}
	if err := term.Feed([]byte("\x1b[?1h"), SourceLive); err != nil {
		t.Fatal(err)
	}
	got, err = term.EncodeKey(KeyEvent{Action: KeyPress, Key: KeyArrowUp})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x1bOA" {
		t.Fatalf("application arrow = %q, want ESCOA", got)
	}
}

func TestGhosttyKeyEnhancedEncoding(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	// Push Kitty disambiguate flag (CSI > 1 u).
	if err := term.Feed([]byte("\x1b[>1u"), SourceLive); err != nil {
		t.Fatal(err)
	}
	got, err := term.EncodeKey(KeyEvent{Action: KeyPress, Key: KeyEnter, Mods: ModShift})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x1b[13;2u" {
		t.Fatalf("shift+enter = %q, want CSI 13;2u", got)
	}
	got, err = term.EncodeKey(KeyEvent{Action: KeyPress, Key: KeyRune, Mods: ModCtrl, Text: "1", Unshifted: '1'})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x1b[49;5u" {
		t.Fatalf("ctrl+1 = %q, want CSI 49;5u", got)
	}
}

func TestGhosttyKeyPlainAndControl(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	got, err := term.EncodeKey(KeyEvent{Action: KeyPress, Key: KeyRune, Text: "a", Unshifted: 'a'})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "a" {
		t.Fatalf("plain a = %q", got)
	}
	got, err = term.EncodeKey(KeyEvent{Action: KeyPress, Key: KeyRune, Mods: ModCtrl, Text: "a", Unshifted: 'a'})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x01" {
		t.Fatalf("ctrl+a = %q, want 0x01", got)
	}
	got, err = term.EncodeKey(KeyEvent{Action: KeyPress, Key: KeyEnter})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\r" {
		t.Fatalf("enter = %q, want CR", got)
	}
	got, err = term.EncodeKey(KeyEvent{Action: KeyPress, Key: KeyBackspace})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x7f" {
		t.Fatalf("backspace = %q, want DEL", got)
	}
}

func TestGhosttyMouseSGR(t *testing.T) {
	term := newTestTerminal(t, 20, 5, nil)
	if err := term.Feed([]byte("\x1b[?1000h\x1b[?1006h"), SourceLive); err != nil {
		t.Fatal(err)
	}
	got, err := term.EncodeMouse(MousePress, MouseLeft, 0, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x1b[<0;1;1M" {
		t.Fatalf("press at (0,0) = %q, want SGR 1;1", got)
	}
	got, err = term.EncodeMouse(MouseRelease, MouseLeft, 0, 3, 2)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x1b[<0;4;3m" {
		t.Fatalf("release at (3,2) = %q, want SGR 4;3", got)
	}
}

func TestGhosttyPasteModes(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	got, err := term.EncodePaste([]byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hi" {
		t.Fatalf("plain paste = %q, want hi", got)
	}
	if err := term.Feed([]byte("\x1b[?2004h"), SourceLive); err != nil {
		t.Fatal(err)
	}
	got, err = term.EncodePaste([]byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "\x1b[200~hi\x1b[201~" {
		t.Fatalf("bracketed paste = %q", got)
	}
}

func TestGhosttyRepliesLiveAndReplay(t *testing.T) {
	var replies [][]byte
	term := newTestTerminal(t, 10, 2, &Options{Events: EventOptions{OnReply: func(b []byte) { replies = append(replies, b) }}})
	if err := term.Feed([]byte("\x1b[6n"), SourceLive); err != nil {
		t.Fatal(err)
	}
	if len(replies) == 0 || !strings.HasSuffix(string(replies[len(replies)-1]), "R") {
		t.Fatalf("live DSR replies = %q", replies)
	}
	replies = nil
	if err := term.Feed([]byte("\x1b[6n"), SourceReplay); err != nil {
		t.Fatal(err)
	}
	if len(replies) != 0 {
		t.Fatalf("replay DSR produced replies: %q", replies)
	}
}

func TestGhosttyTitleMetadata(t *testing.T) {
	var title string
	term := newTestTerminal(t, 10, 2, &Options{Events: EventOptions{OnTitle: func(s string) { title = s }}})
	if err := term.Feed([]byte("\x1b]0;phi-title\x07"), SourceLive); err != nil {
		t.Fatal(err)
	}
	if title != "phi-title" {
		t.Fatalf("title = %q", title)
	}
}

func TestGhosttyResize(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	if err := term.Resize(30, 8); err != nil {
		t.Fatal(err)
	}
	f, err := term.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if f.Cols != 30 || f.Rows != 8 {
		t.Fatalf("geometry after resize = %dx%d", f.Cols, f.Rows)
	}
	if err := term.Resize(0, 5); err != ErrInvalidGeometry {
		t.Fatalf("zero geometry err = %v, want ErrInvalidGeometry", err)
	}
}

func TestGhosttyHistoryAndMemory(t *testing.T) {
	term := newTestTerminal(t, 20, 4, nil)
	var b strings.Builder
	for i := 0; i < 200; i++ {
		b.WriteString("line ")
		b.WriteString(strings.Repeat("x", 10))
		b.WriteString("\r\n")
	}
	if err := term.Feed([]byte(b.String()), SourceLive); err != nil {
		t.Fatal(err)
	}
	f, err := term.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if f.History == 0 {
		t.Fatal("history is zero after 200 lines in a 4-row terminal")
	}
	if f.PageID == 0 {
		t.Fatal("history revision is zero")
	}
	mem, err := term.NativeMemory()
	if err != nil {
		t.Fatal(err)
	}
	if mem == 0 {
		t.Fatal("native memory is zero after scrollback")
	}
}

func TestGhosttyWideAndCombining(t *testing.T) {
	term := newTestTerminal(t, 10, 2, nil)
	if err := term.Feed([]byte("界e\xcc\x81"), SourceLive); err != nil {
		t.Fatal(err)
	}
	f, err := term.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if f.Cells[0][0].Text != "界" || f.Cells[0][0].Width != 2 {
		t.Fatalf("wide cell = %+v", f.Cells[0][0])
	}
	if f.Cells[0][1].Width != 0 {
		t.Fatalf("spacer tail width = %d, want 0", f.Cells[0][1].Width)
	}
	if f.Cells[0][2].Text != "e\xcc\x81" {
		t.Fatalf("combining cell = %q", f.Cells[0][2].Text)
	}
}

func TestGhosttyValidation(t *testing.T) {
	if _, err := NewGhostty(Options{Cols: 0, Rows: 2, ScrollbackBytes: 1, ScrollbackLines: 1}); err != ErrInvalidGeometry {
		t.Fatalf("zero cols err = %v", err)
	}
	if _, err := NewGhostty(Options{Cols: 2, Rows: 2, ScrollbackBytes: 0, ScrollbackLines: 1}); err != ErrZeroBudget {
		t.Fatalf("zero budget err = %v", err)
	}
}
