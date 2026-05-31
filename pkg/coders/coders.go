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
			{Name: "/exit", Value: "/exit\r"},
			{Name: "/context", Value: "/context\r"},
			{Name: "/model", Value: "/model\n"},
			{Name: "/compact", Value: "/compact\r"},
			{Name: "/undo", Value: "/undo\r"},
			{Name: "/copy", Value: "/copy\r"},
			{Name: "/help", Value: "/help\r"},
			{Name: "ctrl+c", Value: "\x03"},
			{Name: "y↵", Value: "y\r"},
			{Name: "esc", Value: "\x1b"},
			{Name: "/clear", Value: "/clear\r"},
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
			{Name: "/exit", Value: "/exit\r"},
			{Name: "/model", Value: "/model\n"},
			{Name: "/compact", Value: "/compact\r"},
			{Name: "/undo", Value: "/undo\r"},
			{Name: "/copy", Value: "/copy\r"},
			{Name: "/help", Value: "/help\r"},
			{Name: "ctrl+c", Value: "\x03"},
			{Name: "y↵", Value: "y\r"},
			{Name: "esc", Value: "\x1b"},
			{Name: "/clear", Value: "/clear\r"},
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
			{Name: "/exit", Value: "/exit\r"},
			{Name: "/model", Value: "/model\n"},
			{Name: "/compact", Value: "/compact\r"},
			{Name: "/undo", Value: "/undo\r"},
			{Name: "/copy", Value: "/copy\r"},
			{Name: "/help", Value: "/help\r"},
			{Name: "ctrl+c", Value: "\x03"},
			{Name: "y↵", Value: "y\r"},
			{Name: "/clear", Value: "/clear\r"},
		},
	},
	"bash": {
		ID:            "bash",
		Name:          "Shell",
		Command:       "bash",
		Args:          []string{"-l"},
		ResumeArg:     "",
		SessionSource: "",
		Presets: []Preset{
			{Name: "ctrl+c", Value: "\x03"},
			{Name: "ctrl+d", Value: "\x04"},
			{Name: "clear", Value: "clear\r"},
			{Name: "exit", Value: "exit\r"},
		},
	},
}
