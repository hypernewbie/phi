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
