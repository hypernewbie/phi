package system

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// TestWriteFileAtomicPreserveExistingPropagatesEachFailure pins that every
// fallible step of the strict replacement is reported and that a failure before
// the rename leaves the destination byte-identical.
func TestWriteFileAtomicPreserveExistingPropagatesEachFailure(t *testing.T) {
	newTarget := func(t *testing.T) (dir, target string, original []byte) {
		t.Helper()
		dir = t.TempDir()
		target = filepath.Join(dir, "state.json")
		original = []byte(`{"version":1}`)
		if err := os.WriteFile(target, original, 0600); err != nil {
			t.Fatalf("seed destination: %v", err)
		}
		return dir, target, original
	}
	assertUnchanged := func(t *testing.T, target string, want []byte) {
		t.Helper()
		got, err := os.ReadFile(target)
		if err != nil {
			t.Fatalf("destination unreadable: %v", err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("destination = %q want %q", got, want)
		}
	}

	t.Run("chmod", func(t *testing.T) {
		dir, target, original := newTarget(t)
		previous := atomicChmod
		atomicChmod = func(string, os.FileMode) error { return errors.New("injected chmod failure") }
		t.Cleanup(func() { atomicChmod = previous })
		if err := WriteFileAtomicPreserveExisting(target, []byte("new"), 0600); err == nil {
			t.Fatal("chmod failure was not propagated")
		}
		assertUnchanged(t, target, original)
		assertNoTempFiles(t, dir)
	})

	t.Run("rename", func(t *testing.T) {
		dir, target, original := newTarget(t)
		previous := atomicRename
		atomicRename = func(string, string) error { return errors.New("injected rename failure") }
		t.Cleanup(func() { atomicRename = previous })
		if err := WriteFileAtomicPreserveExisting(target, []byte("new"), 0600); err == nil {
			t.Fatal("rename failure was not propagated")
		}
		assertUnchanged(t, target, original)
		assertNoTempFiles(t, dir)
	})

	t.Run("directory sync after the rename", func(t *testing.T) {
		dir, target, _ := newTarget(t)
		previous := atomicSyncDir
		atomicSyncDir = func(string) error { return errors.New("injected directory sync failure") }
		t.Cleanup(func() { atomicSyncDir = previous })
		replacement := []byte("replacement")
		err := WriteFileAtomicPreserveExisting(target, replacement, 0600)
		if err == nil {
			t.Fatal("directory sync failure was not reported")
		}
		// The rename already happened, so this is an ambiguous committed write:
		// the new bytes are on disk and must not be described as a rollback.
		got, readErr := os.ReadFile(target)
		if readErr != nil {
			t.Fatalf("destination unreadable after an ambiguous write: %v", readErr)
		}
		if !bytes.Equal(got, replacement) {
			t.Errorf("destination = %q want the committed replacement %q", got, replacement)
		}
		assertNoTempFiles(t, dir)
	})

	t.Run("temp file creation", func(t *testing.T) {
		dir, target, original := newTarget(t)
		// A read-only directory fails CreateTemp for real on every platform this
		// project supports, without a seam.
		if err := os.Chmod(dir, 0o500); err != nil {
			t.Skipf("cannot make the directory read-only: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
		if err := WriteFileAtomicPreserveExisting(target, []byte("new"), 0600); err == nil {
			t.Fatal("creation failure was not propagated")
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			t.Fatalf("restore directory mode: %v", err)
		}
		assertUnchanged(t, target, original)
	})
}

// assertNoTempFiles fails when a failed replacement left its temp file behind.
func assertNoTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "atomic-") {
			t.Errorf("leftover temp file %q", entry.Name())
		}
	}
}

// TestWriteFileAtomicKeepsItsUnchangedBehavior pins that the legacy writer did
// not inherit the strict path's seams or its directory sync: its callers rely
// on the historical behavior.
func TestWriteFileAtomicKeepsItsUnchangedBehavior(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "legacy.txt")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}

	previousRename := atomicRename
	previousSync := atomicSyncDir
	atomicRename = func(string, string) error { return errors.New("strict seam must not run") }
	atomicSyncDir = func(string) error { return errors.New("strict seam must not run") }
	t.Cleanup(func() {
		atomicRename = previousRename
		atomicSyncDir = previousSync
	})

	if err := WriteFileAtomic(target, []byte("legacy replacement"), 0644); err != nil {
		t.Fatalf("legacy writer failed: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "legacy replacement" {
		t.Errorf("legacy content = %q", got)
	}
	assertNoTempFiles(t, dir)
}
