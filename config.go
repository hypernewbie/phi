package main

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/hypernewbie/phi/pkg/system"
)

type QuickCommand struct {
	Name    string `json:"name" toml:"name"`
	Command string `json:"command" toml:"command"`
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
	Workspaces        []string          `json:"workspaces" toml:"workspaces"`
	ThemeColor        string            `json:"theme_color" toml:"theme_color"`
	ExpandedWorktrees map[string]bool   `json:"expanded_worktrees" toml:"expanded_worktrees"`
	ActiveWorktrees   map[string]string `json:"active_worktrees" toml:"active_worktrees"`
	ModelPresets      ModelPresetsMap   `json:"model_presets" toml:"model_presets"`
	ThinkingPresets   []string          `json:"thinking_presets" toml:"thinking_presets"`
	QuickCommands     []QuickCommand    `json:"quick_commands" toml:"quick_commands"`
	TerminalCommands  []QuickCommand    `json:"terminal_commands" toml:"terminal_commands"`
	MarkdownDirs      []string          `json:"markdown_dirs" toml:"markdown_dirs"`

	// UIFontFamily, UIFontSize, and TerminalFontFamily drive the
	// Settings modal's appearance fields. Empty values mean "use the
	// built-in default" (set on the client). Size is clamped server-side
	// in handleAppearanceUpdate. All three are optional — old config
	// files load fine without them.
	UIFontFamily       string `json:"ui_font_family,omitempty" toml:"ui_font_family,omitempty"`
	UIFontSize         int    `json:"ui_font_size,omitempty" toml:"ui_font_size,omitempty"`
	TerminalFontFamily string `json:"terminal_font_family,omitempty" toml:"terminal_font_family,omitempty"`
	TerminalFontSize   int    `json:"terminal_font_size,omitempty" toml:"terminal_font_size,omitempty"`

	// SessionListPageSize controls how many sessions the sidebar shows per
	// page. 0 uses 10; nonzero values are clamped to 5..100 when the
	// /api/config payload is built. Optional: old config files load fine
	// without it.
	SessionListPageSize int `json:"session_list_page_size,omitempty" toml:"session_list_page_size,omitempty"`

	// HostnameOverride replaces the page host in socket URLs. Blank
	// (default, backwards compatible) means location.host. Persisted so
	// devices share it; each browser's localStorage still wins locally.
	// It is also the machine identity the backend reports (config
	// payload, status dump, push titles) — see reportedHostname.
	HostnameOverride string `json:"hostname_override,omitempty" toml:"hostname_override,omitempty"`

	// MobileScrollbackRows shrinks xterm history on mobile ONLY (the
	// fast-mode gate, forced on for mobile viewports). 0/unset means
	// full history, same as desktop. Desktop never reads this field.
	// Applies to new tabs; clamped server-side in handleAppearanceUpdate.
	MobileScrollbackRows int `json:"mobile_scrollback_rows,omitempty" toml:"mobile_scrollback_rows,omitempty"`

	// UseExistingTerminalTab, when true, makes the command panel route
	// terminal commands to the first alive bash/pwsh tab instead of
	// spawning a new one. Defaults to false (preserves prior behavior
	// of "spawn new tab unless a shell tab is currently focused").
	// Backwards compatible: missing in old config files means false.
	UseExistingTerminalTab bool `json:"use_existing_terminal_tab" toml:"use_existing_terminal_tab"`

	// UseHiddenTerminal, when true, runs terminal commands in a separate
	// hidden background terminal instead of creating or reusing visible
	// interactive tabs. When enabled, it overrides UseExistingTerminalTab.
	UseHiddenTerminal bool `json:"use_hidden_terminal" toml:"use_hidden_terminal"`

	// FastMode is a LEGACY migration source, not the live setting. The
	// effects profile (low power mode) is browser-stored now (localStorage
	// `phi_low_power`) because GPU burn is a property of the viewing
	// machine, not of the server — a per-server flag was the wrong home.
	// New clients never POST it; they adopt a true value into localStorage
	// once and ignore the server afterwards. The field and its endpoint
	// stay so old clients/exports keep working.
	// (perf crutch — see research/2026-08-01-2019-ui-idle-cpu-burn.md).
	FastMode bool `json:"fast_mode" toml:"fast_mode"`

	// PiOffline passes --offline when spawning the pi coder. Applies to pi
	// only; the flag is pi's, and other coders would reject it. Off by
	// default, so a missing key in an existing config file changes nothing.
	PiOffline bool `json:"pi_offline" toml:"pi_offline"`

	// PiBridgeNoInject skips the --extension injection when spawning the
	// pi coder, for users who install the bridge extension into Pi
	// manually. The lease and child credentials are still provisioned
	// (a manual install needs them); only the flag is omitted. Off by
	// default, so existing configs inject as before.
	PiBridgeNoInject bool `json:"pi_bridge_no_inject" toml:"pi_bridge_no_inject"`

	// OpenCode defaults to v2's full TUI; Mini is a per-launch option.
	// Legacy selects v1's full-screen TUI. These startup-only options require a
	// Phi restart; they never change the mode of a live terminal.
	OpenCodeLegacy        bool   `json:"opencode_legacy" toml:"opencode_legacy"`
	OpenCodeCommand       string `json:"opencode_command,omitempty" toml:"opencode_command,omitempty"`
	OpenCodeLegacyCommand string `json:"opencode_legacy_command,omitempty" toml:"opencode_legacy_command,omitempty"`

	// OpenCodeIdleStopMinutes stops the OpenCode background service after this
	// many minutes of inactivity across all OpenCode tabs in Phi. 0 disables it.
	// Clamped between 5 and 1440 when enabled.
	OpenCodeIdleStopMinutes int `json:"opencode_idle_stop_minutes" toml:"opencode_idle_stop_minutes"`

	// ClaudeDangerouslySkipPermissions passes --dangerously-skip-permissions
	// to the claude coder. Opt-in because the flag's name is honest about
	// what it disables: every Claude tool call that would normally prompt
	// (file edits, bash, anything outside the workspace) runs without
	// confirmation. Scoped to claude; other coders would reject the flag.
	// Off by default, so a missing key in an existing config file changes
	// nothing. Applies at spawn time, so it cannot affect a claude tab
	// that is already running.
	ClaudeDangerouslySkipPermissions bool `json:"claude_dangerously_skip_permissions" toml:"claude_dangerously_skip_permissions"`

	// AgyThemeAnsi dynamically adapts xterm's ANSI colour palette to match
	// Phi's active accent theme for agy tabs. Scoped specifically to agy;
	// off by default so normal shell tabs and other coders remain untouched.
	AgyThemeAnsi bool `json:"agy_theme_ansi" toml:"agy_theme_ansi"`

	// CompressionEnabled gates gzip/brotli encoding of embedded web
	// assets. Defaults to true, seeded in loadConfig before unmarshal
	// (absent key keeps the default; explicit false wins). Operators
	// running phi behind a reverse proxy that owns compression set this
	// to false. Caching headers (ETag/no-cache) are unaffected. Read
	// once at startup (initStaticAssets) — changing it needs a restart.
	CompressionEnabled bool `json:"compression_enabled" toml:"compression_enabled"`

	ReplayBufferBytes *int `json:"replay_buffer_bytes" toml:"replay_buffer_bytes"`

	PushoverUserKey   string `json:"pushover_user_key" toml:"pushover_user_key"`
	PushoverAppToken  string `json:"pushover_app_token" toml:"pushover_app_token"`
	PushoverEnabled   bool   `json:"pushover_enabled" toml:"pushover_enabled"`
	WebhookURL        string `json:"webhook_url" toml:"webhook_url"`
	WebhookEnabled    bool   `json:"webhook_enabled" toml:"webhook_enabled"`
	SimplepushKey     string `json:"simplepush_key" toml:"simplepush_key"`
	SimplepushEnabled bool   `json:"simplepush_enabled" toml:"simplepush_enabled"`
	KanbanPasswordEnc string `json:"kanban_password_enc" toml:"kanban_password_enc"`
	KanbanUsername    string `json:"kanban_username,omitempty" toml:"kanban_username,omitempty"`
	KanbanURL         string `json:"kanban_url,omitempty" toml:"kanban_url,omitempty"`
	// AccessPasswordHash is an optional browser-derived password verifier.
	// An empty string deliberately disables Phi's access-password gate.
	AccessPasswordHash string       `json:"access_password_hash" toml:"access_password_hash"`
	SyncCoordinator    string       `json:"sync_coordinator" toml:"sync_coordinator"`
	AutoReconnect      string       `json:"auto_reconnect" toml:"auto_reconnect"`
	Peers              []PeerConfig `json:"peers" toml:"peers"`
}

type PeerConfig struct {
	Name string `json:"name" toml:"name"`
	URL  string `json:"url" toml:"url"`
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
// ~/.phi/config.toml. Anything else will trigger the guard below.
var testConfigPath string
var testLegacyConfigPath string
var configReadErrorLogged atomic.Bool

// testCustomBackendsDir points customBackendsDir() at a temp dir
// during tests. Same isolation contract as testConfigPath: an unset
// value under `go test` panics so a test that forgets withTempBackends
// cannot silently scan the user's real ~/.phi/backends directory
// (R3). Production code always goes through customBackendsDir.
var testCustomBackendsDir string

// configFilePath returns the active config path. Tests MUST override
// testConfigPath to point at a temp file — otherwise the guard in
// this function refuses to return the live ~/.phi/config.toml path.
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
			"isolate this test from ~/.phi/config.toml — see the doc comment on " +
			"testConfigPath.")
	}
	return filepath.Join(system.PhiDataDir(), "config.toml")
}

// legacyConfigFilePath returns the read-only JSON fallback. Tests must opt in explicitly.
func legacyConfigFilePath() string {
	if testLegacyConfigPath != "" {
		return testLegacyConfigPath
	}
	if testing.Testing() {
		return ""
	}
	return filepath.Join(system.PhiDataDir(), "config.json")
}

// customBackendsDir returns the directory phi scans for custom
// backend JSON files at startup. Each `*.json` file is parsed as a
// sparse CoderPatch and merged onto the matching built-in (or
// inserted as a new coder if the ID is novel). Production path is
// `~/.phi/backends/`; tests override via testCustomBackendsDir.
//
// The panic-under-`go test` guard mirrors configFilePath's. A test
// that reads the live backends dir without isolating itself would
// either pick up the developer's local profiles (surprising) or
// silently shadow them (worse).
func customBackendsDir() string {
	if testCustomBackendsDir != "" {
		return testCustomBackendsDir
	}
	if testing.Testing() {
		panic("customBackendsDir() called under `go test` without testCustomBackendsDir set. " +
			"Use withTempBackends(t) (or set testCustomBackendsDir directly) to " +
			"isolate this test from ~/.phi/backends/ — see the doc comment on " +
			"testCustomBackendsDir.")
	}
	return filepath.Join(system.PhiDataDir(), "backends")
}

// overrideDisplayName returns the hostname_override label for identity
// reporting (config payload, status dump, push titles). The stored
// value is a free-form display label — validated by
// sanitizeHostnameOverride (length + printable-only) — and is reported
// verbatim: the whole point of the override is that it can be a
// nickname or codename that ISN'T a real hostname ("dusty_potato" on
// a corp PC named CORP01), so there is nothing to strip or reduce.
func overrideDisplayName(v string) string {
	return strings.TrimSpace(v)
}

// reportedHostname is the machine identity the backend stamps on
// everything it emits: the config payload's hostname field, the
// startup status dump, idle/push notification titles. A set
// HostnameOverride (the display label) wins; blank falls back to the
// OS hostname, then localhost. This is a COSMETIC identity only —
// socket dialing always uses the real page origin and never sees
// this value. One name everywhere, no drift.
func reportedHostname(cfg Config) string {
	if h := overrideDisplayName(cfg.HostnameOverride); h != "" {
		return h
	}
	if h, _ := os.Hostname(); h != "" {
		return h
	}
	return "localhost"
}

func loadConfig() Config {
	cfg, err := loadConfigWithError()
	if err != nil {
		logConfigReadError(configFilePath(), err)
		return applyConfigDefaults(Config{CompressionEnabled: true})
	}
	return cfg
}

// Startup must not turn a config read error into a disabled access-password gate.
func loadConfigWithError() (Config, error) {
	configMu.RLock()
	defer configMu.RUnlock()
	cfg, err := readConfigLocked()
	if err != nil {
		return Config{}, err
	}
	return applyConfigDefaults(cfg), nil
}

func logConfigReadError(path string, err error) {
	if err != nil && configReadErrorLogged.CompareAndSwap(false, true) {
		slog.Error("config read or migration failed", "path", path, "err", err)
	}
}

func applyConfigDefaults(cfg Config) Config {
	if cfg.Workspaces == nil {
		cfg.Workspaces = []string{}
	}
	if cfg.ThemeColor == "" {
		cfg.ThemeColor = "purple"
	}
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
	if cfg.ThinkingPresets == nil {
		cfg.ThinkingPresets = []string{}
	}
	if cfg.QuickCommands == nil {
		cfg.QuickCommands = []QuickCommand{{Name: "status", Command: "git status"}, {Name: "diff", Command: "git diff"}, {Name: "commit", Command: `git commit -m "{}"`}}
	}
	if cfg.TerminalCommands == nil {
		cfg.TerminalCommands = []QuickCommand{{Name: "vim", Command: "vim"}, {Name: "nvim", Command: "nvim"}, {Name: "git push", Command: "git push"}, {Name: "git pull --rebase", Command: "git pull --rebase"}}
	}
	if cfg.MarkdownDirs == nil {
		cfg.MarkdownDirs = []string{".", "./temp", "./tmp"}
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
	cfg.OpenCodeIdleStopMinutes = normalizeOpenCodeIdleStopMinutes(cfg.OpenCodeIdleStopMinutes)
	return cfg
}

// Resolve the default at use time so saving config does not pin the port.
func (cfg Config) syncCoordinatorURL(addr *net.TCPAddr) string {
	if cfg.SyncCoordinator != "" {
		return cfg.SyncCoordinator
	}
	address := addr.String()
	if len(addr.IP) == 0 || addr.IP.IsUnspecified() {
		address = net.JoinHostPort("localhost", strconv.Itoa(addr.Port))
	}
	return (&url.URL{Scheme: "http", Host: address}).String()
}

func normalizeOpenCodeIdleStopMinutes(mins int) int {
	if mins <= 0 {
		return 0
	}
	if mins < 5 {
		return 5
	}
	if mins > 1440 {
		return 1440
	}
	return mins
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

	// Legacy callers hold a full snapshot from loadConfig, which may be
	// older than disk. Thinking presets are owned by their own endpoint,
	// so always keep the latest persisted list instead of overwriting it
	// with this snapshot. An unreadable or malformed file is not a safe
	// base: skip the write rather than destroy it.
	latest, err := readConfigLocked()
	if err != nil {
		return
	}
	cfg.ThinkingPresets = latest.ThinkingPresets

	// Defense in depth: never persist a workspace whose path looks
	// like a test scratch dir (e.g. /tmp/phi-test-alpha). This guards
	// against the earlier poisoning incident where a test wrote three
	// fake workspaces into the live ~/.phi/config.toml.
	_ = writeConfigLocked(cfg)
}

// readPrimaryConfig decodes TOML and reports physical presence independently of contents.
func readPrimaryConfig() (Config, bool, error) {
	var cfg Config
	cfg.CompressionEnabled = true
	path := configFilePath()
	if _, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return cfg, false, nil
		}
		return cfg, true, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, true, err
	}
	if strings.TrimSpace(string(b)) == "" {
		return cfg, true, nil
	}
	if err := toml.Unmarshal(b, &cfg); err != nil {
		return cfg, true, err
	}
	return cfg, true, nil
}

func readLegacyConfig() (Config, bool, error) {
	var cfg Config
	cfg.CompressionEnabled = true
	path := legacyConfigFilePath()
	if path == "" {
		return cfg, false, nil
	}
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return cfg, false, nil
		}
		return cfg, true, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, true, err
	}
	if len(b) == 0 || strings.TrimSpace(string(b)) == "" {
		return cfg, true, nil
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, true, err
	}
	return cfg, true, nil
}

func readConfigLocked() (Config, error) {
	cfg, present, err := readPrimaryConfig()
	if err != nil || present {
		return cfg, err
	}
	cfg, _, err = readLegacyConfig()
	return cfg, err
}

func writeConfigLocked(cfg Config) error {
	cfg.Workspaces = filterOutTestPaths(cfg.Workspaces)
	before, present, err := readPrimaryConfig()
	if err != nil {
		return err
	}
	if present && reflect.DeepEqual(applyConfigDefaults(before), applyConfigDefaults(cfg)) {
		return nil
	}
	path := configFilePath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// MkdirAll preserves existing directory permissions; a new path is private.
	b, err := toml.Marshal(cfg)
	if err != nil {
		return err
	}
	return system.WriteFileAtomic(path, b, 0600)
}

func migrateLegacyConfig() {
	configMu.Lock()
	defer configMu.Unlock()
	_, present, err := readPrimaryConfig()
	if err != nil {
		logConfigReadError(configFilePath(), err)
		return
	}
	if present {
		return
	}
	legacy, legacyPresent, err := readLegacyConfig()
	if err != nil {
		logConfigReadError(legacyConfigFilePath(), err)
		return
	}
	if !legacyPresent {
		return
	}
	if err := writeConfigLocked(legacy); err != nil {
		logConfigReadError(configFilePath(), err)
		return
	}
	slog.Info("migrated legacy config", "from", legacyConfigFilePath(), "to", configFilePath())
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
