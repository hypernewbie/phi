package clipboard

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadClipboard(t *testing.T) {
	// Execute clipboard read to verify it doesn't crash or throw unexpected errors.
	_, err := Read()
	if err != nil {
		t.Logf("Note: Clipboard read returned an error (expected if no GUI session or empty clipboard): %v", err)
	}
}

func TestShimmedClipboard(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "phi-test-shims-")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	clipFile := filepath.Join(tempDir, "clipboard.txt")
	expectedText := "hello from shimmed clipboard!"

	// Write data to the file
	if err := os.WriteFile(clipFile, []byte(expectedText), 0600); err != nil {
		t.Fatalf("Failed to write clipboard file: %v", err)
	}

	// Set the package-level shim path
	SetLastClipboardFile(clipFile)
	defer SetLastClipboardFile("")

	// Read should return the shimmed file contents instead of executing native tool
	text, err := Read()
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}

	if text != expectedText {
		t.Errorf("Expected %q, got %q", expectedText, text)
	}
}
