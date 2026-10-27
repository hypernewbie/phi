package system

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteFileAtomic(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "atomic-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	targetFile := filepath.Join(tmpDir, "test.txt")
	content := []byte("hello atomic")

	// Write new file
	if err := WriteFileAtomic(targetFile, content, 0644); err != nil {
		t.Fatalf("WriteFileAtomic failed: %v", err)
	}

	data, err := os.ReadFile(targetFile)
	if err != nil {
		t.Fatalf("failed to read written file: %v", err)
	}
	if !bytes.Equal(data, content) {
		t.Errorf("expected %q, got %q", content, data)
	}

	// Overwrite existing file
	newContent := []byte("new contents")
	if err := WriteFileAtomic(targetFile, newContent, 0644); err != nil {
		t.Fatalf("WriteFileAtomic overwrite failed: %v", err)
	}

	data, err = os.ReadFile(targetFile)
	if err != nil {
		t.Fatalf("failed to read overwritten file: %v", err)
	}
	if !bytes.Equal(data, newContent) {
		t.Errorf("expected %q, got %q", newContent, data)
	}
}

// The preserve-existing variant is used for config writes: a failed
// replacement must leave the old file untouched, never delete it first.
func TestWriteFileAtomicPreserveExistingReplacesContent(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "config.json")
	if err := os.WriteFile(target, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomicPreserveExisting(target, []byte("new"), 0644); err != nil {
		t.Fatalf("replace failed: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("content = %q want %q", data, "new")
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("perm = %v want 0644", info.Mode().Perm())
	}
}

func TestWriteFileAtomicPreserveExistingKeepsDestinationOnRenameFailure(t *testing.T) {
	dir := t.TempDir()
	// A non-empty directory at the destination makes rename fail on every
	// supported platform, which is the portable stand-in for a locked or
	// otherwise unrenameable file.
	target := filepath.Join(dir, "config.json")
	if err := os.MkdirAll(filepath.Join(target, "keep"), 0755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(target, "keep", "value")
	if err := os.WriteFile(keep, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := WriteFileAtomicPreserveExisting(target, []byte("replacement"), 0644); err == nil {
		t.Fatal("expected the rename to fail")
	}
	data, err := os.ReadFile(keep)
	if err != nil {
		t.Fatalf("destination was destroyed: %v", err)
	}
	if string(data) != "original" {
		t.Fatalf("destination content = %q", data)
	}
	// The temp file must not be left behind.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "config.json" {
		t.Fatalf("leftover entries: %v", entries)
	}
}
