package access

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/ws"
)

// Test scaffolding for the access package: one temp config store per test,
// installed both in the package store provider and as the Default manager so
// path helpers and handlers resolve the same temp state directory.

var (
	testConfigPath       string
	testLegacyConfigPath string
	testStore            *config.Store
	testWriter           config.Writer
)

func testConfigStore() *config.Store { return testStore }

// withTempConfig points the access state directory at a fresh config file.
func withTempConfig(t *testing.T) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "phi-test-config-*.toml")
	if err != nil {
		t.Fatalf("create temp config: %v", err)
	}
	f.Close()
	origPath, origStore, origState := testConfigPath, testStore, stateStore
	testConfigPath = f.Name()
	testStore = config.NewStore(config.Paths{Primary: testConfigPath, Legacy: testLegacyConfigPath}, nil)
	stateStore = testConfigStore
	t.Cleanup(func() { testConfigPath, testStore, stateStore = origPath, origStore, origState })
	return f.Name()
}

// withTempLegacyConfig points the legacy JSON fallback at a fresh path and
// rebuilds the store so the fallback is live.
func withTempLegacyConfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	origPath, origStore, origState := testLegacyConfigPath, testStore, stateStore
	testLegacyConfigPath = path
	testStore = config.NewStore(config.Paths{Primary: testConfigPath, Legacy: testLegacyConfigPath}, nil)
	stateStore = testConfigStore
	t.Cleanup(func() { testLegacyConfigPath, testStore, stateStore = origPath, origStore, origState })
	return path
}

// newTestManager returns an unconfigured manager wired to the temp store and
// installed as Default, so package handlers and path helpers use it.
func newTestManager(t *testing.T) *Manager {
	t.Helper()
	previous := Default
	manager := NewManager(testConfigStore, testSocketHub)
	Default = manager
	t.Cleanup(func() {
		manager.close()
		Default = previous
	})
	return manager
}

// configFilePath and loadConfig mirror the host's config entry points for the
// temp store. They panic when a test forgot withTempConfig, matching the
// production guard that keeps tests off the live config.
func configFilePath() string {
	if testStore == nil {
		panic("access test used configFilePath without withTempConfig")
	}
	return testStore.PrimaryPath()
}

func loadConfig() Config {
	if testStore == nil {
		panic("access test used loadConfig without withTempConfig")
	}
	return testStore.Load()
}

// Config-format fixtures used by the migration tests.
type (
	QuickCommand    = config.QuickCommand
	ModelPresetsMap = config.ModelPresetsMap
	PeerConfig      = config.PeerConfig
)

// mustRead returns the file contents or fails the test.
func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// readPrimaryConfig exposes the stored config with presence for assertions.
func readPrimaryConfig() (Config, bool, error) {
	if testStore == nil {
		panic("access test used readPrimaryConfig without withTempConfig")
	}
	return testStore.ReadStored()
}

// writeConfigFile and systemWriter keep the migration failure tests able to
// swap the writer, as they did before the config store existed.
func writeConfigFile(path string, data []byte, perm os.FileMode) error {
	if testWriter != nil {
		return testWriter(path, data, perm)
	}
	return system.WriteFileAtomicPreserveExisting(path, data, perm)
}

// setConfigWriter installs a config writer for the rest of the test and
// rebuilds the store so the writer takes effect. nil restores the default.
func setConfigWriter(w config.Writer) {
	testWriter = w
	testStore = config.NewStore(config.Paths{Primary: testConfigPath, Legacy: testLegacyConfigPath}, writeConfigFile)
}

// saveConfig writes a full config snapshot through the temp store.
func saveConfig(cfg Config) {
	if testStore == nil {
		panic("access test used saveConfig without withTempConfig")
	}
	testStore.SaveLegacy(cfg)
}

// testMainShell returns the shell used by tests that need a real PTY.
func testMainShell() (string, []string) {
	if runtime.GOOS == "windows" {
		return "pwsh", []string{"-NoLogo", "-NoProfile", "-NonInteractive"}
	}
	return "bash", []string{"--norc", "--noprofile"}
}

// testHub is the hub a test manager resolves sockets through. Tests install
// one with testAccessUseHub; nil means no socket fencing.
var testHub *ws.Hub

func testSocketHub() *ws.Hub { return testHub }

// currentConfigWriter returns the writer new stores use.
func currentConfigWriter() config.Writer {
	if testWriter != nil {
		return testWriter
	}
	return system.WriteFileAtomicPreserveExisting
}
