package pibridge

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ErrEndpointUnavailable reports that no permitted endpoint root could host
// the local listener, or the chosen location was not exclusively creatable.
// Integration features stay unavailable; never fall back to TCP.
var ErrEndpointUnavailable = errors.New("pibridge: local IPC endpoint unavailable")

// maxSocketPathBytes bounds the complete absolute Unix socket path.
const maxSocketPathBytes = 100

// socketBasename is the socket file created inside the owned directory.
const socketBasename = "bridge.sock"

// Endpoint is a server-owned local IPC endpoint. Target is the gRPC dial
// target passed to the extension. Cleanup removes only files this endpoint
// created, is idempotent, and is a no-op for pipe endpoints.
type Endpoint struct {
	// Target is the client dial target: "unix:" followed by an absolute
	// filesystem socket path, or by the literal local pipe name.
	Target string

	unixDir    string   // owned private directory (unix only)
	unixSocket string   // owned socket file inside unixDir (unix only)
	ownedDir   string   // lazily created private dir (windows only)
	ownedFiles []string // owned files removed by Cleanup, in order
}

// Cleanup removes owned files, the owned socket, and owned private
// directories. It never touches any other path and is safe to call twice.
func (e *Endpoint) Cleanup() {
	for _, f := range e.ownedFiles {
		_ = os.Remove(f)
	}
	e.ownedFiles = nil
	if e.unixSocket != "" {
		_ = os.Remove(e.unixSocket)
	}
	if e.unixDir != "" {
		_ = os.Remove(e.unixDir) // fails unless empty: intended
	}
	if e.ownedDir != "" {
		_ = os.Remove(e.ownedDir) // fails unless empty: intended
	}
}

// WriteOwnedFile writes data with mode 0600 to name inside the owned
// private directory and returns the absolute path. The file is removed
// by Cleanup. On unix the endpoint directory hosts it; on Windows a
// private directory is created on first use. Name must be a bare file
// name; separators and dot segments are rejected.
func (e *Endpoint) WriteOwnedFile(name string, data []byte) (string, error) {
	if name == "" || name != filepath.Base(name) || name == "." || name == ".." {
		return "", fmt.Errorf("pibridge: owned file name %q rejected", name)
	}
	dir := e.unixDir
	if dir == "" {
		if e.ownedDir == "" {
			owned, err := os.MkdirTemp("", "phi-pi-*")
			if err != nil {
				return "", fmt.Errorf("pibridge: owned dir: %w", err)
			}
			if err := os.Chmod(owned, 0o700); err != nil {
				_ = os.Remove(owned)
				return "", fmt.Errorf("pibridge: owned dir mode: %w", err)
			}
			e.ownedDir = owned
		}
		dir = e.ownedDir
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", fmt.Errorf("pibridge: owned file: %w", err)
	}
	e.ownedFiles = append(e.ownedFiles, path)
	return path, nil
}
