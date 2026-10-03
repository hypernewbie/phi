package pty

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMalformedSavedTabDoesNotDiscardValidNeighbors(t *testing.T) {
	testTabsPath = filepath.Join(t.TempDir(), "tabs.json")
	t.Cleanup(func() { testTabsPath = "" })
	if err := os.WriteFile(testTabsPath, []byte(`[{"id":"good-one","coder":"bash"},{"id":"bad","pinned":"not-a-bool"},{"id":"good-two","coder":"codex"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	tabs, err := ReadSavedTabs()
	if err != nil || len(tabs) != 2 || tabs[0].ID != "good-one" || tabs[1].ID != "good-two" {
		t.Fatalf("valid tabs were lost: %+v %v", tabs, err)
	}
}
