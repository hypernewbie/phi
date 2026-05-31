package coders

type Preset struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Coder struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Command       string   `json:"command"`
	Args          []string `json:"args"`
	ResumeArg     string   `json:"resume_arg"`
	SessionSource string   `json:"session_source"`
	Presets       []Preset `json:"presets"`
}

var Registry = map[string]Coder{
	"opencode": {
		ID:            "opencode",
		Name:          "OpenCode",
		Command:       "opencode",
		Args:          []string{},
		ResumeArg:     "--session",
		SessionSource: "opencode_sqlite",
		Presets: []Preset{
			{Name: "/exit", Value: "/exit\n"},
			{Name: "/context", Value: "/context\n"},
			{Name: "ctrl+c", Value: "\x03"},
			{Name: "y↵", Value: "y\n"},
			{Name: "esc", Value: "\x1b"},
			{Name: "/clear", Value: "/clear\n"},
		},
	},
	"claude": {
		ID:            "claude",
		Name:          "Claude Code",
		Command:       "claude",
		Args:          []string{},
		ResumeArg:     "--resume",
		SessionSource: "claude_files",
		Presets: []Preset{
			{Name: "/exit", Value: "/exit\n"},
			{Name: "ctrl+c", Value: "\x03"},
			{Name: "y↵", Value: "y\n"},
			{Name: "esc", Value: "\x1b"},
			{Name: "/clear", Value: "/clear\n"},
			{Name: "/compact", Value: "/compact\n"},
		},
	},
	"agy": {
		ID:            "agy",
		Name:          "Antigravity",
		Command:       "agy",
		Args:          []string{},
		ResumeArg:     "--conversation",
		SessionSource: "agy_files",
		Presets: []Preset{
			{Name: "/exit", Value: "/exit\n"},
			{Name: "ctrl+c", Value: "\x03"},
			{Name: "y↵", Value: "y\n"},
			{Name: "/clear", Value: "/clear\n"},
		},
	},
}
