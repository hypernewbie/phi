package diff

import (
	"phi/pkg/pty"
)

func SpawnDiff(dir string, manager *pty.Manager) (*pty.PTYInstance, error) {
	// Run git diff with color and ignoring whitespace changes
	args := []string{"diff", "--color=always", "-w"}
	return manager.Spawn(dir, "git", args, "diff", "")
}

func SpawnLog(dir string, manager *pty.Manager) (*pty.PTYInstance, error) {
	// Run git log with color, oneline format, capped to 10 entries
	args := []string{"log", "--oneline", "-10", "--color=always"}
	return manager.Spawn(dir, "git", args, "git-log", "")
}
