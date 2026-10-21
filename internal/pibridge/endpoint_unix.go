//go:build !windows

package pibridge

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// randomSuffix is a seam for collision tests; production uses crypto/rand.
var randomSuffix = func() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("pibridge: rand: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}

// defaultEndpointRoots prefers the OS temporary root and falls back to the
// OS-managed /tmp when the first candidate cannot host a bounded path.
func defaultEndpointRoots() []string {
	roots := []string{os.TempDir()}
	if filepath.Clean(os.TempDir()) != "/tmp" {
		roots = append(roots, "/tmp")
	}
	return roots
}

// NewEndpoint creates the endpoint layout in the first root whose candidate
// socket path fits the byte bound. It creates the private directory
// exclusively; an existing path makes that root unavailable, never an
// unlink. When no permitted root fits, it returns ErrEndpointUnavailable.
func NewEndpoint() (*Endpoint, error) {
	return NewEndpointWithRoots(defaultEndpointRoots())
}

// NewEndpointWithRoots is NewEndpoint with explicit candidate roots, in
// order. Tests use it for path-bound, multibyte, and overlong-root cases.
func NewEndpointWithRoots(roots []string) (*Endpoint, error) {
	for _, root := range roots {
		if root == "" {
			continue
		}
		suffix, err := randomSuffix()
		if err != nil {
			return nil, err
		}
		dir := filepath.Join(filepath.Clean(root), "phi-pi-"+suffix)
		socket := filepath.Join(dir, socketBasename)
		if len(socket) > maxSocketPathBytes {
			continue
		}
		if !publishableTarget(socket) {
			// The client accepts a literal absolute path only. A root
			// that forces a rejected shape makes the endpoint
			// unavailable, never a target the client refuses.
			continue
		}
		if err := os.Mkdir(dir, 0o700); err != nil {
			// Collision or unwritable root: unavailable, never unlink.
			continue
		}
		ep := &Endpoint{Target: "unix:" + socket, unixDir: dir, unixSocket: socket}
		if err := verifyOwnedDir(dir); err != nil {
			_ = os.Remove(dir)
			continue
		}
		return ep, nil
	}
	return nil, ErrEndpointUnavailable
}

// publishableTarget reports whether the socket path can be published as a
// client target. The client accepts a literal absolute path only: no
// percent encoding, no credentials, no authority.
func publishableTarget(socket string) bool {
	return !strings.Contains(socket, "%") &&
		!strings.Contains(socket, "@") &&
		!strings.Contains(socket, "://") &&
		!strings.HasPrefix(socket, "//")
}

// Listen opens the filesystem Unix-domain socket with mode 0600. It never
// unlinks a preexisting path; net.Listen fails instead.
func (e *Endpoint) Listen() (net.Listener, error) {
	if e.unixSocket == "" || !filepath.IsAbs(e.unixSocket) {
		return nil, fmt.Errorf("pibridge: endpoint has no absolute socket path")
	}
	listener, err := net.Listen("unix", e.unixSocket)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(e.unixSocket, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	info, err := os.Stat(e.unixSocket)
	if err != nil || info.Mode().Perm() != 0o600 {
		_ = listener.Close()
		if err == nil {
			err = fmt.Errorf("pibridge: socket mode %o, want 0600", info.Mode().Perm())
		}
		return nil, err
	}
	return listener, nil
}

// verifyOwnedDir checks exclusive ownership and permissions before
// listening, rejecting directories owned by another user or too open.
func verifyOwnedDir(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("pibridge: endpoint parent is not a directory")
	}
	if info.Mode().Perm() != 0o700 {
		return fmt.Errorf("pibridge: endpoint directory mode %o, want 0700", info.Mode().Perm())
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("pibridge: endpoint directory not owned by current user")
	}
	return nil
}
