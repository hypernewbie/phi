package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

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

	// UIFontFamily, UIFontSize, and TerminalFontFamily drive the
	// Settings modal's appearance fields. Empty values mean "use the
	// built-in default" (set on the client). Size is clamped server-side
	// in handleAppearanceUpdate. All three are optional — old config
	// files load fine without them.
	UIFontFamily       string `json:"ui_font_family,omitempty"`
	UIFontSize         int    `json:"ui_font_size,omitempty"`
	TerminalFontFamily string `json:"terminal_font_family,omitempty"`
	TerminalFontSize   int    `json:"terminal_font_size,omitempty"`

	// UseExistingTerminalTab, when true, makes the command panel route
	// terminal commands to the first alive bash/pwsh tab instead of
	// spawning a new one. Defaults to false (preserves prior behavior
	// of "spawn new tab unless a shell tab is currently focused").
	// Backwards compatible: missing in old config files means false.
	UseExistingTerminalTab bool `json:"use_existing_terminal_tab"`

	// UseHiddenTerminal, when true, runs terminal commands in a separate
	// hidden background terminal instead of creating or reusing visible
	// interactive tabs. When enabled, it overrides UseExistingTerminalTab.
	UseHiddenTerminal bool `json:"use_hidden_terminal"`

	// FastMode, when true, disables the expensive idle animations and
	// backdrop blurs (perf crutch — see research/2026-08-01-2019-ui-idle-cpu-burn.md).
	FastMode bool `json:"fast_mode"`

	// PiOffline passes --offline when spawning the pi coder. Applies to pi
	// only; the flag is pi's, and other coders would reject it. Off by
	// default, so a missing key in an existing config file changes nothing.
	PiOffline bool `json:"pi_offline"`

	// ClaudeDangerouslySkipPermissions passes --dangerously-skip-permissions
	// to the claude coder. Opt-in because the flag's name is honest about
	// what it disables: every Claude tool call that would normally prompt
	// (file edits, bash, anything outside the workspace) runs without
	// confirmation. Scoped to claude; other coders would reject the flag.
	// Off by default, so a missing key in an existing config file changes
	// nothing. Applies at spawn time, so it cannot affect a claude tab
	// that is already running.
	ClaudeDangerouslySkipPermissions bool `json:"claude_dangerously_skip_permissions"`

	// CompressionEnabled gates gzip/brotli encoding of embedded web
	// assets. Defaults to true, seeded in loadConfig before unmarshal
	// (absent key keeps the default; explicit false wins). Operators
	// running phi behind a reverse proxy that owns compression set this
	// to false. Caching headers (ETag/no-cache) are unaffected. Read
	// once at startup (initStaticAssets) — changing it needs a restart.
	CompressionEnabled bool `json:"compression_enabled"`

	ReplayBufferBytes *int `json:"replay_buffer_bytes"`

	PushoverUserKey   string `json:"pushover_user_key"`
	PushoverAppToken  string `json:"pushover_app_token"`
	PushoverEnabled   bool   `json:"pushover_enabled"`
	WebhookURL        string `json:"webhook_url"`
	WebhookEnabled    bool   `json:"webhook_enabled"`
	SimplepushKey     string `json:"simplepush_key"`
	SimplepushEnabled bool   `json:"simplepush_enabled"`
	KanbanPasswordEnc string `json:"kanban_password_enc"`
	KanbanUsername    string `json:"kanban_username,omitempty"`
	KanbanURL         string `json:"kanban_url,omitempty"`
	// AccessPasswordHash is an optional browser-derived password verifier.
	// An empty string deliberately disables Phi's access-password gate.
	AccessPasswordHash string       `json:"access_password_hash"`
	SyncCoordinator    string       `json:"sync_coordinator"`
	AutoReconnect      string       `json:"auto_reconnect"`
	Peers              []PeerConfig `json:"peers"`
}

type PeerConfig struct {
	Name string `json:"name"`
	URL  string `json:"url"`
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

// testConfigPath points configFilePath() at a temp file during tests.
// Set this (via withTempConfig or directly) so tests never touch
// ~/.phi/config.json. Anything else will trigger the guard below.
var testConfigPath string

// configFilePath returns the active config path. Tests MUST override
// testConfigPath to point at a temp file — otherwise the guard in
// this function refuses to return the live ~/.phi/config.json path.
// Without this guard, a test that forgets withTempConfig(t) silently
// reads/writes the user's real config (as happened with the
// `phi-test-alpha/beta/gamma` workspace poisoning on 2026-07-14).
func configFilePath() string {
	if testConfigPath != "" {
		return testConfigPath
	}
	if testing.Testing() {
		panic("configFilePath() called under `go test` without testConfigPath set. " +
			"Use withTempConfig(t) (or set testConfigPath directly) to " +
			"isolate this test from ~/.phi/config.json — see the doc comment on " +
			"testConfigPath.")
	}
	return expandHome("~/.phi/config.json")
}

func loadConfig() Config {
	configMu.RLock()
	defer configMu.RUnlock()

	path := configFilePath()
	var cfg Config
	// Seed defaults that must survive an absent key: json.Unmarshal only
	// touches fields present in the file, so a missing key keeps the seed
	// and an explicit false wins. (Bools can't be defaulted after the
	// fact — false is a meaningful user value.)
	cfg.CompressionEnabled = true
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
	// Font fields: zero/empty values mean "use built-in defaults on
	// the client". No server-side coercion needed beyond this.
	if cfg.UIFontSize < 0 {
		cfg.UIFontSize = 0
	}
	if cfg.TerminalFontSize < 0 {
		cfg.TerminalFontSize = 0
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
		cfg.AutoReconnect = "visible"
	}
	if cfg.Peers == nil {
		cfg.Peers = []PeerConfig{}
	}
	return cfg
}

func ensureModelPresetDefaults(m ModelPresetsMap) ModelPresetsMap {
	if m == nil {
		m = make(ModelPresetsMap)
	}
	// Pi's model list comes from the live RPC, so no preset default is set
	// here — shipping a stale hardcoded list (as we did previously) made the
	// Pi-RPC picker open to a group of synthesized ghost rows. Opencode,
	// Claude, and Agy have fixed coders and keep their (also-stale) defaults
	// for now; clean those up separately if they bite.
	defaults := map[string][]string{
		"opencode": {
			"opencode/big-pickle",
		},
		"claude": {
			"fable",
			"opus",
			"sonnet",
			"haiku",
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

	// Defense in depth: never persist a workspace whose path looks
	// like a test scratch dir (e.g. /tmp/phi-test-alpha). This guards
	// against the earlier poisoning incident where a test wrote three
	// fake workspaces into the live ~/.phi/config.json.
	cfg.Workspaces = filterOutTestPaths(cfg.Workspaces)

	path := configFilePath()
	_ = os.MkdirAll(filepath.Dir(path), 0755)
	b, _ := json.MarshalIndent(cfg, "", "  ")
	_ = system.WriteFileAtomic(path, b, 0644)
}

// looksLikeTestArtifact returns true if `path` looks like a scratch
// directory a Go test created via MkdirTemp / os.CreateTemp with a
// phi-prefixed pattern. Used as a final defense-in-depth check: even
// if saveConfig is somehow called during a test that bypassed the
// withTempConfig guard, refuse to persist a workspace that lives
// inside a phi-prefixed test scratch directory anywhere in its path.
//
// Heuristic: any path segment starts with `phi-test-` or `phi-shims-`.
// This catches:
//
//	C:/Users/.../Temp/phi-test-1234.../working       (workspace inside)
//	/tmp/phi-test-1234...                             (workspace == dir)
//	/var/folders/.../T/phi-test-1234.../working       (macOS TempDir)
//
// Legitimate user workspaces never have such a segment anywhere in
// their path. False-positive risk for a user-named project like
// `/code/phi-test-tools` is non-zero but acceptable; renaming the
// workspace is preferable to ever silently poisoning the live config
// again.
func looksLikeTestArtifact(path string) bool {
	if path == "" {
		return false
	}
	p := filepath.ToSlash(path)
	// Check every path segment for the prefix.
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, "phi-test-") || strings.HasPrefix(seg, "phi-shims-") {
			return true
		}
	}
	// Also handle Windows backslash form (defensive; filepath.ToSlash
	// already converts).
	for _, seg := range strings.Split(filepath.FromSlash(p), string(filepath.Separator)) {
		if strings.HasPrefix(seg, "phi-test-") || strings.HasPrefix(seg, "phi-shims-") {
			return true
		}
	}
	return false
}

// filterOutTestPaths returns a new slice containing only paths that
// don't look like a test scratch directory. See saveConfig for the
// call site (workspace list dedup is the primary use).
func filterOutTestPaths(in []string) []string {
	out := make([]string, 0, len(in))
	for _, p := range in {
		if !looksLikeTestArtifact(p) {
			out = append(out, p)
		}
	}
	return out
}
