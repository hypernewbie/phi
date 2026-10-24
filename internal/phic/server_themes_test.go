package phic

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func themeTestModel(themes ...string) *tuiModel {
	servers := make([]*serverState, len(themes))
	for i, theme := range themes {
		servers[i] = &serverState{
			profile:  desktopProfile{ID: string(rune('a' + i)), Name: "srv", Origin: "http://srv" + string(rune('a'+i))},
			identity: serverIdentity{Theme: theme},
			health:   "up",
		}
	}
	m := newTUIModel("test", config{}, nil, servers, 0, stubBuild)
	m.width, m.height = 120, 30
	return m
}

func TestServerThemeHexPrefersLiveOverCache(t *testing.T) {
	m := themeTestModel("green")
	s := m.servers[0]
	m.serverThemes = map[string]string{serverOriginKey(s): "blue"}
	hex, ok := m.serverThemeHex(s)
	if !ok || hex != phiAccents["green"] {
		t.Fatalf("live theme lost to cache: %q %v", hex, ok)
	}
}

func TestServerThemeHexFallsBackToCache(t *testing.T) {
	m := themeTestModel("")
	s := m.servers[0]
	m.serverThemes = map[string]string{serverOriginKey(s): "blue"}
	hex, ok := m.serverThemeHex(s)
	if !ok || hex != phiAccents["blue"] {
		t.Fatalf("cached theme not used: %q %v", hex, ok)
	}
}

func TestServerThemeHexUnknownIsGrey(t *testing.T) {
	m := themeTestModel("not-a-theme", "")
	m.serverThemes = map[string]string{serverOriginKey(m.servers[1]): "also-bogus"}
	for i, s := range m.servers {
		if _, ok := m.serverThemeHex(s); ok {
			t.Fatalf("server %d: unknown theme should fall back to grey", i)
		}
	}
}

func TestServerThemeCacheRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phic-server-themes.json")
	m := themeTestModel("green")
	m.serverThemesPath = path
	m.recordServerTheme("http://a", "green")
	m.recordServerTheme("http://b", "bogus-theme")
	if got := loadServerThemes(path); got["http://a"] != "green" || len(got) != 1 {
		t.Fatalf("cache round trip wrong: %v", got)
	}
	if m.serverThemes["http://b"] != "" {
		t.Fatal("unknown theme must never be cached")
	}
	// A fresh model picks the cached theme back up.
	m2 := themeTestModel("")
	m2.serverThemesPath = path
	m2.serverThemes = loadServerThemes(path)
	if hex, ok := m2.serverThemeHex(&serverState{profile: desktopProfile{Origin: "http://a"}}); !ok || hex != phiAccents["green"] {
		t.Fatalf("fresh model missed cached theme: %q %v", hex, ok)
	}
}

func TestRailUsesPerServerColors(t *testing.T) {
	m := themeTestModel("green", "blue")
	m.active = 1
	m.width = 160
	raw := m.renderRail()
	// Active server (blue): solid slab in its own color.
	if !strings.Contains(raw, "48;2;56;189;248") {
		t.Fatalf("active server missing its blue slab: %q", ansi.Strip(raw))
	}
	// Inactive server (green): its own color as text.
	if !strings.Contains(raw, "38;2;16;185;129") {
		t.Fatalf("inactive server missing its green color: %q", ansi.Strip(raw))
	}
}

func TestRailUnknownThemeStaysGrey(t *testing.T) {
	m := themeTestModel("", "")
	m.active = 0
	raw := m.renderRail()
	if strings.Contains(raw, "48;2;16;185;129") || strings.Contains(raw, "48;2;56;189;248") {
		t.Fatal("unknown servers must not borrow accent colors")
	}
	if !strings.Contains(raw, "48;2;136;136;149") {
		t.Fatalf("active unknown server missing grey slab: %q", ansi.Strip(raw))
	}
}

func TestRailDownServerStaysGreyDespiteTheme(t *testing.T) {
	m := themeTestModel("green", "blue")
	m.servers[1].health = "down"
	raw := m.renderRail()
	// The down server must not show its blue theme as text (38;2):
	// offline stays grey. (Green 38;2 may still appear on the [+]
	// button, which uses the active server's accent.)
	if strings.Contains(raw, "38;2;56;189;248") {
		t.Fatal("down server should not show a healthy color")
	}
	plain := ansi.Strip(raw)
	if strings.Count(plain, "SRV") != 2 {
		t.Fatalf("down server vanished from rail: %q", plain)
	}
}
