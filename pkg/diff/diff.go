package diff

import (
	"github.com/hypernewbie/phi/pkg/pty"
)

func SpawnDiff(dir string, commit string, manager *pty.Manager) (*pty.PTYInstance, error) {
	var args []string
	if commit == "" || commit == "unstaged" {
		args = []string{"diff", "--color=always", "-w"}
	} else {
		args = []string{"show", "--color=always", "-w", commit}
	}
	return manager.Spawn(dir, "git", args, "diff", "")
}

func SpawnLog(dir string, manager *pty.Manager) (*pty.PTYInstance, error) {
	// Run git log with color, oneline format, capped to 10 entries
	args := []string{"log", "--oneline", "-10", "--color=always"}
	return manager.Spawn(dir, "git", args, "git-log", "")
}

func SpawnStatus(dir string, manager *pty.Manager) (*pty.PTYInstance, error) {
	// Run git status with brief output and branch info.
	// We override colour settings using the global configuration flag -c.
	args := []string{"-c", "color.status=always", "status", "--short", "--branch"}
	return manager.Spawn(dir, "git", args, "git-status", "")
}

