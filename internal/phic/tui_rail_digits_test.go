package phic

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestPrefixRailShowsServerDigits(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	m := newModelWithServer(t, srv)
	t.Cleanup(m.closeAll)
	m.servers = append(m.servers,
		&serverState{profile: desktopProfile{Name: "hammond:7070"}, health: "up"},
		&serverState{profile: desktopProfile{Name: "pi:7070"}, health: "up"},
	)
	m.active = 1
	glyphs := serverGlyphs(m.servers)

	plain := ansi.Strip(m.renderRail())
	for _, g := range glyphs {
		if !strings.Contains(plain, g+" ") {
			t.Fatalf("normal rail lost Greek glyph %q: %q", g, plain)
		}
	}

	// Prefix mode swaps Greek for the 1-9 digits that jump straight
	// there; colors stay exactly as cached.
	m.prefix = true
	raw := m.renderRail()
	plain = ansi.Strip(raw)
	for _, want := range []string{"1 FAKE", "2 HAMMOND", "3 PI"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("prefix rail missing %q: %q", want, plain)
		}
	}
	for _, g := range glyphs {
		if strings.Contains(plain, g+" ") {
			t.Fatalf("prefix rail still shows Greek glyph %q: %q", g, plain)
		}
	}
	// The active server keeps its accent highlight background.
	if !strings.Contains(raw, "48;2;29;31;39") {
		t.Fatal("prefix mode dropped the active server highlight")
	}

	// Leaving prefix mode restores the Greek glyphs.
	m.prefix = false
	plain = ansi.Strip(m.renderRail())
	for _, g := range glyphs {
		if !strings.Contains(plain, g+" ") {
			t.Fatalf("restored rail lost Greek glyph %q: %q", g, plain)
		}
	}
}
