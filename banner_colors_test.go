package main

import (
	"os"
	"regexp"
	"testing"
)

// TestBannerColorsCoversAllAccentColors asserts that every key in
// web/theme.js's ACCENT_COLORS map has a matching entry in the Go
// bannerColors map used by printWelcomeBanner. Drift silently falls
// back to purple in the welcome banner, which is the "some colors don't
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

	// Sanity floor — should always be at least the original 17 + the 5
	// that motivated this test, otherwise the regex above silently broke
	// against a future refactor of theme.js.
	const wantMin = 22
	if got := len(matches); got < wantMin {
		t.Errorf("expected at least %d ACCENT_COLORS keys, parsed %d — regex may have broken against a theme.js refactor", wantMin, got)
	}
}