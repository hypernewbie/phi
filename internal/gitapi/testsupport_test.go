package gitapi

import (
	"os"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/pty"
)

// The fixture mirrors the process wiring: a config store rooted at a temp
// directory, a cwd the handlers fall back to, and optional panes whose working
// directories widen the trusted roots.
var (
	activeCWD  string
	ptyManager *pty.Manager
	testStore  *config.Store
)

// testAPI builds the API under test from the fixture state.
func testAPI() *API {
	return New(
		func() string { return activeCWD },
		func() *pty.Manager { return ptyManager },
		func() []string { return testWorkspaceRoots() },
	)
}

// testWorkspaceRoots resolves the cwd, configured workspaces, and live pane
// directories, the same set the server trusts for repository actions.
func testWorkspaceRoots() []string {
	var roots []string
	if activeCWD != "" {
		roots = append(roots, activeCWD)
	}
	if testStore != nil {
		roots = append(roots, testStore.Load().Workspaces...)
	}
	if ptyManager != nil {
		for _, inst := range ptyManager.ListActive() {
			if snap := inst.Snapshot(); snap.Cwd != "" {
				roots = append(roots, snap.Cwd)
			}
		}
	}
	return roots
}

// withTempConfig points the package's config store at a fresh temp file.
func withTempConfig(t interface{ Cleanup(func()) }) string {
	path, err := os.CreateTemp("", "phi-gitapi-config-*.toml")
	if err != nil {
		panic(err)
	}
	_ = path.Close()
	testStore = config.NewStore(config.Paths{Primary: path.Name()}, nil)
	t.Cleanup(func() {
		testStore = nil
		_ = os.Remove(path.Name())
	})
	return path.Name()
}

// loadConfig and saveConfig read and write the fixture store.
func loadConfig() config.Config {
	if testStore == nil {
		panic("loadConfig without withTempConfig")
	}
	return testStore.Load()
}

func saveConfig(cfg config.Config) {
	if testStore == nil {
		panic("saveConfig without withTempConfig")
	}
	testStore.SaveLegacy(cfg)
}
