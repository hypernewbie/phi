package phic

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Last-seen server theme cache. The rail colors each server with its own
// theme; when a server is unreachable (or not yet loaded) the live identity
// is empty, so phic remembers the last validated theme_color per origin.
//
// The cache is phic-owned (phic-server-themes.json next to the desktop
// profiles file), never the shared desktop document: Electron must not see
// unknown profile fields, and a corrupt cache must never block startup.
func serverThemeCachePath(profilesPath string) string {
	if profilesPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(profilesPath), "phic-server-themes.json")
}

func loadServerThemes(path string) map[string]string {
	out := map[string]string{}
	if path == "" {
		return out
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var raw map[string]string
	if json.Unmarshal(data, &raw) != nil {
		return out
	}
	for origin, theme := range raw {
		if origin == "" {
			continue
		}
		if _, ok := phiAccents[theme]; !ok {
			continue
		}
		out[origin] = theme
	}
	return out
}

// recordServerTheme remembers a validated theme name for an origin and
// persists it best-effort. Synchronous by design: identity arrivals are rare
// (server load, cooldown-gated polls) and the file is tiny. Unknown theme
// names are never cached; the rail falls back to neutral grey for those.
func (m *tuiModel) recordServerTheme(origin, theme string) {
	if origin == "" || theme == "" {
		return
	}
	if _, ok := phiAccents[theme]; !ok {
		return
	}
	if m.serverThemes == nil {
		m.serverThemes = map[string]string{}
	}
	if m.serverThemes[origin] == theme {
		return
	}
	m.serverThemes[origin] = theme
	if m.serverThemesPath == "" {
		return
	}
	data, err := json.MarshalIndent(m.serverThemes, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(m.serverThemesPath), 0700)
	_ = os.WriteFile(m.serverThemesPath, data, 0600)
}

func serverOriginKey(s *serverState) string {
	if s == nil {
		return ""
	}
	if s.api != nil {
		return s.api.base.String()
	}
	return s.profile.Origin
}

// serverThemeHex resolves a server's rail color: live identity first, then
// the last-seen cached theme. Unknown or missing themes report false and the
// caller falls back to neutral grey.
func (m *tuiModel) serverThemeHex(s *serverState) (string, bool) {
	if s == nil {
		return "", false
	}
	candidates := []string{s.identity.Theme}
	seen := map[string]bool{}
	for _, origin := range []string{serverOriginKey(s), s.profile.Origin} {
		if origin == "" || seen[origin] {
			continue
		}
		seen[origin] = true
		if d := m.data[origin]; d != nil {
			candidates = append(candidates, d.identity.Theme)
		}
		candidates = append(candidates, m.serverThemes[origin])
	}
	for _, name := range candidates {
		if hex, ok := phiAccents[name]; ok && hex != "" {
			return hex, true
		}
	}
	return "", false
}
