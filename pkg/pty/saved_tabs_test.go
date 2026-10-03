package pty

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSavedTabIntentSurvivesDrainWithoutLeakingLaunchArgs(t *testing.T) {
	testTabsPath = filepath.Join(t.TempDir(), "tabs.json")
	t.Cleanup(func() { testTabsPath = "" })
	m := NewManager()
	shell, args := getTestShell()
	inst, err := m.SpawnWithOptions(context.Background(), "", shell, args, "bash", "native", SpawnOptions{ID: "stable-pane", Title: "My title", Workspace: "project", Pinned: true, Marked: true, ExtraArgs: []string{"private-option"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Kill(inst.ID) })
	if inst.Snapshot().Title != "My title" {
		t.Fatal("metadata was not initialized before publication")
	}
	public, err := json.Marshal(inst.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(public), "private-option") {
		t.Fatal("private launch arguments leaked")
	}
	m.BeginDrain()
	_ = m.Kill(inst.ID)
	if err := m.FlushSaveState(); err != nil {
		t.Fatal(err)
	}
	tabs, err := ReadSavedTabs()
	if err != nil || len(tabs) != 1 || tabs[0].ID != "stable-pane" || !tabs[0].Pinned || !tabs[0].Marked || tabs[0].Workspace != "project" || len(tabs[0].ExtraArgs) != 1 {
		t.Fatalf("lost durable intent: %+v %v", tabs, err)
	}
}

func TestExplicitlyClosedTabsAndEphemeralGitPanesAreNotRestored(t *testing.T) {
	testTabsPath = filepath.Join(t.TempDir(), "tabs.json")
	t.Cleanup(func() { testTabsPath = "" })
	m := NewManager()
	shell, args := getTestShell()
	closed, err := m.Spawn(context.Background(), "", shell, args, "bash", "")
	if err != nil {
		t.Fatal(err)
	}
	git, err := m.Spawn(context.Background(), "", shell, args, "diff", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Kill(git.ID) })
	_ = m.Kill(closed.ID)
	if err := m.FlushSaveState(); err != nil {
		t.Fatal(err)
	}
	tabs, err := ReadSavedTabs()
	if err != nil || len(tabs) != 0 {
		t.Fatalf("closed/ephemeral panes persisted: %+v %v", tabs, err)
	}
}

func TestReadSavedTabsDoesNotPublishGhostsAndRejectsCorruption(t *testing.T) {
	testTabsPath = filepath.Join(t.TempDir(), "tabs.json")
	t.Cleanup(func() { testTabsPath = "" })
	if err := os.WriteFile(testTabsPath, []byte(`[{"id":"one","coder":"codex","session_id":"native-id"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	tabs, err := ReadSavedTabs()
	if err != nil || len(tabs) != 1 {
		t.Fatal(tabs, err)
	}
	if len(NewManager().ListActive()) != 0 {
		t.Fatal("reading intent published a phantom PTY")
	}
	_ = os.WriteFile(testTabsPath, []byte("broken"), 0600)
	if _, err := ReadSavedTabs(); err == nil {
		t.Fatal("corrupt state accepted")
	}
}
