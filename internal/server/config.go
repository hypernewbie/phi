package server

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/system"
	"testing"
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

// testCustomBackendsDir points customBackendsDir() at a temp dir
// during tests. Same isolation contract as the config store: an unset
// value under `go test` panics so a test that forgets withTempBackends
// cannot silently scan the user's real ~/.phi/backends directory
// (R3). Production code always goes through customBackendsDir.
var testCustomBackendsDir string

// SetCustomBackendsDirForTest overrides the backend scan directory for the
// caller's test and returns a restore function.
func SetCustomBackendsDirForTest(dir string) func() {
	previous := testCustomBackendsDir
	testCustomBackendsDir = dir
	return func() { testCustomBackendsDir = previous }
}

// CustomBackendsDir returns the directory phi scans for custom backend
// JSON files at startup. Each `*.json` file is parsed as a sparse
// CoderPatch and merged onto the matching built-in (or inserted as a
// new coder if the ID is novel). Production path is `~/.phi/backends/`.
//
// The panic-under-`go test` guard mirrors the config store's: a test
// that reads the live backends dir without isolating itself would
// either pick up the developer's local profiles or silently shadow
// them.
func CustomBackendsDir() string {
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
