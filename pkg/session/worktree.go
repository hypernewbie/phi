package session

import (
	"bytes"
	"os/exec"
	"strings"
	"sync"
)

type GitWorktree struct {
	Path               string `json:"path"`
	Branch             string `json:"branch"`
	Active             bool   `json:"active"`
	Expanded           bool   `json:"expanded"`
	HasUnstagedChanges bool   `json:"hasUnstagedChanges"`
}

func hasUnstagedChanges(dir string) bool {
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		return false
	}
	return strings.TrimSpace(out.String()) != ""
}

func WorktreeDirtyStates(paths []string) map[string]bool {
	states := make(map[string]bool, len(paths))
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, p := range paths {
		path := p
		wg.Add(1)
		go func() {
			defer wg.Done()
			dirty := hasUnstagedChanges(path)
			mu.Lock()
			states[path] = dirty
			mu.Unlock()
		}()
	}

	wg.Wait()
	return states
}

// ListGitWorktrees runs "git worktree list" in dir. If it fails or is not a git repo,
// it returns a single GitWorktree entry representing the dir itself.
func ListGitWorktrees(dir string) ([]GitWorktree, error) {
	cmd := exec.Command("git", "worktree", "list")
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		// Not a git repo, return single entry for dir itself
		return []GitWorktree{{Path: dir, Branch: ""}}, nil
	}

	var worktrees []GitWorktree
	lines := strings.Split(out.String(), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Example: /home/hypernewbie/code/phi  50527dd [main]
		// Or: /path/to/worktree  (bare)
		fields := strings.Fields(line)
		if len(fields) < 1 {
			continue
		}
		path := fields[0]
		branch := ""
		for _, f := range fields[1:] {
			if strings.HasPrefix(f, "[") && strings.HasSuffix(f, "]") {
				branch = f[1 : len(f)-1]
				break
			}
		}
		worktrees = append(worktrees, GitWorktree{
			Path:   path,
			Branch: branch,
		})
	}

	if len(worktrees) == 0 {
		return []GitWorktree{{Path: dir, Branch: ""}}, nil
	}

	return worktrees, nil
}
