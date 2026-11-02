package server

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/internal/config"
)

// testStore is the config store the handler tests read and write.
var testStore *config.Store

// withTempConfig points the package at a fresh config file.
func withTempConfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	previous := testStore
	testStore = config.NewStore(config.Paths{Primary: path}, nil)
	ConfigStore = func() *config.Store { return testStore }
	t.Cleanup(func() {
		testStore = previous
		ConfigStore = func() *config.Store { return testStore }
	})
	return path
}

// testConfigPath reports the active temp config path.
func testConfigPathValue() string {
	if testStore == nil {
		return ""
	}
	return testStore.PrimaryPath()
}
