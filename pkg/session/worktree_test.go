package session

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestHasUnstagedChangesDoesNotRefreshIndex(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	for _, key := range []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, output)
		}
	}

	runGit("init")
	stablePath := filepath.Join(repo, "stable.txt")
	dirtyPath := filepath.Join(repo, "dirty.txt")
	if err := os.WriteFile(stablePath, []byte("stable\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dirtyPath, []byte("before\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit("add", "stable.txt", "dirty.txt")

	oldTime := time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(stablePath, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dirtyPath, []byte("after\n"), 0644); err != nil {
		t.Fatal(err)
	}

	indexPath := filepath.Join(repo, ".git", "index")
	indexBefore, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if !hasUnstagedChanges(context.Background(), repo) {
		t.Fatal("expected dirty worktree")
	}
	indexAfter, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(indexAfter, indexBefore) {
		t.Fatal("read-only status check refreshed the Git index")
	}
}
