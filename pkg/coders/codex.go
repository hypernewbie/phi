package coders

// Codex uses its own current, account-specific /model picker. Do not ship
// model-name presets or guess picker keystrokes: /model takes no inline args.
func defaultCodex() Coder {
	wrap := true
	return Coder{
		ID: "codex", Name: "Codex", ShortLabel: "Codex", Command: "codex",
		Args: []string{"--no-alt-screen"}, ResumeArgs: []string{"resume", ResumeIDPlaceholder},
		SessionSource: "codex_sqlite", SidebarVisible: true,
		WindowsPowerShellWrap: &wrap, InputMode: "staged", Logo: "vendor/logos/codex.png",
		Capabilities: Capabilities{List: true},
		Presets: []Preset{
			{Name: "/model", Value: "/model\r"},
			{Name: "/status", Value: "/status\r"},
			{Name: "/permissions", Value: "/permissions\r"},
			{Name: "/compact", Value: "/compact\r"},
			{Name: "/new", Value: "/new\r"},
			{Name: "/resume", Value: "/resume\r"},
			{Name: "/diff", Value: "/diff\r"},
			{Name: "/copy", Value: "/copy\r"},
			{Name: "/quit", Value: "/quit\r"},
			{Name: "ctrl+c", Value: "\x03"},
			{Name: "esc", Value: "\x1b"},
		},
	}
}
