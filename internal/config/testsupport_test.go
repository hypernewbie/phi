package config

// Test scaffolding for the config package. The tests drive one store through
// the same entry points the main package uses, so they keep their original
// assertions while the locking lives in Store.

import (
	"os"
	"path/filepath"
	"testing"
)

var (
	store                *Store
	testConfigPath       string
	testLegacyConfigPath string
)

// withTempConfig points the test store at a fresh primary file for the
// duration of the test, then restores the previous path.
func withTempConfig(t *testing.T) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "phi-test-config-*.toml")
	if err != nil {
		t.Fatalf("create temp config: %v", err)
	}
	f.Close()
	orig := testConfigPath
	testConfigPath = f.Name()
	t.Cleanup(func() { testConfigPath = orig })
	return f.Name()
}

// withTempLegacyConfig points the legacy JSON fallback at a fresh path.
func withTempLegacyConfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	orig := testLegacyConfigPath
	testLegacyConfigPath = path
	t.Cleanup(func() { testLegacyConfigPath = orig })
	return path
}

// currentStore returns the store for the current test paths, rebuilding it
// when a test repoints the paths. Rebuilding also drops the cache, which is
// what changing the file under the store's feet used to do.
func currentStore() *Store {
	paths := Paths{Primary: testConfigPath, Legacy: testLegacyConfigPath}
	if store == nil || store.paths != paths {
		store = NewStore(paths, nil)
	}
	return store
}

// The helpers below mirror the package's pre-split entry points. They do not
// lock: callers either hold the store lock already or run single-threaded.

func loadConfig() Config { return currentStore().Load() }

func loadConfigWithError() (Config, error) { return currentStore().LoadWithError() }

func saveConfig(cfg Config) { currentStore().SaveLegacy(cfg) }

func readConfigLocked() (Config, error) { return currentStore().readLocked() }

func writeConfigLocked(cfg Config) error { return currentStore().writeContentsLocked(cfg) }

func readConfigCachedLocked(readPrimary func() (Config, bool, error)) (Config, error) {
	return currentStore().readCachedLockedWith(readPrimary)
}

func readPrimaryConfig() (Config, bool, error) { return currentStore().readPrimary() }

func configFilePath() string { return currentStore().PrimaryPath() }

// testAccessHash is an opaque verifier fixture. The config package never
// interprets this value; the auth manager does, after the migration.
func testAccessHash() string { return "v1$pbkdf2-sha256$600000$c2FsdA$aGFzaA" }
