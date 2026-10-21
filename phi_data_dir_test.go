package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/pkg/system"
)

func TestPhiDataDirRoutesStateWithoutMovingHome(t *testing.T) {
	home := t.TempDir()
	data := t.TempDir()
	t.Setenv("HOME", home)
	system.SetPhiDataDir(data)
	t.Cleanup(func() { system.SetPhiDataDir("") })
	for name, got := range map[string]string{
		"clipboard":           attachmentDir(),
		"syncboard.json":      syncFilePath(),
		"prompt_history.json": promptHistoryPath(),
	} {
		if want := filepath.Join(data, name); got != want {
			t.Errorf("%s: got %q, want %q", name, got, want)
		}
	}
	if err := materializeStablePiBridgeAt(func() ([]byte, error) { return []byte("bundle"), nil }, "0.1.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(data, piBridgeStableDir, piBridgeArtifactName)); err != nil {
		t.Fatalf("bridge bundle outside Phi data dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".phi")); !os.IsNotExist(err) {
		t.Fatalf("test modified HOME's Phi state: %v", err)
	}
}
