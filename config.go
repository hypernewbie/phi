package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/hypernewbie/phi/pkg/system"
)

type QuickCommand struct {
	Name    string `json:"name"`
	Command string `json:"command"`
}

type ModelPresetsMap map[string][]string

func (m *ModelPresetsMap) UnmarshalJSON(data []byte) error {
	var mapVal map[string][]string
	if err := json.Unmarshal(data, &mapVal); err == nil {
		*m = mapVal
		return nil
	}

	var listVal []string
	if err := json.Unmarshal(data, &listVal); err == nil {
		*m = map[string][]string{
			"pi": listVal,
		}
		return nil
	}

	return json.Unmarshal(data, &mapVal)
}

type Config struct {
	Workspaces        []string          `json:"workspaces"`
	ThemeColor        string            `json:"theme_color"`
	ExpandedWorktrees map[string]bool   `json:"expanded_worktrees"`
	ActiveWorktrees   map[string]string `json:"active_worktrees"`
	ModelPresets      ModelPresetsMap   `json:"model_presets"`
	QuickCommands     []QuickCommand    `json:"quick_commands"`
	TerminalCommands  []QuickCommand    `json:"terminal_commands"`
	MarkdownDirs      []string          `json:"markdown_dirs"`

	// UseExistingTerminalTab, when true, makes the command panel route
	// terminal commands to the first alive bash/pwsh tab instead of
	// spawning a new one. Defaults to false (preserves prior behavior
	// of "spawn new tab unless a shell tab is currently focused").
	// Backwards compatible: missing in old config files means false.
	UseExistingTerminalTab bool `json:"use_existing_terminal_tab"`
	ReplayBufferBytes      *int `json:"replay_buffer_bytes"`

	PushoverUserKey   string `json:"pushover_user_key"`
	PushoverAppToken  string `json:"pushover_app_token"`
	PushoverEnabled   bool   `json:"pushover_enabled"`
	WebhookURL        string `json:"webhook_url"`
	WebhookEnabled    bool   `json:"webhook_enabled"`
	SimplepushKey     string `json:"simplepush_key"`
	SimplepushEnabled bool   `json:"simplepush_enabled"`
	KanbanPasswordEnc string `json:"kanban_password_enc"`
	SyncCoordinator   string `json:"sync_coordinator"`
	AutoReconnect     string `json:"auto_reconnect"`
}

var configMu sync.RWMutex

func expandHome(path string) string {
	if len(path) > 0 && path[0] == '~' {
		home, err := os.UserHomeDir()
		if err == nil {
			return home + path[1:]
		}
	}
	return path
}

// configFilePath returns the active config path. Tests override testConfigPath to
// point at a temp file so they never touch ~/.phi/config.json.
var testConfigPath string

func configFilePath() string {
	if testConfigPath != "" {
		return testConfigPath
	}
	return expandHome("~/.phi/config.json")
}

func loadConfig() Config {
	configMu.RLock()
	defer configMu.RUnlock()

	path := configFilePath()
	var cfg Config
	b, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	if cfg.Workspaces == nil {
		cfg.Workspaces = []string{}
	}
	if cfg.ThemeColor == "" {
		cfg.ThemeColor = "purple"
	}
	if cfg.ExpandedWorktrees == nil {
		cfg.ExpandedWorktrees = make(map[string]bool)
	}
	if cfg.ActiveWorktrees == nil {
		cfg.ActiveWorktrees = make(map[string]string)
	}
	cfg.ModelPresets = ensureModelPresetDefaults(cfg.ModelPresets)
	if cfg.QuickCommands == nil {
		cfg.QuickCommands = []QuickCommand{
			{Name: "status", Command: "git status"},
			{Name: "diff", Command: "git diff"},
			{Name: "commit", Command: `git commit -m "{}"`},
		}
	}
	if cfg.TerminalCommands == nil {
		cfg.TerminalCommands = []QuickCommand{
			{Name: "vim", Command: "vim"},
			{Name: "nvim", Command: "nvim"},
			{Name: "git push", Command: "git push"},
			{Name: "git pull --rebase", Command: "git pull --rebase"},
		}
	}
	if cfg.MarkdownDirs == nil {
		cfg.MarkdownDirs = []string{".", "./temp", "./tmp"}
	}
	if cfg.SyncCoordinator == "" {
		cfg.SyncCoordinator = "http://localhost:7070"
	}
	if cfg.ReplayBufferBytes == nil {
		defaultBytes := 1048576
		cfg.ReplayBufferBytes = &defaultBytes
	}
	if cfg.AutoReconnect == "" {
		cfg.AutoReconnect = "off"
	}
	return cfg
}

func ensureModelPresetDefaults(m ModelPresetsMap) ModelPresetsMap {
	if m == nil {
		m = make(ModelPresetsMap)
	}
	defaults := map[string][]string{
		"pi": {
			"gemini-1.5-pro",
			"gemini-1.5-flash",
			"deepseek-coder",
			"gpt-4o",
			"gpt-4-turbo",
			"claude-3-5-sonnet",
		},
		"opencode": {
			"opencode/big-pickle",
		},
		"claude": {
			"claude-sonnet-4-6",
			"claude-opus-4-8",
			"sonnet[1m]",
			"opus[1m]",
		},
		"agy": {
			"gemini-3.5-flash",
			"gemini-3.1-pro",
			"gemini-1.5-pro",
			"gemini-1.5-flash",
		},
	}

	for coder, defaultList := range defaults {
		if _, exists := m[coder]; !exists || m[coder] == nil {
			m[coder] = defaultList
		}
	}
	return m
}

func saveConfig(cfg Config) {
	configMu.Lock()
	defer configMu.Unlock()

	path := configFilePath()
	_ = os.MkdirAll(filepath.Dir(path), 0755)
	b, _ := json.MarshalIndent(cfg, "", "  ")
	_ = system.WriteFileAtomic(path, b, 0644)
}
