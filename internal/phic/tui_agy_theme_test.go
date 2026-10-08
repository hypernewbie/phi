package phic

import (
	"strings"
	"testing"

	"github.com/hypernewbie/phi/internal/termemu"
)

func TestAgyAnsiColorMapsOnlyAccentSlots(t *testing.T) {
	for _, tc := range []struct {
		index uint32
		want  string
	}{
		{index: 4, want: "5b4ec2"},
		{index: 5, want: "7c6af7"},
		{index: 6, want: "7c6af7"},
		{index: 12, want: "9a8dfa"},
		{index: 13, want: "9a8dfa"},
		{index: 14, want: "9a8dfa"},
	} {
		got := agyAnsiColor(termemu.Color{Kind: termemu.ColorPalette, Value: tc.index}, "purple")
		if got.Kind != termemu.ColorRGB || got.Value != mustRGB(t, tc.want) {
			t.Errorf("palette %d = %#v, want RGB #%s", tc.index, got, tc.want)
		}
	}

	for _, c := range []termemu.Color{
		{Kind: termemu.ColorPalette, Value: 1}, // semantic red stays red
		{Kind: termemu.ColorPalette, Value: 2}, // semantic green stays green
		{Kind: termemu.ColorPalette, Value: 200},
		{Kind: termemu.ColorRGB, Value: 0x123456},
		{Kind: termemu.ColorDefault},
	} {
		if got := agyAnsiColor(c, "purple"); got != c {
			t.Errorf("non-accent color %#v changed to %#v", c, got)
		}
	}
}

func TestAgyAnsiThemeRendersPerServerAndInvalidatesRowsOnThemeChange(t *testing.T) {
	t.Setenv("FORCE_COLOR", "3")
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("NO_COLOR", "")

	m := deltaTestModel()
	origin := "https://agy.example"
	m.data[origin] = &serverData{identity: serverIdentity{Theme: "purple"}}
	tab := &paneTab{key: paneKey{Origin: origin, ID: "agy"}, coder: "agy"}
	frame := termemu.Frame{
		Cols: 1,
		Rows: 1,
		Cells: [][]termemu.Cell{{{
			Text:  "A",
			Width: 1,
			Fg:    termemu.Color{Kind: termemu.ColorPalette, Value: 4},
		}}},
	}

	purple := strings.Join(m.renderFrameLines(tab, frame, 1, 1), "\n")
	if tab.lastAgyTheme != "purple" {
		t.Fatalf("cached Agy theme = %q, want purple", tab.lastAgyTheme)
	}
	m.data[origin].identity.Theme = "blue"
	blue := strings.Join(m.renderFrameLines(tab, frame, 1, 1), "\n")
	if tab.lastAgyTheme != "blue" {
		t.Fatalf("cached Agy theme = %q, want blue after server theme change", tab.lastAgyTheme)
	}
	if purple == blue {
		t.Fatal("Agy ANSI colors did not follow the server accent theme")
	}
	fresh := strings.Join(m.renderFrameLines(&paneTab{key: tab.key, coder: "agy"}, frame, 1, 1), "\n")
	if blue != fresh {
		t.Fatal("theme-updated cached render differs from a cold Agy render")
	}

	// The same palette-indexed bytes on other coders retain the user's terminal palette.
	nonAgy := strings.Join(m.renderFrameLines(&paneTab{key: tab.key, coder: "bash"}, frame, 1, 1), "\n")
	if nonAgy == blue {
		t.Fatal("Agy theme mapping leaked into a non-Agy terminal")
	}
}

func mustRGB(t *testing.T, hex string) uint32 {
	t.Helper()
	var value uint32
	for _, r := range hex {
		value <<= 4
		switch {
		case r >= '0' && r <= '9':
			value |= uint32(r - '0')
		case r >= 'a' && r <= 'f':
			value |= uint32(r-'a') + 10
		default:
			t.Fatalf("invalid hex color %q", hex)
		}
	}
	return value
}
