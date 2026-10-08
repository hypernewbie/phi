package termstate

import (
	"bytes"
	"strings"
	"testing"
)

func TestVTFormatterReturnsCurrentScreen(t *testing.T) {
	e, err := New(t.Context(), 20, 6)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.Feed([]byte("\x1b[32mCURRENT GRID 42\x1b[0m")); err != nil {
		t.Fatal(err)
	}
	ansi, err := e.FormatVT()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(ansi, []byte("CURRENT GRID 42")) {
		t.Fatalf("formatted screen omitted content: %q", ansi)
	}
	t.Logf("ANSI screen bytes=%d", len(ansi))
}
func TestVTFormatterWithLongScrollback(t *testing.T) {
	e, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	source := bytes.Repeat([]byte("\x1b[31mcurrent library line\x1b[0m\r\n"), 10000)
	source = append(source, []byte("\x1b]2;unfinished title")...)
	if err = e.Feed(source); err != nil {
		t.Fatal(err)
	}
	ansi, err := e.FormatViewportVT()
	if err != nil {
		t.Fatal(err)
	}
	continuation, err := e.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("ansi=%d continuation=%d", len(ansi), len(continuation))
}
func TestVTStateCheckpointRetainsBothPrimaryAndAlternateScreens(t *testing.T) {
	original, err := New(t.Context(), 32, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	original.Feed([]byte("PRIMARY SCREEN"))
	original.Feed([]byte("\x1b[?1049hALT SCREEN\x1b[4;6Hcursor\x1b[?1049l"))
	beforeState, err := original.Ready()
	if err != nil {
		t.Fatal(err)
	}
	state, err := original.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	afterState, err := original.Ready()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beforeState, afterState) {
		t.Fatal("screen formatting mutated the live terminal")
	}
	continuation, err := original.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := New(t.Context(), 32, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err = restored.Feed(append(state, continuation...)); err != nil {
		t.Fatal(err)
	}
	original.Feed([]byte("\x1b[?1049h"))
	restored.Feed([]byte("\x1b[?1049h"))
	a, err := original.FormatVT()
	if err != nil {
		t.Fatal(err)
	}
	b, err := restored.FormatVT()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatalf("alternate screen lost on restore\\ngot %q\\nwant %q", b, a)
	}
	original.Feed([]byte("\x1b[?1049l after"))
	restored.Feed([]byte("\x1b[?1049l after"))
	a, err = original.FormatVT()
	if err != nil {
		t.Fatal(err)
	}
	b, err = restored.FormatVT()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatalf("primary screen lost on restore\\ngot %q\\nwant %q", b, a)
	}
}

func TestVTCheckpointPreservesContinuationAndLiveMode(t *testing.T) {
	for _, source := range []string{"\x1b[31mcolored\x1b[0m\r\n", "\x1b[?1049hALT SCREEN\x1b[3;5H", "\x1b]2;session title\x1b\\visible", "\x1bP$qm\x1b\\ready"} {
		for cut := 0; cut <= len(source); cut++ {
			original, err := New(t.Context(), 30, 8)
			if err != nil {
				t.Fatal(err)
			}
			if err = original.Feed([]byte("prefix ")); err != nil {
				t.Fatal(err)
			}
			if err = original.Feed([]byte(source[:cut])); err != nil {
				t.Fatal(err)
			}
			screen, err := original.FormatVT()
			if err != nil {
				t.Fatal(err)
			}
			continuation, err := original.Continuation()
			if err != nil {
				t.Fatal(err)
			}
			restored, err := New(t.Context(), 30, 8)
			if err != nil {
				t.Fatal(err)
			}
			if err = restored.Feed(append(screen, continuation...)); err != nil {
				t.Fatal(err)
			}
			suffix := []byte(source[cut:])
			if err = original.Feed(suffix); err != nil {
				t.Fatal(err)
			}
			if err = restored.Feed(suffix); err != nil {
				t.Fatal(err)
			}
			want, err := original.FormatVT()
			if err != nil {
				t.Fatal(err)
			}
			got, err := restored.FormatVT()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("formatted checkpoint diverged source=%q cut=%d\ngot=%q\nwant=%q", source, cut, got, want)
			}
			original.Close()
			restored.Close()
		}
	}
}
func TestReadyDoesNotSendTheLibrary(t *testing.T) {
	e, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	source := []byte(strings.Repeat("\x1b[32mretained book\x1b[0m\r\n", 100000) + "LATEST")
	if err = e.Feed(source); err != nil {
		t.Fatal(err)
	}
	snapshot, err := e.Ready()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot) >= len(source)/20 {
		t.Fatalf("snapshot %d bytes sends too much of %d-byte library", len(snapshot), len(source))
	}
	next, err := New(t.Context(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err = next.Restore(snapshot); err != nil {
		t.Fatal(err)
	}
	cols, rows := next.Geometry()
	if cols != 80 || rows != 24 {
		t.Fatal("snapshot geometry was not restored")
	}
	t.Logf("source=%d ready=%d", len(source), len(snapshot))
}
func TestReadyWindowBoundsLocalHistoryWithoutChangingSource(t *testing.T) {
	original, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	input := bytes.Repeat([]byte("ROW-0123456789 colored history content\r\n"), 5000)
	if err = original.Feed(input); err != nil {
		t.Fatal(err)
	}
	before, err := original.HistoryRows()
	if err != nil {
		t.Fatal(err)
	}
	bounded, err := original.ReadyWindow(64)
	if err != nil {
		t.Fatal(err)
	}
	local, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	if err = local.Restore(bounded); err != nil {
		t.Fatal(err)
	}
	after, err := local.HistoryRows()
	if err != nil {
		t.Fatal(err)
	}
	if before <= after || after > 64+256 {
		t.Fatalf("server history=%d local page-bounded history=%d", before, after)
	}
	fullScreen, err := original.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	boundedScreen, err := local.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(fullScreen, boundedScreen) {
		t.Fatal("history limit changed active terminal screen state")
	}
}

func TestReadyRestoresEveryParserContinuationCut(t *testing.T) {
	for _, source := range []string{"hello 你🙂!", "\x1b[31mcolor\x1b[0m", "\x1b[?1049h\x1b[3;4Halt\x1b[?1049l", "\x1b]2;title\x1b\\text", "\x1bP$qm\x1b\\done"} {
		for cut := 0; cut <= len(source); cut++ {
			e, err := New(t.Context(), 20, 6)
			if err != nil {
				t.Fatal(err)
			}
			if err = e.Feed([]byte(source[:cut])); err != nil {
				t.Fatal(err)
			}
			snapshot, err := e.Ready()
			if err != nil {
				t.Fatal(err)
			}
			restored, err := New(t.Context(), 1, 1)
			if err != nil {
				t.Fatal(err)
			}
			if err = restored.Restore(snapshot); err != nil {
				t.Fatal(err)
			}
			if err = e.Feed([]byte(source[cut:])); err != nil {
				t.Fatal(err)
			}
			if err = restored.Feed([]byte(source[cut:])); err != nil {
				t.Fatal(err)
			}
			a, err := e.Ready()
			if err != nil {
				t.Fatal(err)
			}
			b, err := restored.Ready()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(a, b) {
				t.Fatalf("continuation changed source=%q cut=%d", source, cut)
			}
			e.Close()
			restored.Close()
		}
	}
}
func BenchmarkFeedStream(b *testing.B) {
	e, err := New(b.Context(), 120, 40)
	if err != nil {
		b.Fatal(err)
	}
	defer e.Close()
	data := bytes.Repeat([]byte("\x1b[38;2;120;80;220mstream bytes 你🙂\x1b[0m\r\n"), 1024)
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := e.Feed(data); err != nil {
			b.Fatal(err)
		}
	}
}
