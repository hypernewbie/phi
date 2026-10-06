package phic

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func readMenuKey(ctx context.Context, t lineTerminal, servers int) (string, error) {
	return (&menuReader{}).read(ctx, t, servers)
}

type viewTerminal struct {
	input  *bytes.Reader
	output bytes.Buffer
}

func (v *viewTerminal) ReadContext(ctx context.Context, b []byte) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return v.input.Read(b)
}
func (v *viewTerminal) Write(b []byte) (int, error) { return v.output.Write(b) }

func TestInlineViewNavigationAndSearch(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "xterm-256color")
	for _, tc := range []struct {
		name, keys string
		want       int
	}{
		{"enter focused", "\r", 0},
		{"arrow selection", "\x1b[B\x1b[B\x1b[A\r", 1},
		{"enhanced arrows", "\x1b[57353;1u\x1b[57353;1:3u\r", 1},
		{"number compatibility", "3\r", 2},
		{"search stable identity", "/Beta\r", 1},
		{"unicode search", "/東京\r", 2},
		{"backspace whole rune", "/東亰\x7f京\r", 2},
		{"search q is text", "/queue\r", 3},
		{"end", "\x1b[F\r", 3},
		{"home", "\x1b[F\x1b[H\r", 0},
		{"paste cannot choose", "\x1b[200~3\r\x1b[B\x1d2\x1b[201~\r", 0},
		{"reports ignored", "\x1b[1;2R\x1b[?100;0$y\r", 0},
		{"binary mouse coords opaque", "\x1b[Mq\r\x1d\r", 0},
		{"OSC replies opaque", "\x1b]11;rgb:aa/bb/cc\a\x1b]52;c;queue\x1b\\\r", 0},
		{"DCS replies opaque", "\x1bP1$r0m\x1b\\\r", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := &viewTerminal{input: bytes.NewReader([]byte(tc.keys))}
			c := &client{servers: []*serverState{{profile: desktopProfile{Name: "ALPHA"}, identity: serverIdentity{Theme: "blue"}}}}
			got, err := c.selectionView(t.Context(), v, func() (int, int, error) { return 80, 20, nil }, "Sessions", []string{"Alpha", "Beta", "東京", "queue"}, nil)
			if err != nil || got != tc.want {
				t.Fatalf("choice %d, %v; want %d", got, err, tc.want)
			}
			out := v.output.String()
			if !strings.Contains(out, "↑↓ Select") || !strings.Contains(out, "48;2;56;189;248m") || !strings.Contains(out, "› 1") {
				t.Fatalf("no focused themed selection: %q", out)
			}
			if strings.Contains(out, "number + Enter") || strings.Contains(out, "\x1b[?1049h") {
				t.Fatalf("DOS prompt or alternate-screen menu: %q", out)
			}
		})
	}
}

func TestMenuServerShortcutsFromSelection(t *testing.T) {
	for _, keys := range []string{"\x1b[50;5u", "\x1d2", "\x1b[93;5u2", "\x1b[93;5u\x1b[50;1u"} {
		v := &viewTerminal{input: bytes.NewReader([]byte(keys))}
		_, err := readMenuKey(t.Context(), v, 2)
		var command viewCommand
		if !errors.As(err, &command) || command != '2' {
			t.Fatalf("shortcut %q: %v", keys, err)
		}
	}
	v := &viewTerminal{input: bytes.NewReader([]byte("\x1db"))}
	_, err := readMenuKey(t.Context(), v, 2)
	var command viewCommand
	if !errors.As(err, &command) || command != 'b' {
		t.Fatalf("server bar shortcut: %v", err)
	}
}

func TestMenuMetadataCannotInjectControlsAndClippingKeepsRunes(t *testing.T) {
	out := menuLabel("東京\x1b]52;c;attack\a\n\u202e")
	if strings.ContainsAny(out, "\x1b\a\n\u202e") || !strings.Contains(out, "東京") {
		t.Fatalf("unsafe/unreadable metadata: %q", out)
	}
	for cols := 0; cols < 10; cols++ {
		if text := clipMenu("A東京é", cols); !utf8.ValidString(text) {
			t.Fatalf("split Unicode at %d: %q", cols, text)
		}
	}
	if clipMenu("A東京", 4) != "A東" {
		t.Fatal("wide glyphs wrap the inline view")
	}
}

func TestAddressPasteIsTextNotNavigation(t *testing.T) {
	v := &viewTerminal{input: bytes.NewReader([]byte("\x1b[200~https://queue.test:7070\x1b[201~\r"))}
	reader := menuReader{allowPaste: true}
	var out string
	for {
		key, err := reader.read(t.Context(), v, 2)
		if err != nil {
			t.Fatal(err)
		}
		if key == "enter" {
			break
		}
		out += key
	}
	if out != "https://queue.test:7070" {
		t.Fatalf("pasted address corrupted: %q", out)
	}
}

func TestMenuPaginationAndEmptyFilter(t *testing.T) {
	items := make([]string, 100)
	for i := range items {
		items[i] = "Session"
	}
	for _, keys := range []string{"\x1b[6~\x1b[6~\x1b[5~\r", "/nomatch\x1b"} {
		v := &viewTerminal{input: bytes.NewReader([]byte(keys))}
		c := &client{}
		_, err := c.selectionView(t.Context(), v, func() (int, int, error) { return 32, 10, nil }, "Sessions", items, nil)
		if err != nil && !errors.Is(err, errDetach) && !errors.Is(err, io.EOF) {
			t.Fatal(err)
		}
		if strings.Count(v.output.String(), "Session\r\n") >= 100 {
			t.Fatal("selection dumped the whole collection")
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Millisecond)
	defer cancel()
	cancel()
	v := &viewTerminal{input: bytes.NewReader(nil)}
	if _, err := readMenuKey(ctx, v, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("menu ignores cancellation: %v", err)
	}
}
