//go:build !unix

package phic

import "testing"

// TestTTYWindowsNotSupported is the Windows-side equivalent of
// the unix tty_test suite. The plan targets macOS and Linux
// first; the Windows client requires a separate console
// implementation. This stub keeps `go test ./...` green on
// Windows CI without exposing unix-specific code paths.
func TestTTYWindowsNotSupported(t *testing.T) {
	if _, err := OpenTTY(); err == nil {
		t.Fatalf("OpenTTY on Windows must fail in the first version")
	}
}
