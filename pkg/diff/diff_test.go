package diff

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/pty"
)

func initialiseGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	// Initialise a git repository to allow git commands to execute properly.
	cmd := exec.Command("git", "init")
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		t.Fatalf("Failed to initialise git repo: %v", err)
	}

	// We must configure git user name and email so commits work if needed.
	cmdName := exec.Command("git", "config", "user.name", "Test User")
	cmdName.Dir = dir
	_ = cmdName.Run()

	cmdEmail := exec.Command("git", "config", "user.email", "test@example.com")
	cmdEmail.Dir = dir
	_ = cmdEmail.Run()

	return dir
}

func TestSpawnDiff(t *testing.T) {
	dir := initialiseGitRepo(t)
	manager := pty.NewManager()

	inst, err := SpawnDiff(dir, "", manager)
	if err != nil {
		t.Fatalf("SpawnDiff failed: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	if inst.Coder != "diff" {
		t.Errorf("Expected coder to be 'diff', got %q", inst.Coder)
	}
	if inst.Cwd != dir {
		t.Errorf("Expected cwd to be %q, got %q", dir, inst.Cwd)
	}

	// Check if it is tracked in the manager.
	_, found := manager.Get(inst.ID)
	if !found {
		t.Error("Spawned instance was not registered in manager")
	}
}

func TestSpawnLog(t *testing.T) {
	dir := initialiseGitRepo(t)
	manager := pty.NewManager()

	inst, err := SpawnLog(dir, manager)
	if err != nil {
		t.Fatalf("SpawnLog failed: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	if inst.Coder != "git-log" {
		t.Errorf("Expected coder to be 'git-log', got %q", inst.Coder)
	}

	_, found := manager.Get(inst.ID)
	if !found {
		t.Error("Spawned instance was not registered in manager")
	}
}

func TestSpawnStatus(t *testing.T) {
	dir := initialiseGitRepo(t)
	manager := pty.NewManager()

	inst, err := SpawnStatus(dir, manager)
	if err != nil {
		t.Fatalf("SpawnStatus failed: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	if inst.Coder != "git-status" {
		t.Errorf("Expected coder to be 'git-status', got %q", inst.Coder)
	}

	_, found := manager.Get(inst.ID)
	if !found {
		t.Error("Spawned instance was not registered in manager")
	}
}

func TestSpawnDiff_WithCommit(t *testing.T) {
	dir := initialiseGitRepo(t)

	// Create a mock commit to fetch
	cmdAddFile := exec.Command("git", "commit", "--allow-empty", "-m", "Initial mock commit")
	cmdAddFile.Dir = dir
	if err := cmdAddFile.Run(); err != nil {
		t.Fatalf("Failed to create mock commit: %v", err)
	}

	// Resolve the commit hash
	cmdHash := exec.Command("git", "rev-parse", "HEAD")
	cmdHash.Dir = dir
	out, err := cmdHash.Output()
	if err != nil {
		t.Fatalf("Failed to resolve HEAD: %v", err)
	}
	hash := strings.TrimSpace(string(out))

	manager := pty.NewManager()

	inst, err := SpawnDiff(dir, hash, manager)
	if err != nil {
		t.Fatalf("SpawnDiff with commit failed: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	if inst.Coder != "diff" {
		t.Errorf("Expected coder to be 'diff', got %q", inst.Coder)
	}
	if inst.Cwd != dir {
		t.Errorf("Expected cwd to be %q, got %q", dir, inst.Cwd)
	}
}
