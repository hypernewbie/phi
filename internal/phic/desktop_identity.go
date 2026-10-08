package phic

import (
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"regexp"
	"strings"
	"unicode/utf16"
)

var identityScheme = regexp.MustCompile(`^[A-Z][A-Z0-9+.-]*://`)
var identityPort = regexp.MustCompile(`^\[?([^:\[\]]+):[0-9]+$`)

// displayHostname mirrors the web display-only mDNS suffix cleanup. Keep the
// raw hostname intact for server identity and network requests.
func displayHostname(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	lower := strings.ToLower(raw)
	trimmed := raw
	if strings.HasSuffix(lower, ".local.") {
		trimmed = raw[:len(raw)-len(".local.")]
	} else if strings.HasSuffix(lower, ".local") {
		trimmed = raw[:len(raw)-len(".local")]
	}
	if trimmed == "" {
		return raw
	}
	return trimmed
}

// Exact renderer.canonicalHostname ordering (including .LOCAL and port cases).
func canonicalHostname(raw string) string {
	s := cases.Upper(language.Und).String(jsTrim(raw))
	if strings.HasSuffix(s, ".LOCAL.") {
		s = strings.TrimSuffix(s, ".LOCAL.")
	} else {
		s = strings.TrimSuffix(s, ".LOCAL")
	}
	s = identityScheme.ReplaceAllString(s, "")
	if m := identityPort.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	return s
}

var greekPairs = [][2]string{{"Α", "α"}, {"Β", "β"}, {"Γ", "γ"}, {"Δ", "δ"}, {"Ε", "ε"}, {"Ζ", "ζ"}, {"Η", "η"}, {"Θ", "θ"}, {"Ι", "ι"}, {"Κ", "κ"}, {"Λ", "λ"}, {"Μ", "μ"}, {"Ν", "ν"}, {"Ξ", "ξ"}, {"Ο", "ο"}, {"Π", "π"}, {"Ρ", "ρ"}, {"Σ", "σ"}, {"Τ", "τ"}, {"Υ", "υ"}, {"Χ", "χ"}, {"Ψ", "ψ"}, {"Ω", "ω"}}

func greekGlyphForHostname(hostname string, used map[string]bool) string {
	hash := uint32(0x811c9dc5)
	for _, code := range utf16.Encode([]rune(canonicalHostname(hostname))) {
		hash ^= uint32(code)
		hash *= 0x01000193
	}
	index := int(hash % 47)
	base, swap := "ς", "Σ"
	if index < 46 {
		pair := greekPairs[index/2]
		base = pair[index%2]
		swap = pair[1-index%2]
	}
	if !used[base] {
		return base
	}
	if !used[swap] {
		return swap
	}
	marks := 1
	candidate := base + "ʹ"
	for used[candidate] && marks < 8 {
		marks++
		candidate = base + strings.Repeat("ʹ", marks)
	}
	return candidate
}
func serverGlyphs(servers []*serverState) []string {
	used := map[string]bool{}
	glyphs := make([]string, len(servers))
	for i, s := range servers {
		glyphs[i] = greekGlyphForHostname(s.label(), used)
		used[glyphs[i]] = true
	}
	return glyphs
}
func (s *serverState) statusLabel() string {
	if s.health == "up" {
		return "Connected"
	}
	if s.health == "down" {
		return "Offline"
	}
	return "Checking connection"
}
