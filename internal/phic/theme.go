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

type agyAnsiTones struct {
	Dim    string `json:"dim"`
	Bright string `json:"bright"`
}

// These are the blue dim/bright accent tokens from web/theme.js. Agy's ANSI
// palette remapping in phic must stay in parity with the browser client.
var phiAgyAnsiTones = map[string]agyAnsiTones{
	"purple":  {Dim: "5b4ec2", Bright: "9a8dfa"},
	"blue":    {Dim: "0284c7", Bright: "7dd3fc"},
	"green":   {Dim: "047857", Bright: "34d399"},
	"amber":   {Dim: "b45309", Bright: "fcd34d"},
	"red":     {Dim: "b91c1c", Bright: "fca5a5"},
	"pink":    {Dim: "be185d", Bright: "f472b6"},
	"teal":    {Dim: "0f766e", Bright: "5eead4"},
	"indigo":  {Dim: "4338ca", Bright: "818cf8"},
	"orange":  {Dim: "c2410c", Bright: "fdba74"},
	"cyan":    {Dim: "0e7490", Bright: "67e8f9"},
	"rose":    {Dim: "be123c", Bright: "fb7185"},
	"lime":    {Dim: "4d7c0f", Bright: "a3e635"},
	"white":   {Dim: "94a3b8", Bright: "ffffff"},
	"gold":    {Dim: "997a15", Bright: "f3e5ab"},
	"violet":  {Dim: "6d28d9", Bright: "ddd6fe"},
	"emerald": {Dim: "065f46", Bright: "34d399"},
	"neon":    {Dim: "008b99", Bright: "70f8ff"},
	"coral":   {Dim: "9e4731", Bright: "f4a261"},
	"fuchsia": {Dim: "86198f", Bright: "f0abfc"},
	"canary":  {Dim: "b8ad00", Bright: "ffff66"},
	"copper":  {Dim: "8a3700", Bright: "e59866"},
	"mint":    {Dim: "1a8a4a", Bright: "7bed9f"},
	"arc":     {Dim: "0080c0", Bright: "66e0ff"},
	"ember":   {Dim: "cc2200", Bright: "ff7733"},
	"fog":     {Dim: "64748b", Bright: "cbd5e1"},
	"ash":     {Dim: "78716c", Bright: "d6d3d1"},
	"dusk":    {Dim: "7c6f8a", Bright: "d4cae0"},
	"pine":    {Dim: "5b7065", Bright: "a8c2bc"},
	"fern":    {Dim: "6b8e5f", Bright: "bccbab"},
}

func osColorEnabled() bool { return os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb" }

func themeText(theme, text string, selected bool) string {
	if !osColorEnabled() {
		return text
	}
	hex := phiAccents[theme]
	if hex == "" {
		if theme == "" {
			hex = "e4e3e9"
		} else {
			hex = phiAccents["purple"]
		}
	}
	value, _ := strconv.ParseUint(hex, 16, 32)
	r, g, b := (value>>16)&255, (value>>8)&255, value&255
	if selected {
		// rail-menu.css uses a 14% accent wash, not a solid accent slab.
		return fmt.Sprintf("\x1b[1;38;2;%d;%d;%d;48;2;%d;%d;%dm%s\x1b[0m", r, g, b, (14*r+86*23)/100, (14*g+86*23)/100, (14*b+86*29)/100, text)
	}
	return fmt.Sprintf("\x1b[38;2;%d;%d;%dm%s\x1b[0m", r, g, b, text)
}

func (c *client) activeServer() *serverState {
	if c.currentServer != nil {
		return c.currentServer
	}
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
	// renderer.identityLabel: observed canonical identity on rail; saved
	// profile name is still shown in its context header and rename form.
	if hostname := canonicalHostname(s.identity.Hostname); hostname != "" {
		return menuLabel(hostname)
	}
	return menuLabel(s.profile.Name)
}
func dangerText(text string, selected bool) string {
	if !osColorEnabled() {
		return text
	}
	if selected {
		return "\x1b[38;2;255;143;154;48;2;44;31;38m" + text + "\x1b[0m"
	}
	return "\x1b[38;2;255;143;154m" + text + "\x1b[0m"
}
func pickerText(text string) string {
	if !osColorEnabled() {
		return text
	}
	return "\x1b[38;2;79;70;229m" + text + "\x1b[0m"
}
func (s *serverState) railText(text string, selected bool) string {
	if s.health != "up" {
		if !osColorEnabled() {
			return text
		}
		return "\x1b[38;2;120;118;138m" + text + "\x1b[0m"
	}
	return themeText(s.identity.Theme, text, selected)
}
func (c *client) heading(title string) string {
	server := ""
	if s := c.activeServer(); s != nil {
		server = s.label() + " · "
	}
	return c.color("Φ  " + server + title)
}
func (c *client) serverBar(cols int) string {
	rows, _ := c.serverBarRows(cols)
	return strings.Join(rows, "\r\n") + "\r\n"
}

func (c *client) serverBarRows(cols int) ([]string, int) {
	var out strings.Builder
	var lines []string
	used, selectedRow := 0, 0
	glyphs := serverGlyphs(c.servers)
	for i, s := range c.servers {
		label := clipMenu(s.label(), max(0, min(14, cols-len(strconv.Itoa(i+1))-8)))
		box := fmt.Sprintf(" [%s %d %s] ", glyphs[i], i+1, label)
		cells := 0
		for _, r := range box {
			cells += cellWidth(r)
		}
		if used > 0 && used+cells > cols {
			lines = append(lines, out.String())
			out.Reset()
			used = 0
		}
		if i == c.serverIndex {
			selectedRow = len(lines)
		}
		out.WriteString(s.railText(box, i == c.serverIndex))
		used += cells
	}
	if out.Len() > 0 {
		lines = append(lines, out.String())
	}
	return lines, selectedRow
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
