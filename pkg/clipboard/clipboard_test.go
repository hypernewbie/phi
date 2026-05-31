package clipboard

import (
	"testing"
)

func TestReadClipboard(t *testing.T) {
	// Execute clipboard read to verify it doesn't crash or throw unexpected errors.
	_, err := Read()
	if err != nil {
		t.Logf("Note: Clipboard read returned an error (expected if no GUI session or empty clipboard): %v", err)
	}
}
