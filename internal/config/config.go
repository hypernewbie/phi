// Package config owns Phi's configuration file: its TOML/JSON formats, the
// in-process cache, and every read-modify-write of the file.
//
// One Store instance is one configuration file. Paths are resolved lazily so
// system.PhiDataDir() can be redirected before the first read. All writes go
// through a single mutex, compare against the on-disk state, and never delete
// an unreadable file: a malformed config is an error, not a blank slate.
package config

import (
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
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

	// Mobile overrides are owned by the revisioned mobile appearance endpoint.
	// Nil families inherit desktop; nil sizes use mobile defaults.
	MobileUIFontFamily       *string `json:"mobile_ui_font_family,omitempty" toml:"mobile_ui_font_family,omitempty"`
	MobileUIFontSize         *int    `json:"mobile_ui_font_size,omitempty" toml:"mobile_ui_font_size,omitempty"`
	MobileTerminalFontFamily *string `json:"mobile_terminal_font_family,omitempty" toml:"mobile_terminal_font_family,omitempty"`
	MobileTerminalFontSize   *int    `json:"mobile_terminal_font_size,omitempty" toml:"mobile_terminal_font_size,omitempty"`
	MobileAppearanceRevision uint64  `json:"mobile_appearance_revision,omitempty" toml:"mobile_appearance_revision,omitempty"`

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
	PsiCommand            string `json:"psi_command,omitempty" toml:"psi_command,omitempty"`
	// PsiCommand is the Psi executable; empty means "psi" on PATH.
	// PsiArgs are extra base arguments for a Psi launch, one argv entry each.
	// PsiEnv is a set of environment overrides, never removals.
	PsiArgs []string          `json:"psi_args,omitempty" toml:"psi_args,omitempty"`
	PsiEnv  map[string]string `json:"psi_env,omitempty" toml:"psi_env,omitempty"`

	// PiCommand is the Pi executable; empty means "pi" on PATH. PiArgs and
	// PiEnv apply to Pi launches only, mirroring the Psi settings, so each
	// agent keeps its own launch configuration.
	PiCommand string            `json:"pi_command,omitempty" toml:"pi_command,omitempty"`
	PiArgs    []string          `json:"pi_args,omitempty" toml:"pi_args,omitempty"`
	PiEnv     map[string]string `json:"pi_env,omitempty" toml:"pi_env,omitempty"`

	// PiDefaultMode selects the agent a new Pi launch starts by default:
	// "pi" or "psi", always explicit on disk. An empty value from an older
	// config is migrated to "pi" on load.
	// Empty means Pi, so an existing config file keeps its behaviour.
	// Owned by the revisioned /api/config/pi-launch endpoint; saved tabs keep
	// the mode they were created with.
	PiDefaultMode string `json:"pi_default_mode,omitempty" toml:"pi_default_mode,omitempty"`
	// PiLaunchRevision guards concurrent writes to the Pi launch settings.
	// Only the feature endpoint advances it; SaveLegacy preserves it.
	PiLaunchRevision uint64 `json:"pi_launch_revision,omitempty" toml:"pi_launch_revision,omitempty"`

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
	// once at startup (webassets.New) — changing it needs a restart.
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
	// AccessPasswordHash is the legacy browser-derived verifier. After auth.db
	// migration it is omitted from TOML; auth.db is authoritative.
	AccessPasswordHash  string           `json:"access_password_hash,omitempty" toml:"access_password_hash,omitempty"`
	AccessAuthMigration *MigrationMarker `json:"access_auth_migration,omitempty" toml:"access_auth_migration,omitempty"`
	SyncCoordinator     string           `json:"sync_coordinator" toml:"sync_coordinator"`

	// AuthOrigins lists extra origins a browser may present to the v2 auth
	// routes when a reverse proxy terminates TLS. Same-origin requests never
	// need an entry. Malformed entries are a startup error, not a skip.
	AuthOrigins   []string     `json:"auth_origins,omitempty" toml:"auth_origins,omitempty"`
	AutoReconnect string       `json:"auto_reconnect" toml:"auto_reconnect"`
	Peers         []PeerConfig `json:"peers" toml:"peers"`
}

type PeerConfig struct {
	Name string `json:"name" toml:"name"`
	URL  string `json:"url" toml:"url"`
}

// Paths selects the files a Store owns. Empty fields resolve under
// system.PhiDataDir() at first use; an explicit Primary disables the JSON
// fallback unless Legacy names it, which is how tests stay isolated.
type Paths struct {
	Primary string
	Legacy  string
}

// Writer replaces the config file atomically. Production uses the strict
// variant that never deletes an existing config.
type Writer func(path string, data []byte, perm os.FileMode) error

// Store is one configuration file plus its in-process cache. It is safe for
// concurrent use; every write is a locked read-modify-write against disk.
type Store struct {
	paths Paths
	write Writer

	mu              sync.Mutex
	cache           *cacheEntry
	readErrorLogged atomic.Bool
}

type cacheEntry struct {
	path string
	id   fileID
	cfg  Config
}

// NewStore returns a store for paths. A nil writer uses the atomic
// preserve-existing writer; tests pass a failing writer to inject errors.
func NewStore(paths Paths, write Writer) *Store {
	if write == nil {
		write = system.WriteFileAtomicPreserveExisting
	}
	return &Store{paths: paths, write: write}
}

// PrimaryPath returns the resolved config.toml path. Under `go test` an
// unset path panics: a test that forgets isolation must not read or write
// the developer's live config (2026-07-14 workspace poisoning incident).
func (s *Store) PrimaryPath() string {
	if s.paths.Primary != "" {
		return s.paths.Primary
	}
	if testing.Testing() {
		panic("config.Store used under `go test` without an explicit primary path. " +
			"Point the test store at a temp file so it cannot touch ~/.phi/config.toml.")
	}
	return filepath.Join(system.PhiDataDir(), "config.toml")
}

// LegacyPath returns the JSON fallback path, or "" when it is disabled.
func (s *Store) LegacyPath() string {
	if s.paths.Legacy != "" {
		return s.paths.Legacy
	}
	if s.paths.Primary != "" || testing.Testing() {
		return ""
	}
	return filepath.Join(system.PhiDataDir(), "config.json")
}

// Load returns the config with defaults applied, logging a read error once
// and falling back to defaults so startup keeps working.
func (s *Store) Load() Config {
	cfg, err := s.LoadWithError()
	if err != nil {
		s.logReadError(err)
		return applyDefaults(Config{CompressionEnabled: true})
	}
	return cfg
}

// LoadWithError returns the config with defaults applied. Startup must not
// turn a config read error into a disabled access-password gate, so callers
// that gate security on config use this instead of Load.
func (s *Store) LoadWithError() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.readCachedLocked()
	if err != nil {
		return Config{}, err
	}
	return applyDefaults(cfg), nil
}

// MigratePiDefault persists the explicit launch default for primary configs
// written before the feature existed. It runs once at startup, never on a
// read path: reads must not rewrite the config file. A fresh install (no
// primary file) and the legacy JSON fallback are left alone; applyDefaults
// already reports the explicit value for them.
func (s *Store) MigratePiDefault() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, present, err := s.readPrimary()
	if err != nil || !present {
		return err
	}
	cfg, err := s.readLocked()
	if err != nil {
		return err
	}
	if cfg.PiDefaultMode != "" {
		return nil
	}
	cfg.PiDefaultMode = "pi"
	return s.writeContentsLocked(cfg)
}

// ReadAuthoritative returns the config exactly as stored, without defaults.
// An unreadable config is an error: authentication must become unavailable
// rather than look like "no password set".
func (s *Store) ReadAuthoritative() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

// SaveLegacy persists a full snapshot from a caller that does not own any
// field exclusively. Fields with their own flows (thinking presets, mobile
// appearance, the auth verifier and migration marker) keep their latest
// on-disk values. An unreadable file is never replaced.
func (s *Store) SaveLegacy(cfg Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	latest, err := s.readLocked()
	if err != nil {
		return
	}
	cfg.ThinkingPresets = latest.ThinkingPresets
	cfg.MobileUIFontFamily = latest.MobileUIFontFamily
	cfg.MobileUIFontSize = latest.MobileUIFontSize
	cfg.MobileTerminalFontFamily = latest.MobileTerminalFontFamily
	cfg.MobileTerminalFontSize = latest.MobileTerminalFontSize
	cfg.MobileAppearanceRevision = latest.MobileAppearanceRevision
	cfg.PiDefaultMode = latest.PiDefaultMode
	cfg.PiLaunchRevision = latest.PiLaunchRevision
	cfg.PsiCommand = latest.PsiCommand
	cfg.PsiArgs = latest.PsiArgs
	cfg.PsiEnv = latest.PsiEnv
	cfg.PiCommand = latest.PiCommand
	cfg.PiArgs = latest.PiArgs
	cfg.PiEnv = latest.PiEnv
	cfg.AccessPasswordHash = latest.AccessPasswordHash
	cfg.AccessAuthMigration = latest.AccessAuthMigration
	_ = s.writeContentsLocked(cfg)
}

// Update applies mutate to the latest on-disk config under the store lock and
// writes the result. It returns the config it read (plus any mutation) even
// when mutate or the write fails, so handlers can echo current state.
func (s *Store) Update(mutate func(*Config) error) (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.readLocked()
	if err != nil {
		return Config{}, err
	}
	if err := mutate(&cfg); err != nil {
		return cfg, err
	}
	if err := s.writeContentsLocked(cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// SaveAccessPasswordHash persists only the access verifier, so a password
// change never rewrites the rest of the config from a stale snapshot.
func (s *Store) SaveAccessPasswordHash(encoded string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.readLocked()
	if err != nil {
		return err
	}
	cfg.AccessPasswordHash = encoded
	return s.writeContentsLocked(cfg)
}

// CompareAndSwapMigration moves the Config/SQLite import marker in one locked
// sequence: read, compare verifier and marker, write, read back. A concurrent
// change fails the compare instead of overwriting it.
func (s *Store) CompareAndSwapMigration(expected *MigrationMarker, expectedVerifier string, next *MigrationMarker, nextVerifier string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.readLocked()
	if err != nil {
		return err
	}
	if cfg.AccessPasswordHash != expectedVerifier || !SameMigrationMarker(cfg.AccessAuthMigration, expected) {
		return errors.New("auth migration Config changed during startup")
	}
	cfg.AccessPasswordHash = nextVerifier
	cfg.AccessAuthMigration = next
	if err := s.writeContentsLocked(cfg); err != nil {
		return err
	}
	written, err := s.readLocked()
	if err != nil {
		return err
	}
	if written.AccessPasswordHash != nextVerifier || !SameMigrationMarker(written.AccessAuthMigration, next) {
		return errors.New("auth migration Config write did not verify")
	}
	return nil
}

// ReadStored returns the primary file exactly as stored, plus whether it
// exists. It bypasses the cache and defaults; diagnostics and tests use it.
func (s *Store) ReadStored() (Config, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readPrimary()
}

// ResetCache drops the parsed cache so the next read hits disk. Tests use it
// after touching the file behind the store's back.
func (s *Store) ResetCache() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache = nil
}

func (s *Store) logReadError(err error) {
	if err != nil && s.readErrorLogged.CompareAndSwap(false, true) {
		slog.Error("config read or migration failed", "path", s.PrimaryPath(), "err", err)
	}
}

func applyDefaults(cfg Config) Config {
	if cfg.PiDefaultMode == "" {
		cfg.PiDefaultMode = "pi"
	}
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
		// Retain at most 32 MiB of recent output per pane in RAM.
		defaultBytes := 32 << 20
		cfg.ReplayBufferBytes = &defaultBytes
	}
	if *cfg.ReplayBufferBytes > 32<<20 {
		// The hard ceiling is not a user preference: clamp the effective
		// value without rewriting the stored configuration.
		clamped := 32 << 20
		cfg.ReplayBufferBytes = &clamped
	}
	if cfg.AutoReconnect == "" {
		cfg.AutoReconnect = "visible"
	}
	if cfg.Peers == nil {
		cfg.Peers = []PeerConfig{}
	}
	cfg.OpenCodeIdleStopMinutes = NormalizeOpenCodeIdleStopMinutes(cfg.OpenCodeIdleStopMinutes)
	return cfg
}

// SyncCoordinatorURL resolves the default at use time so saving config does
// not pin the port.
func (cfg Config) SyncCoordinatorURL(addr *net.TCPAddr) string {
	if cfg.SyncCoordinator != "" {
		return cfg.SyncCoordinator
	}
	address := addr.String()
	if len(addr.IP) == 0 || addr.IP.IsUnspecified() {
		address = net.JoinHostPort("localhost", strconv.Itoa(addr.Port))
	}
	return (&url.URL{Scheme: "http", Host: address}).String()
}

// NormalizeOpenCodeIdleStopMinutes clamps the idle stop to 0 (disabled) or
// 5..1440 minutes.
func NormalizeOpenCodeIdleStopMinutes(mins int) int {
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

// readPrimary decodes TOML and reports physical presence independently of contents.
func (s *Store) readPrimary() (Config, bool, error) {
	var cfg Config
	cfg.CompressionEnabled = true
	path := s.PrimaryPath()
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
	metadata, err := toml.Decode(string(b), &cfg)
	if err != nil {
		return cfg, true, err
	}
	if err := validateMigrationTOML(metadata, cfg); err != nil {
		return cfg, true, err
	}
	return cfg, true, nil
}

func (s *Store) readLegacy() (Config, bool, error) {
	var cfg Config
	cfg.CompressionEnabled = true
	path := s.LegacyPath()
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
	if err := decodeMigrationJSON(b, &cfg); err != nil {
		return cfg, true, err
	}
	return cfg, true, nil
}

func (s *Store) readLocked() (Config, error) {
	cfg, present, err := s.readPrimary()
	if err != nil || present {
		return cfg, err
	}
	cfg, _, err = s.readLegacy()
	return cfg, err
}

// fileID snapshots the identity of the primary config path: the link itself
// (Lstat) plus, for symlinks, its target (Stat). A nil lstat means the path is
// absent or Lstat failed; a nil stat on a symlink means dangling.
type fileID struct {
	lstat os.FileInfo
	stat  os.FileInfo
}

func statFile(path string) fileID {
	var id fileID
	lstat, err := os.Lstat(path)
	if err != nil {
		return id
	}
	id.lstat = lstat
	if lstat.Mode()&os.ModeSymlink != 0 {
		// A dangling link leaves stat nil, which never matches.
		id.stat, _ = os.Stat(path)
	}
	return id
}

// sameFile reports whether two snapshots describe the same unmodified file:
// same inode (catches atomic replacement), size, mtime, and mode (catches
// in-place edits and chmod). Symlink targets must match too; dangling links
// never match.
func sameFile(a, b fileID) bool {
	if a.lstat == nil || b.lstat == nil {
		return false
	}
	if !os.SameFile(a.lstat, b.lstat) {
		return false
	}
	if a.lstat.Size() != b.lstat.Size() ||
		!a.lstat.ModTime().Equal(b.lstat.ModTime()) ||
		a.lstat.Mode() != b.lstat.Mode() {
		return false
	}
	if a.lstat.Mode()&os.ModeSymlink == 0 {
		return true
	}
	if a.stat == nil || b.stat == nil {
		return false
	}
	if !os.SameFile(a.stat, b.stat) {
		return false
	}
	return a.stat.Size() == b.stat.Size() &&
		a.stat.ModTime().Equal(b.stat.ModTime()) &&
		a.stat.Mode() == b.stat.Mode()
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// cloneConfig deep-copies every mutable Config field so cache hits stay
// isolated from caller mutation and default insertion. Nil-versus-empty
// distinctions are preserved; the caller applies defaults afterwards.
func cloneConfig(cfg Config) Config {
	cfg.Workspaces = slices.Clone(cfg.Workspaces)
	cfg.ExpandedWorktrees = maps.Clone(cfg.ExpandedWorktrees)
	cfg.ActiveWorktrees = maps.Clone(cfg.ActiveWorktrees)
	if cfg.ModelPresets != nil {
		presets := make(ModelPresetsMap, len(cfg.ModelPresets))
		for coder, list := range cfg.ModelPresets {
			presets[coder] = slices.Clone(list)
		}
		cfg.ModelPresets = presets
	}
	cfg.ThinkingPresets = slices.Clone(cfg.ThinkingPresets)
	cfg.QuickCommands = slices.Clone(cfg.QuickCommands)
	cfg.TerminalCommands = slices.Clone(cfg.TerminalCommands)
	cfg.MarkdownDirs = slices.Clone(cfg.MarkdownDirs)
	cfg.MobileUIFontFamily = clonePtr(cfg.MobileUIFontFamily)
	cfg.MobileUIFontSize = clonePtr(cfg.MobileUIFontSize)
	cfg.MobileTerminalFontFamily = clonePtr(cfg.MobileTerminalFontFamily)
	cfg.MobileTerminalFontSize = clonePtr(cfg.MobileTerminalFontSize)
	cfg.ReplayBufferBytes = clonePtr(cfg.ReplayBufferBytes)
	cfg.PsiArgs = slices.Clone(cfg.PsiArgs)
	cfg.PsiEnv = maps.Clone(cfg.PsiEnv)
	cfg.PiArgs = slices.Clone(cfg.PiArgs)
	cfg.PiEnv = maps.Clone(cfg.PiEnv)
	cfg.Peers = slices.Clone(cfg.Peers)
	cfg.AuthOrigins = slices.Clone(cfg.AuthOrigins)
	cfg.AccessAuthMigration = clonePtr(cfg.AccessAuthMigration)
	return cfg
}

// readCachedLocked serves read-only callers from a parsed cache when the
// primary file is unchanged. The caller must hold s.mu. A result is cached
// only when the file is stable across the read; legacy fallback and errors
// stay uncached.
func (s *Store) readCachedLocked() (Config, error) {
	return s.readCachedLockedWith(s.readPrimary)
}

// readCachedLockedWith is readCachedLocked with an injectable primary reader,
// so cache tests can simulate a file swap in the middle of a read.
func (s *Store) readCachedLockedWith(readPrimary func() (Config, bool, error)) (Config, error) {
	path := s.PrimaryPath()
	before := statFile(path)
	if s.cache != nil && s.cache.path == path && sameFile(before, s.cache.id) {
		return cloneConfig(s.cache.cfg), nil
	}
	s.cache = nil
	cfg, present, err := readPrimary()
	if err != nil || present {
		if err == nil {
			if after := statFile(path); sameFile(before, after) {
				s.cache = &cacheEntry{path: path, id: after, cfg: cloneConfig(cfg)}
			}
		}
		return cfg, err
	}
	cfg, _, err = s.readLegacy()
	return cfg, err
}

// writeContentsLocked writes a config whose caller-owned fields are already
// current. Callers must hold s.mu.
func (s *Store) writeContentsLocked(cfg Config) error {
	// Invalidate before every attempt, including no-op and failed ones: a
	// cheap reread beats reasoning about which failures leave disk stale.
	s.cache = nil
	cfg.Workspaces = filterOutTestPaths(cfg.Workspaces)
	// The launch default is always explicit on disk; never write an empty
	// value that readers would have to interpret.
	if cfg.PiDefaultMode == "" {
		cfg.PiDefaultMode = "pi"
	}
	before, present, err := s.readPrimary()
	if err != nil {
		return err
	}
	// A legacy file with an empty default must be rewritten even when the
	// defaulted forms compare equal, or the migration would never persist.
	migratePiDefault := present && before.PiDefaultMode == ""
	if !migratePiDefault && present && reflect.DeepEqual(applyDefaults(before), applyDefaults(cfg)) {
		return nil
	}
	path := s.PrimaryPath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// MkdirAll preserves existing directory permissions; a new path is private.
	b, err := toml.Marshal(cfg)
	if err != nil {
		return err
	}
	// PreserveExisting keeps the old config on a failed replacement.
	return s.write(path, b, 0600)
}

// looksLikeTestArtifact returns true if `path` looks like a scratch
// directory a Go test created via MkdirTemp / os.CreateTemp with a
// phi-prefixed pattern. Used as a final defense-in-depth check: even
// if a save is somehow called during a test that bypassed the
// temp-path guard, refuse to persist a workspace that lives
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
// don't look like a test scratch directory. See SaveLegacy for the
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
