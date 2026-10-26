package main

import (
	"testing"
)

func TestThemeEmoji_CoversThemes(t *testing.T) {
	cases := map[string]string{
		"neon":    "⚡",
		"arc":     "🔷",
		"blue":    "🔵",
		"green":   "🟢",
		"emerald": "🟢",
		"orange":  "🟠",
		"pink":    "🌸",
		"cyan":    "💎",
		"red":     "🔴",
		"amber":   "🟡",
		"gold":    "🟡",
		"canary":  "🟡",
		"white":   "⚪",
		"lime":    "🍈",
		"purple":  "🟣",
	}

	for theme, want := range cases {
		got := themeEmoji(theme)
		if got != want {
			t.Errorf("themeEmoji(%q) = %q, want %q", theme, got, want)
		}
	}
}
