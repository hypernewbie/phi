//go:build !windows

package pibridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewEndpointLayoutAndCleanup(t *testing.T) {
	ep, err := NewEndpoint()
	if err != nil {
		t.Fatalf("NewEndpoint: %v", err)
	}
	if !strings.HasPrefix(ep.Target, "unix:/") {
		t.Fatalf("target %q not absolute unix", ep.Target)
	}
	if len(strings.TrimPrefix(ep.Target, "unix:")) > maxSocketPathBytes {
		t.Fatalf("target exceeds %d bytes", maxSocketPathBytes)
	}
	dirInfo, err := os.Stat(ep.unixDir)
	if err != nil {
		t.Fatalf("dir stat: %v", err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %o, want 0700", dirInfo.Mode().Perm())
	}
	lis, err := ep.Listen()
	if err != nil {
		ep.Cleanup()
		t.Fatalf("Listen: %v", err)
	}
	sockInfo, err := os.Stat(ep.unixSocket)
	if err != nil {
		lis.Close()
		ep.Cleanup()
		t.Fatalf("socket stat: %v", err)
	}
	if sockInfo.Mode().Perm() != 0o600 {
		lis.Close()
		ep.Cleanup()
		t.Fatalf("socket mode %o, want 0600", sockInfo.Mode().Perm())
	}
	if err := verifyOwnedDir(ep.unixDir); err != nil {
		lis.Close()
		ep.Cleanup()
		t.Fatalf("owned dir rejected: %v", err)
	}
	lis.Close()
	socket := ep.unixSocket
	dir := ep.unixDir
	ep.Cleanup()
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Fatalf("socket not removed: %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dir not removed: %v", err)
	}
	// Idempotent.
	ep.Cleanup()
}

func TestEndpointsDiffer(t *testing.T) {
	a, err := NewEndpoint()
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	defer a.Cleanup()
	b, err := NewEndpoint()
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	defer b.Cleanup()
	if a.Target == b.Target {
		t.Fatal("simultaneous endpoints collided")
	}
}

func TestEndpointSpacesAndMultibyteRoot(t *testing.T) {
	// The controlled OS temporary root keeps this socket contained. A
	// long system TMPDIR (macOS /var/folders) cannot host the
	// 100-byte bound, so skip there instead of failing: rerun with a
	// short TMPDIR (TMPDIR=/tmp/xxx go test ./internal/pibridge/) for
	// coverage.
	base, err := os.MkdirTemp("", "phi-pi-")
	if err != nil {
		t.Fatalf("base: %v", err)
	}
	defer os.RemoveAll(base)
	root := filepath.Join(base, "phi pi ☆")
	candidate := filepath.Join(root, "phi-pi-"+strings.Repeat("f", 16), socketBasename)
	if len(candidate) > maxSocketPathBytes || !publishableTarget(candidate) {
		t.Skipf("controlled TMPDIR cannot host %d-byte socket %q", len(candidate), candidate)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("root: %v", err)
	}
	ep, err := NewEndpointWithRoots([]string{root})
	if err != nil {
		t.Fatalf("NewEndpointWithRoots: %v", err)
	}
	defer ep.Cleanup()
	if !strings.Contains(ep.Target, "phi pi ☆") {
		t.Fatalf("spaces/multibyte mangled: %q", ep.Target)
	}
	lis, err := ep.Listen()
	if err != nil {
		t.Fatalf("Listen with spaces: %v", err)
	}
	lis.Close()
}

func TestEndpointLongRootFallsBack(t *testing.T) {
	// Overlong first root must be skipped, not truncated or used.
	longRoot := filepath.Join(os.TempDir(), strings.Repeat("l", 120))
	ep, err := NewEndpointWithRoots([]string{longRoot, os.TempDir()})
	if err != nil {
		t.Fatalf("fallback failed: %v", err)
	}
	defer ep.Cleanup()
	if strings.Contains(ep.Target, strings.Repeat("l", 120)) {
		t.Fatalf("overlong root used: %q", ep.Target)
	}
}

func TestEndpointSkipsRootTheClientWouldReject(t *testing.T) {
	// The client accepts a literal absolute path only. A root that
	// forces a rejected shape must make the endpoint unavailable
	// rather than publish a target the client refuses to dial.
	for _, bad := range []string{"percent%20dir", "user@host"} {
		root := filepath.Join(t.TempDir(), bad)
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatalf("seed root %q: %v", root, err)
		}
		ep, err := NewEndpointWithRoots([]string{root})
		if err != ErrEndpointUnavailable {
			ep.Cleanup()
			t.Fatalf("root %q: err=%v, want ErrEndpointUnavailable", root, err)
		}
	}
	// A relative root yields a relative socket path, which the client
	// refuses to dial. The shape is checked before anything is created,
	// so this leaves nothing behind.
	ep, err := NewEndpointWithRoots([]string{"relative/root"})
	if err != ErrEndpointUnavailable {
		if ep != nil {
			ep.Cleanup()
		}
		t.Fatalf("relative root: err=%v, want ErrEndpointUnavailable", err)
	}
}

func TestEndpointNoRootFits(t *testing.T) {
	longRoot := filepath.Join(os.TempDir(), strings.Repeat("l", 120))
	if _, err := NewEndpointWithRoots([]string{longRoot}); err != ErrEndpointUnavailable {
		t.Fatalf("err=%v, want ErrEndpointUnavailable", err)
	}
	if _, err := NewEndpointWithRoots(nil); err != ErrEndpointUnavailable {
		t.Fatalf("empty roots err=%v, want unavailable", err)
	}
}

func TestEndpointCollisionDoesNotUnlink(t *testing.T) {
	old := randomSuffix
	randomSuffix = func() (string, error) { return "fixedsuffix", nil }
	defer func() { randomSuffix = old }()

	root := t.TempDir()
	colliding := filepath.Join(root, "phi-pi-fixedsuffix")
	if err := os.Mkdir(colliding, 0o700); err != nil {
		t.Fatalf("seed colliding dir: %v", err)
	}
	sentinel := filepath.Join(colliding, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0o600); err != nil {
		t.Fatalf("sentinel: %v", err)
	}
	// Only the colliding root is offered, so creation must fail without
	// touching the preexisting directory.
	if _, err := NewEndpointWithRoots([]string{root}); err != ErrEndpointUnavailable {
		t.Fatalf("err=%v, want unavailable on collision", err)
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("preexisting path disturbed: %v", err)
	}
}

func TestListenNeverUnlinksExistingSocket(t *testing.T) {
	ep, err := NewEndpoint()
	if err != nil {
		t.Fatalf("NewEndpoint: %v", err)
	}
	defer ep.Cleanup()
	// Occupy the socket path with a regular file before Listen.
	if err := os.WriteFile(ep.unixSocket, []byte("preexisting"), 0o600); err != nil {
		t.Fatalf("seed socket path: %v", err)
	}
	if _, err := ep.Listen(); err == nil {
		t.Fatal("Listen succeeded over preexisting file")
	}
	content, err := os.ReadFile(ep.unixSocket)
	if err != nil || string(content) != "preexisting" {
		t.Fatalf("preexisting file disturbed: %q %v", content, err)
	}
	// Cleanup removes only the owned paths it created; here the socket
	// path was preexisting content inside the owned dir. Remove the file
	// first to leave a clean assertion, then verify the dir is gone.
	_ = os.Remove(ep.unixSocket)
	ep.Cleanup()
	if _, err := os.Stat(ep.unixDir); !os.IsNotExist(err) {
		t.Fatalf("owned dir not cleaned: %v", err)
	}
}

func TestVerifyOwnedDirRejectsOpenMode(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if err := verifyOwnedDir(dir); err == nil {
		t.Fatal("open directory accepted")
	}
}

func TestEndpointIndependentOfCwd(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	ep, err := NewEndpoint()
	if err != nil {
		t.Fatalf("NewEndpoint: %v", err)
	}
	defer ep.Cleanup()
	other := t.TempDir()
	if err := os.Chdir(other); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(cwd)
	if !filepath.IsAbs(strings.TrimPrefix(ep.Target, "unix:")) {
		t.Fatalf("target not absolute after chdir: %q", ep.Target)
	}
	lis, err := ep.Listen()
	if err != nil {
		t.Fatalf("Listen after chdir: %v", err)
	}
	lis.Close()
}
