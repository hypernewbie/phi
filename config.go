package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	MarkdownDirs      []string          `json:"markdown_dirs"`
}

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
	if cfg.MarkdownDirs == nil {
		cfg.MarkdownDirs = []string{".", "./temp", "./tmp"}
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
	path := configFilePath()
	_ = os.MkdirAll(filepath.Dir(path), 0755)
	b, _ := json.MarshalIndent(cfg, "", "  ")
	_ = os.WriteFile(path, b, 0644)
}
