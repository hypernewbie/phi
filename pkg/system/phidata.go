package system

import (
	"os"
	"path/filepath"
)

// SetPhiDataDir sets Phi's state root before server startup. It does not
// change the environment inherited by assistant CLIs.
func SetPhiDataDir(dir string) { phiDataDir = dir }

var phiDataDir string

// PhiDataDir is Phi's state root. HOME stays unchanged so assistant CLIs
// continue to use their own settings and sessions.
func PhiDataDir() string {
	if phiDataDir != "" {
		return phiDataDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".phi"
	}
	return filepath.Join(home, ".phi")
}
