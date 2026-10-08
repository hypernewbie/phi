package termstate

import (
	"bytes"
	"testing"
)

func TestANSIStatePreservesClientThemeAndExplicitPTYColours(t *testing.T) {
	e, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.Feed([]byte("\x1b[32mgreen text")); err != nil {
		t.Fatal(err)
	}
	plain, err := e.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(plain, []byte("\x1b]4;")) {
		t.Fatal("server defaults override the client ANSI palette")
	}
	if err = e.Feed([]byte("\x1b]4;2;rgb:12/34/56\x1b\\\x1b]11;rgb:23/45/67\x1b\\")); err != nil {
		t.Fatal(err)
	}
	changed, err := e.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Count(changed, []byte("\x1b]4;")) != 1 || !bytes.Contains(changed, []byte("\x1b]4;2;rgb:12/34/56\x1b\\")) || !bytes.Contains(changed, []byte("\x1b]11;rgb:23/45/67\x1b\\")) {
		t.Fatal("explicit PTY colours missing or defaults leaked")
	}
}

func TestANSIStateFormattingPreservesLiveHistory(t *testing.T) {
	e, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.Feed(bytes.Repeat([]byte("history line\r\n"), 2000)); err != nil {
		t.Fatal(err)
	}
	before, err := e.HistoryRows()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err = e.FormatVTState(); err != nil {
			t.Fatal(err)
		}
	}
	after, err := e.HistoryRows()
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("attaching changed live history: before=%d after=%d", before, after)
	}
}

func TestANSIStateMatchesUninterruptedBothScreensAtEveryCut(t *testing.T) {
	for _, source := range []string{
		"\x1b[?1049hALT 你🙂\x1b[3;5H",
		"\x1b[?47hALT\x1b[?47lPRIMARY",
		"\x1b[?1049hALT\x1b]2;unfinished\x1b\\visible",
		"\x1b[4;5H\x1b7\x1b[1;2Hsaved cursor",
		"\x1b[2;6r\x1b[?6hmargin rows\x1b[2;4H",
		"\x1b[31m\x1b[4;5H\x1b7\x1b[0m\x1b[1;2Hstyle",
		"\x1b[2;6r\x1b[?6hPRIMARY\x1b[?1049hALT",
		"12345678901234567890123\x1b7\x1b[1;2Hwrap saved",
		"\x1b(0\x1b7\x1b(Bcharset",
	} {
		t.Run(source, func(t *testing.T) {
			for cut := 0; cut <= len(source); cut++ {
				original, err := New(t.Context(), 30, 8)
				if err != nil {
					t.Fatal(err)
				}
				restored, err := New(t.Context(), 30, 8)
				if err != nil {
					t.Fatal(err)
				}
				if err = original.Feed([]byte("PRIMARY " + source[:cut])); err != nil {
					t.Fatal(err)
				}
				state, err := original.FormatVTState()
				if err != nil {
					t.Fatal(err)
				}
				continuation, err := original.Continuation()
				if err != nil {
					t.Fatal(err)
				}
				if err = restored.Feed(append(state, continuation...)); err != nil {
					t.Fatal(err)
				}
				for _, suffix := range []string{source[cut:], "\x1b8RESTORE", "\x1b[?1049l EXIT", "\x1b[?47l after", "\x1b[?47h"} {
					if err = original.Feed([]byte(suffix)); err != nil {
						t.Fatal(err)
					}
					if err = restored.Feed([]byte(suffix)); err != nil {
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
						at := 0
						for at < min(len(got), len(want)) && got[at] == want[at] {
							at++
						}
						t.Fatalf("ANSI checkpoint differs cut=%d suffix=%q byte=%d\ngot=%q\nwant=%q", cut, suffix, at, got[max(0, at-16):min(len(got), at+80)], want[max(0, at-16):min(len(want), at+80)])
					}
				}
				original.Close()
				restored.Close()
			}
		})
	}
}
