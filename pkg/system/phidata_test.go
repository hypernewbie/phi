package system

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPhiDataDirDoesNotMoveAssistantHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	ignoredEnv := filepath.Join(t.TempDir(), "inherited")
	t.Setenv("PHI_DATA_DIR", ignoredEnv)
	if got, want := PhiDataDir(), filepath.Join(home, ".phi"); got != want {
		t.Fatalf("default dir = %q, want %q", got, want)
	}
	custom := filepath.Join(t.TempDir(), "phi-state")
	SetPhiDataDir(custom)
	t.Cleanup(func() { SetPhiDataDir("") })
	if got := PhiDataDir(); got != custom {
		t.Fatalf("custom dir = %q, want %q", got, custom)
	}
	if got := os.Getenv("PHI_DATA_DIR"); got != ignoredEnv {
		t.Fatalf("override changed child environment: got %q, want %q", got, ignoredEnv)
	}
}
