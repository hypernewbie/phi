package server

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/system"
)

// loadConfig reads the live config through the installed store.
func loadConfig() config.Config {
	store := configStore()
	if store == nil {
		return config.Config{}
	}
	return store.Load()
}

// loadConfigWithError reads the live config and reports read failures.
func loadConfigWithError() (config.Config, error) {
	store := configStore()
	if store == nil {
		return config.Config{}, errNoConfigStore
	}
	return store.LoadWithError()
}

// saveConfig writes the config back through the installed store, preserving
// fields other owners changed in the meantime.
func saveConfig(cfg config.Config) {
	if store := configStore(); store != nil {
		store.SaveLegacy(cfg)
	}
}

// configFilePath reports the primary config path.
func configFilePath() string {
	if store := configStore(); store != nil {
		return store.PrimaryPath()
	}
	return filepath.Join(system.PhiDataDir(), "config.toml")
}

// expandHome resolves a leading ~ against the user's home directory.
func expandHome(path string) string {
	if !strings.HasPrefix(path, "~") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~"))
}

// reportedHostname is the display host: the override when set, else the
// kernel hostname.
func reportedHostname(cfg config.Config) string {
	if override := strings.TrimSpace(cfg.HostnameOverride); override != "" {
		return override
	}
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "localhost"
	}
	return name
}
