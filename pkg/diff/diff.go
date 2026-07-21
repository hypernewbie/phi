package diff

import (
	"context"

	"github.com/hypernewbie/phi/pkg/pty"
)

func SpawnDiff(ctx context.Context, dir string, commit string, manager *pty.Manager) (*pty.PTYInstance, error) {
	var args []string
	if commit == "staged" {
		args = []string{"--no-pager", "diff", "--cached", "--color=always", "-w"}
	} else if commit == "" || commit == "unstaged" {
		args = []string{"--no-pager", "diff", "--color=always", "-w"}
	} else {
		args = []string{"--no-pager", "show", "--color=always", "-w", commit}
	}
	return manager.Spawn(ctx, dir, "git", args, "diff", "")
}

func SpawnLog(ctx context.Context, dir string, manager *pty.Manager) (*pty.PTYInstance, error) {
	// Run git log with color, oneline format, capped to 10 entries
	args := []string{"--no-pager", "log", "--oneline", "-10", "--color=always"}
	return manager.Spawn(ctx, dir, "git", args, "git-log", "")
}

func SpawnStatus(ctx context.Context, dir string, manager *pty.Manager) (*pty.PTYInstance, error) {
	// Run git status with brief output and branch info.
	// We override colour settings using the global configuration flag -c.
	args := []string{"--no-pager", "-c", "color.status=always", "status", "--short", "--branch"}
	return manager.Spawn(ctx, dir, "git", args, "git-status", "")
}
