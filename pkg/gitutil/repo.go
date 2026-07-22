// Package gitutil provides cheap workspace-level probes for git repository
// state — used to suppress the "fatal: not a git repository ..." stderr
// spam that otherwise hits every workspace switch in non-repo dirs.
package gitutil

import (
	"context"
	"os/exec"

	"github.com/hypernewbie/phi/pkg/obs"
)

// IsGitRepo reports whether dir is inside a git working tree.
//
// Uses `git rev-parse --is-inside-work-tree` which:
//   - exits 0 with stdout "true" when cwd is anywhere inside a work tree
//   - exits 128 with stderr starting "fatal: not a git repository ..." otherwise.
//
// The 5–10 ms cost is cheap relative to a `git status` or `git diff` spawn,
// and it lets us skip the git binary entirely when there's no repo — so the
// "fatal: not a git repository..." message never reaches the frontend.
//
// dir == "" is treated as not-a-repo (defensive against activeCWD races).
func IsGitRepo(ctx context.Context, dir string) bool {
	if dir == "" {
		return false
	}
	ctx, end := obs.Span(ctx, "git.repo_check", "cwd", dir)
	defer func() { end(nil) }() // probe result is not an error in either branch
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--is-inside-work-tree")
	cmd.Dir = dir
	return cmd.Run() == nil
}
