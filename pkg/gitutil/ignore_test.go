package gitutil

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// makeIgnoreRepo shells out to `git init` and writes a .gitignore so the
// test reflects the real CLI behavior — IgnoredNames spawns
// `git check-ignore`, so mocking isn't useful. No commits or user config
// are needed: check-ignore reads .gitignore directly.
func makeIgnoreRepo(t *testing.T, gitignore string) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command("git", "init", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init failed: %v\n%s", err, out)
	}
	if gitignore != "" {
		if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(gitignore), 0o644); err != nil {
			t.Fatalf("write .gitignore: %v", err)
		}
	}
	return dir
}

func TestIgnoredNames_RepoFiltersIgnoredEntries(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	dir := makeIgnoreRepo(t, "x.txt\nsub/\n")

	got, err := IgnoredNames(ctx, dir, []string{"x.txt", "y.txt", "sub/"})
	if err != nil {
		t.Fatalf("IgnoredNames returned error: %v", err)
	}
	if !got["x.txt"] {
		t.Errorf("expected x.txt to be ignored, got %v", got)
	}
	if !got["sub/"] {
		t.Errorf("expected sub/ to be ignored, got %v", got)
	}
	if got["y.txt"] {
		t.Errorf("expected y.txt to NOT be ignored, got %v", got)
	}
}

func TestIgnoredNames_EmptyNamesNoSpawn(t *testing.T) {
	// This works even without git, so no skip guard needed.
	ctx := context.Background()
	got, err := IgnoredNames(ctx, "/nonexistent/does/not/matter", nil)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty map, got %v", got)
	}
}

func TestIgnoredNames_NonRepoReturnsError(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()

	_, err := IgnoredNames(ctx, dir, []string{"whatever.txt"})
	if err == nil {
		t.Fatal("expected error for non-repo dir, got nil")
	}
}
