package main

import (
	"os"
	"strings"
	"sync"

	"github.com/hypernewbie/phi/internal/config"
)

// Type aliases keep the pre-split names in the main package while the
// definitions live in internal/config. They go away when the last consumer
// moves out of main.
type (
	Config                    = config.Config
	QuickCommand              = config.QuickCommand
	ModelPresetsMap           = config.ModelPresetsMap
	PeerConfig                = config.PeerConfig
	accessAuthMigrationMarker = config.MigrationMarker
)

// testConfigPath and testLegacyConfigPath point the store at temp files
// during tests. Production leaves both empty, so paths resolve under
// system.PhiDataDir() at first use. Setting either one echoes the pre-split
// globals the test suite already uses.
var (
	testConfigPath       string
	testLegacyConfigPath string
)

var (
	configStoreMu    sync.Mutex
	configStoreValue *config.Store
	configStorePaths config.Paths
	configWriter     config.Writer // nil selects the atomic default
)

// configStore returns the store for the current paths, rebuilding it when a
// test repoints the temp paths or swaps the writer. Production never changes
// either, so this is a constant after startup.
func configStore() *config.Store {
	paths := config.Paths{Primary: testConfigPath, Legacy: testLegacyConfigPath}
	configStoreMu.Lock()
	defer configStoreMu.Unlock()
	if configStoreValue == nil || configStorePaths != paths {
		configStoreValue, configStorePaths = config.NewStore(paths, configWriter), paths
	}
	return configStoreValue
}

// resetConfigStore forces the next configStore() call to rebuild, so a writer
// swapped by a test takes effect.
func resetConfigStore() {
	configStoreMu.Lock()
	defer configStoreMu.Unlock()
	configStoreValue = nil
}

// setConfigWriter installs the writer future stores use (nil = atomic
// default) and rebuilds the store immediately.
func setConfigWriter(w config.Writer) {
	configWriter = w
	resetConfigStore()
}

func loadConfig() Config { return configStore().Load() }

func loadConfigWithError() (Config, error) { return configStore().LoadWithError() }

func saveConfig(cfg Config) { configStore().SaveLegacy(cfg) }

// configFilePath is the resolved primary path for logging and tests.
func configFilePath() string { return configStore().PrimaryPath() }

// legacyConfigFilePath is the JSON fallback path, empty when disabled.
func legacyConfigFilePath() string { return configStore().LegacyPath() }

// readPrimaryConfig exposes the stored primary file, with presence, for tests
// that assert what actually reached disk.
func readPrimaryConfig() (Config, bool, error) { return configStore().ReadStored() }

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

// expandHome resolves a leading ~ against the current user's home
// directory. Unresolvable homes leave the path untouched.
func expandHome(path string) string {
	if len(path) > 0 && path[0] == '~' {
		home, err := os.UserHomeDir()
		if err == nil {
			return home + path[1:]
		}
	}
	return path
}
