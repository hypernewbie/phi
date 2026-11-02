package main

import (
	"os"
	"strings"
	"sync"

	"github.com/hypernewbie/phi/internal/config"
)

// Type aliases keep the CLI and banner code reading naturally while the
// definitions live in internal/config.
type (
	Config          = config.Config
	QuickCommand    = config.QuickCommand
	ModelPresetsMap = config.ModelPresetsMap
	PeerConfig      = config.PeerConfig
)

// testConfigPath and testLegacyConfigPath point the store at temp files
// during tests. Production leaves both empty, so paths resolve under
// system.PhiDataDir() at first use.
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

func loadConfig() Config { return configStore().Load() }

func saveConfig(cfg Config) { configStore().SaveLegacy(cfg) }

// configFilePath is the resolved primary path for logging and tests.
func configFilePath() string { return configStore().PrimaryPath() }

// reportedHostname is the machine identity the backend stamps on everything
// it emits: the config payload's hostname field, the startup status dump,
// idle/push notification titles. A set HostnameOverride (a free-form display
// label) wins; blank falls back to the OS hostname, then localhost. This is a
// cosmetic identity only — socket dialing never sees this value.
func reportedHostname(cfg Config) string {
	if h := strings.TrimSpace(cfg.HostnameOverride); h != "" {
		return h
	}
	if h, _ := os.Hostname(); h != "" {
		return h
	}
	return "localhost"
}
