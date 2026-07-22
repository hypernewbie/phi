package gitutil

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
)

// makeRepo shells out to `git init` so the test reflects the real CLI
// behavior — IsGitRepo spawns `git rev-parse`, so mocking isn't useful.
func makeRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command("git", "init", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("git not available in this environment: %v\n%s", err, out)
	}
	return dir
}

func TestIsGitRepo(t *testing.T) {
	ctx := context.Background()
	repo := makeRepo(t)
	empty := t.TempDir()
	nested := filepath.Join(empty, "deep", "down", "here") // never created
	blank := ""

	cases := []struct {
		name string
		dir  string
		want bool
	}{
		{"inside a fresh git init", repo, true},
		{"inside a tempdir with no .git", empty, false},
		{"a nested path that does not exist", nested, false},
		{"an empty string dir", blank, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := IsGitRepo(ctx, c.dir)
			if got != c.want {
				t.Errorf("IsGitRepo(%q) = %v; want %v", c.dir, got, c.want)
			}
		})
	}
}
