package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/internal/attachments"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/internal/server"
	"github.com/hypernewbie/phi/pkg/system"
)

func TestPhiDataDirRoutesStateWithoutMovingHome(t *testing.T) {
	home := t.TempDir()
	data := t.TempDir()
	t.Setenv("HOME", home)
	system.SetPhiDataDir(data)
	t.Cleanup(func() { system.SetPhiDataDir("") })
	app := server.New(server.Options{Config: config.NewStore(config.Paths{Primary: filepath.Join(data, "config.toml")}, nil)})
	for name, got := range map[string]string{
		"clipboard":           attachments.ClipboardDir(),
		"syncboard.json":      app.SyncFilePath(),
		"prompt_history.json": app.PromptHistoryPath(),
	} {
		if want := filepath.Join(data, name); got != want {
			t.Errorf("%s: got %q, want %q", name, got, want)
		}
	}
	if err := piapp.MaterializeStableAt(func() ([]byte, error) { return []byte("bundle"), nil }, "0.1.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(data, "pi-bridge", "pi-phi-extension.cjs")); err != nil {
		t.Fatalf("bridge bundle outside Phi data dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".phi")); !os.IsNotExist(err) {
		t.Fatalf("test modified HOME's Phi state: %v", err)
	}
}
