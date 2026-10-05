package phic

import (
	"bytes"
	"testing"
)

func TestRepaintSuppressesQueriesNotApplicationOutput(t *testing.T) {
	for _, query := range []string{"\x05", "\x1bZ", "\x1b[6n", "\x1b[c", "\x1b[>c", "\x1b[?2004$p", "\x1b[?u", "\x1b]11;?\a", "\x1b]52;c;?\x1b\\", "\x1b]52;c;Y29weQ==\a", "\x1bP+q544e\x1b\\", "\x1bP$qm\x1b\\", "\xc2\x9b6n", "\x9b6n"} {
		t.Run(query, func(t *testing.T) {
			source := []byte("before" + query + "\x1b[31m界 🐙 Û\x1b[0m\x1b]0;title?\aafter")
			want := []byte("before\x1b[31m界 🐙 Û\x1b[0m\x1b]0;title?\aafter")
			for split := 0; split <= len(source); split++ {
				var f repaintFilter
				a, err := f.Feed(source[:split], true)
				if err != nil {
					t.Fatal(err)
				}
				b, err := f.Feed(source[split:], true)
				if err != nil {
					t.Fatal(err)
				}
				if got := append(a, b...); !bytes.Equal(got, want) {
					t.Fatalf("split %d: got %q want %q", split, got, want)
				}
				// A new live query must reach the native terminal unchanged.
				live, err := f.Feed([]byte(query), false)
				if err != nil || !bytes.Equal(live, []byte(query)) {
					t.Fatalf("live query changed: %q %v", live, err)
				}
			}
		})
	}
}

func TestRepaintControlEndingInLiveFrameKeepsItsOriginalPolicy(t *testing.T) {
	for _, tc := range []struct{ old, live, want string }{
		{"text\x1b[6", "nLIVE\x1b[6n", "textLIVE\x1b[6n"},
		{"text\x1b]11;?", "\aLIVE\x1b]11;?\a", "textLIVE\x1b]11;?\a"},
		{"text\x1b[3", "1mRED", "text\x1b[31mRED"},
		{"text\x1b]0;ti", "tle\a", "text\x1b]0;title\a"},
		{"text\xc2", "\x9b6nLIVE", "textLIVE"},
	} {
		var f repaintFilter
		a, err := f.Feed([]byte(tc.old), true)
		if err != nil {
			t.Fatal(err)
		}
		b, err := f.Feed([]byte(tc.live), false)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(append(a, b...)); got != tc.want {
			t.Fatalf("%q + %q = %q want %q", tc.old, tc.live, got, tc.want)
		}
	}
}

func TestRepaintNeverTruncatesAnOversizedControl(t *testing.T) {
	var f repaintFilter
	if _, err := f.Feed(append([]byte("\x1b]0;"), bytes.Repeat([]byte("x"), maxRepaintControl)...), true); err == nil {
		t.Fatal("oversize control silently accepted")
	}
}

func TestRepaintPlainBinaryAndUnicodeRemainByteExact(t *testing.T) {
	source := []byte("\x00\xffUTF8 Û 界 🐙\r\n\x1b[?1049hALT\x1b[?1006h\x1b[>1u\x1b[?1049l")
	var f repaintFilter
	var got []byte
	for _, b := range source {
		out, err := f.Feed([]byte{b}, true)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, out...)
	}
	if !bytes.Equal(got, source) {
		t.Fatalf("repaint corrupted output: %q", got)
	}
}
