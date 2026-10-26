package main

import (
	"os"
	"regexp"
	"strconv"
	"testing"
)

// TestBannerColorsCoversAllAccentColors asserts that every key in
// web/theme.js's ACCENT_COLORS map has a matching entry and accurate RGB
// tuple in the Go bannerColors map used by printWelcomeBanner. Drift silently
// falls back to purple in the welcome banner, which is the "some colors don't
// work" bug that originally motivated this test.
func TestBannerColorsCoversAllAccentColors(t *testing.T) {
	data, err := os.ReadFile("web/theme.js")
	if err != nil {
		t.Fatalf("read web/theme.js: %v", err)
	}

	// Match lines like `    key: {` — 4-space indent + identifier + colon + opening brace.
	re := regexp.MustCompile(`(?m)^\s{4}([a-zA-Z][a-zA-Z0-9]*):\s*\{`)
	matches := re.FindAllStringSubmatch(string(data), -1)
	if len(matches) == 0 {
		t.Fatalf("no ACCENT_COLORS keys found in web/theme.js — schema changed?")
	}

	for _, m := range matches {
		key := m[1]
		if _, ok := bannerColors[key]; !ok {
			t.Errorf("ACCENT_COLORS key %q is missing from bannerColors in main.go; printWelcomeBanner will silently render it as purple. Add an RGB tuple to bannerColors in main.go.", key)
		}
	}

	// Sanity floor — should always be at least the 29 themes.
	const wantMin = 29
	if got := len(matches); got < wantMin {
		t.Errorf("expected at least %d ACCENT_COLORS keys, parsed %d — regex may have broken against a theme.js refactor", wantMin, got)
	}

	// Also verify hex values in web/theme.js match bannerColors RGB values.
	reHex := regexp.MustCompile(`(?s)([a-zA-Z][a-zA-Z0-9]*):\s*\{\s*accent:\s*'#([0-9a-fA-F]{6})'`)
	hexMatches := reHex.FindAllStringSubmatch(string(data), -1)
	for _, m := range hexMatches {
		key := m[1]
		hex := m[2]
		val, _ := strconv.ParseUint(hex, 16, 32)
		r, g, b := int((val>>16)&0xff), int((val>>8)&0xff), int(val&0xff)
		rgb, ok := bannerColors[key]
		if !ok {
			continue // handled above
		}
		if len(rgb) != 3 || rgb[0] != r || rgb[1] != g || rgb[2] != b {
			t.Errorf("theme %q RGB mismatch: bannerColors has %v, web/theme.js has %s (%d, %d, %d)",
				key, rgb, hex, r, g, b)
		}
	}
}
