package phic

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Exact web/theme.js accent values. The frontend parity test guards this small
// palette without embedding browser assets in the native client.
var phiAccents = map[string]string{
	"purple": "7c6af7", "blue": "38bdf8", "green": "10b981", "amber": "fbbf24", "red": "f87171", "pink": "ec4899", "teal": "14b8a6", "indigo": "6366f1", "orange": "f97316", "cyan": "06b6d4", "rose": "f43f5e", "lime": "84cc16", "white": "ffffff", "gold": "d4af37", "violet": "a78bfa", "emerald": "059669", "neon": "00f0ff", "coral": "e07a5f", "fuchsia": "d946ef", "canary": "ffee10", "copper": "d35400", "mint": "2ed573", "arc": "00d4ff", "ember": "ff4500", "fog": "94a3b8", "ash": "a8a29e", "dusk": "b8a9c9", "pine": "84a59d", "fern": "9caf88",
}

func osColorEnabled() bool { return os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb" }

func themeText(theme, text string, selected bool) string {
	if !osColorEnabled() {
		return text
	}
	hex := phiAccents[theme]
	if hex == "" {
		hex = phiAccents["purple"]
	}
	value, _ := strconv.ParseUint(hex, 16, 32)
	r, g, b := (value>>16)&255, (value>>8)&255, value&255
	if selected {
		fg := 255
		if 299*r+587*g+114*b > 150000 {
			fg = 0
		}
		return fmt.Sprintf("\x1b[1;38;2;%d;%d;%d;48;2;%d;%d;%dm%s\x1b[0m", fg, fg, fg, r, g, b, text)
	}
	return fmt.Sprintf("\x1b[38;2;%d;%d;%dm%s\x1b[0m", r, g, b, text)
}

func (c *client) activeServer() *serverState {
	if c.serverIndex < 0 || c.serverIndex >= len(c.servers) {
		return nil
	}
	return c.servers[c.serverIndex]
}
func (c *client) color(text string) string {
	theme := ""
	if s := c.activeServer(); s != nil {
		theme = s.identity.Theme
	}
	return themeText(theme, text, false)
}
func (s *serverState) label() string {
	// A saved desktop label is user-owned. Hostname enriches identity; it
	// must not silently replace a named rail entry after config loads.
	if s.profile.Name != "" && s.profile.Name != s.profile.Origin && (s.api == nil || s.profile.Name != s.api.base.Host) {
		return menuLabel(s.profile.Name)
	}
	if s.identity.Hostname != "" {
		return menuLabel(s.identity.Hostname)
	}
	return menuLabel(s.profile.Name)
}
func (c *client) heading(title string) string {
	server := ""
	if s := c.activeServer(); s != nil {
		server = s.label() + " · "
	}
	return c.color("Φ  " + server + title)
}
func (c *client) serverBar(cols int) string {
	var out strings.Builder
	used := 0
	for i, s := range c.servers {
		label := clipMenu(s.label(), max(0, min(14, cols-len(strconv.Itoa(i+1))-6)))
		box := fmt.Sprintf(" [%d %s] ", i+1, label)
		cells := 0
		for _, r := range box {
			cells += cellWidth(r)
		}
		if used > 0 && used+cells > cols {
			out.WriteString("\r\n")
			used = 0
		}
		out.WriteString(themeText(s.identity.Theme, box, i == c.serverIndex))
		used += cells
	}
	out.WriteString("\r\n")
	return out.String()
}

func (c *client) diffText(dir, text string) string {
	// Backend diff styles stay intact; client chrome follows the active server.
	// Quote metadata before adding SGR, just as the inline menus do.
	var out strings.Builder
	out.WriteString(c.heading("Diff"))
	out.WriteString("\n")
	out.WriteString(c.color(fmt.Sprintf("%+q", dir)))
	out.WriteString("\n\n")
	if text == "" {
		out.WriteString(c.color("No changes\n"))
	} else {
		out.WriteString(text)
	}
	return out.String()
}
