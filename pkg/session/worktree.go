package session

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"sync"

	"github.com/hypernewbie/phi/pkg/obs"
)

type GitWorktree struct {
	Path               string `json:"path"`
	Branch             string `json:"branch"`
	Active             bool   `json:"active"`
	Expanded           bool   `json:"expanded"`
	HasUnstagedChanges bool   `json:"hasUnstagedChanges"`
}

func hasUnstagedChanges(ctx context.Context, dir string) bool {
	ctx, end := obs.Span(ctx, "git.status", "cwd", dir)
	cmd := exec.CommandContext(ctx, "git", "status", "--porcelain")
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	end(err)
	if err != nil {
		return false
	}
	return strings.TrimSpace(out.String()) != ""
}

func WorktreeDirtyStates(ctx context.Context, paths []string) map[string]bool {
	states := make(map[string]bool, len(paths))
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, p := range paths {
		path := p
		wg.Add(1)
		go func() {
			defer wg.Done()
			dirty := hasUnstagedChanges(ctx, path)
			mu.Lock()
			states[path] = dirty
			mu.Unlock()
		}()
	}

	wg.Wait()
	return states
}

// ListGitWorktrees runs "git worktree list --porcelain" in dir. If it fails or is not a git repo,
// it returns a single GitWorktree entry representing the dir itself.
func ListGitWorktrees(ctx context.Context, dir string) ([]GitWorktree, error) {
	ctx, end := obs.Span(ctx, "git.worktree.list", "cwd", dir)
	defer func() { end(nil) }() // this func never itself returns a non-nil error

	cmd := exec.CommandContext(ctx, "git", "worktree", "list", "--porcelain")
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		// Not a git repo, return single entry for dir itself
		return []GitWorktree{{Path: dir, Branch: ""}}, nil
	}

	var worktrees []GitWorktree
	var current GitWorktree

	for _, line := range strings.Split(out.String(), "\n") {
		line = strings.TrimRight(line, "\r")

		if line == "" {
			if current.Path != "" {
				worktrees = append(worktrees, current)
				current = GitWorktree{}
			}
			continue
		}

		if strings.HasPrefix(line, "worktree ") {
			current.Path = strings.TrimPrefix(line, "worktree ")
		} else if strings.HasPrefix(line, "branch ") {
			ref := strings.TrimPrefix(line, "branch ")
			if idx := strings.LastIndex(ref, "/"); idx >= 0 {
				current.Branch = ref[idx+1:]
			} else {
				current.Branch = ref
			}
		}
	}

	if current.Path != "" {
		worktrees = append(worktrees, current)
	}

	if len(worktrees) == 0 {
		return []GitWorktree{{Path: dir, Branch: ""}}, nil
	}

	return worktrees, nil
}
