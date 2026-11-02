package piapp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/hypernewbie/phi/internal/attachments"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws"
)

// testBundle stands in for the embedded extension; the bridge only writes it.
func testBundle() ([]byte, error) { return []byte("// phi bridge test runtime\n"), nil }

// startTestBridge starts a bridge on its own hub with the synthetic bundle.
func startTestBridge(t *testing.T) *Bridge {
	t.Helper()
	return startTestBridgeWith(t, ws.NewHub(0))
}

// startTestBridgeWith starts a bridge on the given hub and stops it at cleanup.
func startTestBridgeWith(t *testing.T, hub *ws.Hub) *Bridge {
	t.Helper()
	bridge := StartBridge(hub, testBundle, "0.0.0-test")
	if bridge == nil {
		t.Fatal("bridge did not start")
	}
	t.Cleanup(bridge.Stop)
	return bridge
}

// testStore is the config store the syncboard tests route through.
var testStore *config.Store

// withTempConfig points the syncboard tests at a fresh config file.
func withTempConfig(t *testing.T) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	previous := testStore
	testStore = config.NewStore(config.Paths{Primary: path}, nil)
	t.Cleanup(func() { testStore = previous })
}

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

// Config aliases the package config so the moved tests keep their spelling.
type Config = config.Config

// withTempHome points home-directory lookups at a fresh temp directory.
func withTempHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	homeKey := "HOME"
	if runtime.GOOS == "windows" {
		homeKey = "USERPROFILE"
	}
	t.Setenv(homeKey, tmp)
	t.Setenv("HOME", tmp)
	return tmp
}

// testBridge is the bridge the test API resolves; tests install their own.
var testBridge *Bridge

// testPanes is the pane registry the test API and the attachment checks share.
var testPanes *pty.Manager

// withAttachmentTestGlobals installs an isolated attachment store and pane
// registry and returns the API the attachment route tests drive.
func withAttachmentTestGlobals(t *testing.T) *API {
	t.Helper()
	store, err := attachments.OpenAttachmentStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	previous := attachments.Default
	attachments.Default = store
	testPanes = pty.NewManager()
	attachments.SetPaneManager(func() *pty.Manager { return testPanes })
	t.Cleanup(func() {
		attachments.Default = previous
		attachments.SetPaneManager(nil)
		testPanes = nil
		_ = store.Close()
	})
	return testAPI()
}

// testAPI binds the API to the current bridge, store, and pane registry.
func testAPI() *API {
	return NewAPI(
		func() *Bridge { return testBridge },
		func() *attachments.AttachmentStore { return attachments.Default },
		func() *pty.Manager { return testPanes },
	)
}
