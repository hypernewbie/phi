package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// assetBuilder builds a real tar.gz or zip archive containing a single
// "phi" or "phi.exe" entry with the given contents. Returns the archive
// bytes + the expected sha256 hash for the entry's binary content.
type assetBuilder struct {
	t          *testing.T
	binaryName string
	binaryBody []byte
}

func (b *assetBuilder) archive() []byte {
	b.t.Helper()
	if strings.HasSuffix(b.binaryName, ".exe") || runtime.GOOS == "windows" {
		return b.zipBytes()
	}
	return b.tarGzBytes()
}

func (b *assetBuilder) zipBytes() []byte {
	b.t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	f, err := w.Create(b.binaryName)
	if err != nil {
		b.t.Fatalf("zip create: %v", err)
	}
	_, _ = f.Write(b.binaryBody)
	if err := w.Close(); err != nil {
		b.t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func (b *assetBuilder) tarGzBytes() []byte {
	b.t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{
		Name:     b.binaryName,
		Mode:     0755,
		Size:     int64(len(b.binaryBody)),
		Typeflag: tar.TypeReg,
		ModTime:  time.Now(),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		b.t.Fatalf("tar hdr: %v", err)
	}
	if _, err := tw.Write(b.binaryBody); err != nil {
		b.t.Fatalf("tar write: %v", err)
	}
	if err := tw.Close(); err != nil {
		b.t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		b.t.Fatalf("gz close: %v", err)
	}
	return buf.Bytes()
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestAssetFor(t *testing.T) {
	if got := AssetFor("0.8.2", "windows", "amd64"); got != "phi_0.8.2_windows_amd64.zip" {
		t.Errorf("unexpected windows asset: %s", got)
	}
	if got := AssetFor("0.8.2", "linux", "arm64"); got != "phi_0.8.2_linux_arm64.tar.gz" {
		t.Errorf("unexpected linux asset: %s", got)
	}
}

func TestApplier_Eligible(t *testing.T) {
	cases := map[string]bool{
		"npm":        true,
		"standalone": true,
		"go-install": false,
		"dev":        false,
		"unexpected": false,
	}
	for method, want := range cases {
		a := NewApplier("0.8.0", method)
		if got := a.Eligible(); got != want {
			t.Errorf("Eligible(%q) = %v, want %v", method, got, want)
		}
	}
}

// fakeGitHub serves a single release: /download/v{ver}/<asset> and
// /download/v{ver}/checksums.txt with the provided binary content.
type fakeGitHub struct {
	asset       []byte
	checksums   string
	binaryName  string
	downloads   int
	checksumHit int
	mu          sync.Mutex
}

func (f *fakeGitHub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/checksums.txt"):
			f.checksumHit++
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte(f.checksums))
		case strings.HasSuffix(r.URL.Path, ".zip") || strings.HasSuffix(r.URL.Path, ".tar.gz"):
			f.downloads++
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(f.asset)
		default:
			http.NotFound(w, r)
		}
	})
}

func TestApplier_Apply_HappyPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("swap dance on Windows requires file-handle release; covered by manual / CI Windows leg")
	}

	binaryName := "phi"
	body := []byte("#!/bin/sh\necho hello new phi\n")
	b := &assetBuilder{t: t, binaryName: binaryName, binaryBody: body}
	archiveBytes := b.archive()
	// Apply verifies the SHA256 of the archive file the server
	// serves, NOT the inner binary. Goreleaser publishes checksums
	// of the archive, so hash the bytes the fake server returns.
	hash := sha256Hex(archiveBytes)

	fg := &fakeGitHub{
		asset:      archiveBytes,
		binaryName: binaryName,
		checksums:  fmt.Sprintf("%s  phi_0.9.0_%s_%s.tar.gz\n", hash, runtime.GOOS, runtime.GOARCH),
	}
	srv := httptest.NewServer(fg.handler())
	defer srv.Close()

	// Stage a fake "running binary" in a temp dir.
	tmpDir := t.TempDir()
	oldExe := filepath.Join(tmpDir, binaryName)
	if err := os.WriteFile(oldExe, []byte("#!/bin/sh\necho old phi\n"), 0755); err != nil {
		t.Fatalf("write old exe: %v", err)
	}

	// Build an Applier that points at our fake exe path. We need to
	// hack os.Executable for the duration of the call. Use an applier
	// subclass via package-level swap in apply.go.
	a := NewApplier("0.8.0", "standalone")
	// Override the assetURL builder by injecting a URL override.
	// Simpler: use a proxy that rewrites release URLs to point at srv.
	a.httpClient = &http.Client{
		Timeout:   5 * time.Second,
		Transport: rewritingTransport{from: "github.com/hypernewbie", to: strings.TrimPrefix(srv.URL, "http://")},
	}

	// We can't easily rewire os.Executable in tests, but we CAN swap
	// the swap target via a hook. Add one.
	origHook := swapTargetHook
	swapTargetHook = func() (string, error) { return oldExe, nil }
	defer func() { swapTargetHook = origHook }()

	res := a.Apply("0.9.0")
	if res.Err != nil {
		t.Fatalf("Apply: %v (progress: %+v)", res.Err, res.Progress)
	}
	if res.Progress.Phase != PhaseDone {
		t.Errorf("expected PhaseDone, got %s", res.Progress.Phase)
	}

	// Verify new exe is the new content.
	newBytes, err := os.ReadFile(oldExe)
	if err != nil {
		t.Fatalf("read new exe: %v", err)
	}
	if string(newBytes) != string(body) {
		t.Errorf("expected new binary content, got %q", string(newBytes))
	}

	// Verify .old is the old content.
	oldPath := oldExe + ".old"
	oldBytes, err := os.ReadFile(oldPath)
	if err != nil {
		t.Fatalf("read .old: %v", err)
	}
	if !strings.Contains(string(oldBytes), "old phi") {
		t.Errorf("expected old binary in .old, got %q", string(oldBytes))
	}

	// Cleanup leftover .old to not pollute test runs.
	_ = os.Remove(oldPath)
}

// TestApplier_Apply_HappyPath_VPrefixedTarget: v-prefixed target ("v0.9.0") must succeed end-to-end.
func TestApplier_Apply_HappyPath_VPrefixedTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("swap dance on Windows requires file-handle release; covered by manual / CI Windows leg")
	}

	binaryName := "phi"
	body := []byte("#!/bin/sh\necho hello new phi\n")
	b := &assetBuilder{t: t, binaryName: binaryName, binaryBody: body}
	archiveBytes := b.archive()
	// Apply verifies the SHA256 of the archive file the server
	// serves, NOT the inner binary. Goreleaser publishes checksums
	// of the archive, so hash the bytes the fake server returns.
	hash := sha256Hex(archiveBytes)

	fg := &fakeGitHub{
		asset:      archiveBytes,
		binaryName: binaryName,
		checksums:  fmt.Sprintf("%s  phi_0.9.0_%s_%s.tar.gz\n", hash, runtime.GOOS, runtime.GOARCH),
	}
	srv := httptest.NewServer(fg.handler())
	defer srv.Close()

	tmpDir := t.TempDir()
	oldExe := filepath.Join(tmpDir, binaryName)
	if err := os.WriteFile(oldExe, []byte("#!/bin/sh\necho old phi\n"), 0755); err != nil {
		t.Fatalf("write old exe: %v", err)
	}

	a := NewApplier("0.8.0", "standalone")
	a.httpClient = &http.Client{
		Timeout:   5 * time.Second,
		Transport: rewritingTransport{from: "github.com/hypernewbie", to: strings.TrimPrefix(srv.URL, "http://")},
	}

	origHook := swapTargetHook
	swapTargetHook = func() (string, error) { return oldExe, nil }
	defer func() { swapTargetHook = origHook }()

	res := a.Apply("v0.9.0")
	if res.Err != nil {
		t.Fatalf("Apply(v-prefixed): %v (progress: %+v)", res.Err, res.Progress)
	}
	if res.Progress.Phase != PhaseDone {
		t.Errorf("expected PhaseDone, got %s", res.Progress.Phase)
	}
	if res.Progress.Version != "0.9.0" {
		t.Errorf("expected normalized Progress.Version=0.9.0, got %q", res.Progress.Version)
	}

	oldPath := oldExe + ".old"
	_ = os.Remove(oldPath)
}

func TestApplier_Apply_RefusesSameVersion(t *testing.T) {
	a := NewApplier("0.8.0", "standalone")
	res := a.Apply("0.8.0")
	if res.Err == nil {
		t.Error("expected error when targetVersion == currentVersion")
	}
	if res.Progress.Phase != PhaseError {
		t.Errorf("expected PhaseError, got %s", res.Progress.Phase)
	}
}

// TestApplier_Apply_RefusesSameVersion_VPrefix: v-prefixed reapply ("v0.8.0" vs current "0.8.0") must still be caught.
func TestApplier_Apply_RefusesSameVersion_VPrefix(t *testing.T) {
	a := NewApplier("0.8.0", "standalone")
	res := a.Apply("v0.8.0")
	if res.Err == nil {
		t.Error("expected error when v-prefixed targetVersion == currentVersion")
	}
	if res.Progress.Phase != PhaseError {
		t.Errorf("expected PhaseError, got %s", res.Progress.Phase)
	}
}

func TestNormalizeVersion(t *testing.T) {
	cases := map[string]string{
		"v0.8.2":     "0.8.2",
		"V0.8.2":     "0.8.2",
		"0.8.2":      "0.8.2",
		"  v0.8.2  ": "0.8.2",
		"":           "",
	}
	for in, want := range cases {
		if got := normalizeVersion(in); got != want {
			t.Errorf("normalizeVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestApplier_Apply_RefusesDowngrade(t *testing.T) {
	a := NewApplier("0.8.0", "standalone")
	res := a.Apply("0.7.0")
	if res.Err == nil {
		t.Error("expected error when targetVersion < currentVersion")
	}
}

func TestApplier_Apply_RefusesIneligibleMethod(t *testing.T) {
	for _, method := range []string{"go-install", "dev", ""} {
		a := NewApplier("0.8.0", method)
		res := a.Apply("0.9.0")
		if res.Err == nil {
			t.Errorf("expected error for method %q", method)
		}
		if !strings.Contains(res.Err.Error(), "does not support") {
			t.Errorf("expected unsupported error for method %q, got %v", method, res.Err)
		}
	}
}

func TestApplier_Apply_ChecksumMismatchFailsClosed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skip on Windows")
	}

	body := []byte("#!/bin/sh\necho good\n")
	b := &assetBuilder{t: t, binaryName: "phi", binaryBody: body}
	archiveBytes := b.archive()

	// Checksums file lists a WRONG hash.
	fg := &fakeGitHub{
		asset:     archiveBytes,
		checksums: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  phi_0.9.0_linux_amd64.tar.gz\n",
	}
	srv := httptest.NewServer(fg.handler())
	defer srv.Close()

	tmpDir := t.TempDir()
	exe := filepath.Join(tmpDir, "phi")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho original\n"), 0755); err != nil {
		t.Fatalf("write: %v", err)
	}

	a := NewApplier("0.8.0", "standalone")
	a.httpClient = &http.Client{
		Timeout:   5 * time.Second,
		Transport: rewritingTransport{from: "github.com/hypernewbie", to: strings.TrimPrefix(srv.URL, "http://")},
	}

	origHook := swapTargetHook
	swapTargetHook = func() (string, error) { return exe, nil }
	defer func() { swapTargetHook = origHook }()

	res := a.Apply("0.9.0")
	if res.Err == nil {
		t.Fatal("expected checksum mismatch error")
	}
	if !strings.Contains(res.Err.Error(), "checksum mismatch") {
		t.Errorf("expected checksum mismatch error, got %v", res.Err)
	}
	if res.Progress.Phase != PhaseError {
		t.Errorf("expected PhaseError, got %s", res.Progress.Phase)
	}

	// CRITICAL: original binary must be unchanged.
	currentBytes, _ := os.ReadFile(exe)
	if !strings.Contains(string(currentBytes), "echo original") {
		t.Error("original binary was modified despite checksum failure")
	}
}

func TestApplier_Apply_ConcurrentRejected(t *testing.T) {
	a := NewApplier("0.8.0", "standalone")
	a.inFlight.Store(true) // simulate in-flight apply
	res := a.Apply("0.9.0")
	if res.Err == nil {
		t.Error("expected concurrent apply to be rejected")
	}
	if !strings.Contains(res.Err.Error(), "concurrent apply rejected") && !strings.Contains(res.Err.Error(), "in flight") {
		t.Errorf("expected 'concurrent apply' or 'in flight' error, got %v", res.Err)
	}
}

func TestApplier_Progress_DefaultsToIdle(t *testing.T) {
	a := NewApplier("0.8.0", "standalone")
	if a.Progress().Phase != PhaseIdle {
		t.Errorf("expected PhaseIdle, got %s", a.Progress().Phase)
	}
}

func TestApplier_CleanupOldBinary(t *testing.T) {
	// Pure file removal - works on all platforms, including Windows.
	tmpDir := t.TempDir()
	exe := filepath.Join(tmpDir, "phi")
	if err := os.WriteFile(exe, []byte("new\n"), 0755); err != nil {
		t.Fatalf("write: %v", err)
	}
	old := exe + ".old"
	if err := os.WriteFile(old, []byte("old\n"), 0755); err != nil {
		t.Fatalf("write old: %v", err)
	}

	origHook := swapTargetHook
	swapTargetHook = func() (string, error) { return exe, nil }
	defer func() { swapTargetHook = origHook }()

	removed, err := CleanupOldBinary()
	if err != nil {
		t.Fatalf("CleanupOldBinary: %v", err)
	}
	if removed != old {
		t.Errorf("expected removed=%s, got %s", old, removed)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("expected .old to be gone, stat err: %v", err)
	}
}

func TestApplier_CleanupOldBinary_NoFile(t *testing.T) {
	tmpDir := t.TempDir()
	exe := filepath.Join(tmpDir, "phi")
	if err := os.WriteFile(exe, []byte("new\n"), 0755); err != nil {
		t.Fatalf("write: %v", err)
	}

	origHook := swapTargetHook
	swapTargetHook = func() (string, error) { return exe, nil }
	defer func() { swapTargetHook = origHook }()

	removed, err := CleanupOldBinary()
	if err != nil {
		t.Fatalf("CleanupOldBinary: %v", err)
	}
	if removed != "" {
		t.Errorf("expected empty removed path when no .old exists, got %s", removed)
	}
}

func TestRollback_Success(t *testing.T) {
	tmpDir := t.TempDir()
	exe := filepath.Join(tmpDir, "phi")
	if err := os.WriteFile(exe, []byte("bad-new\n"), 0755); err != nil {
		t.Fatalf("write exe: %v", err)
	}
	old := exe + ".old"
	if err := os.WriteFile(old, []byte("good-old\n"), 0755); err != nil {
		t.Fatalf("write old: %v", err)
	}

	origHook := swapTargetHook
	swapTargetHook = func() (string, error) { return exe, nil }
	defer func() { swapTargetHook = origHook }()

	restored, err := Rollback()
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if restored != exe {
		t.Errorf("expected restored=%s, got %s", exe, restored)
	}

	body, err := os.ReadFile(exe)
	if err != nil {
		t.Fatalf("read restored exe: %v", err)
	}
	if string(body) != "good-old\n" {
		t.Errorf("expected exe to contain the old binary's content, got %q", body)
	}

	rejected := exe + ".rejected"
	body, err = os.ReadFile(rejected)
	if err != nil {
		t.Fatalf("read rejected: %v", err)
	}
	if string(body) != "bad-new\n" {
		t.Errorf("expected .rejected to preserve the bad binary's content, got %q", body)
	}

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("expected .old to be gone after rollback, stat err: %v", err)
	}
}

func TestRollback_NoOldBinary(t *testing.T) {
	tmpDir := t.TempDir()
	exe := filepath.Join(tmpDir, "phi")
	if err := os.WriteFile(exe, []byte("current\n"), 0755); err != nil {
		t.Fatalf("write exe: %v", err)
	}

	origHook := swapTargetHook
	swapTargetHook = func() (string, error) { return exe, nil }
	defer func() { swapTargetHook = origHook }()

	if _, err := Rollback(); err == nil {
		t.Fatal("expected error when no .old binary exists, got nil")
	}

	// Original exe must be untouched.
	body, err := os.ReadFile(exe)
	if err != nil {
		t.Fatalf("read exe: %v", err)
	}
	if string(body) != "current\n" {
		t.Errorf("expected exe untouched after failed rollback, got %q", body)
	}
}

func TestScheduleOldBinaryCleanup_RespectsDelay(t *testing.T) {
	tmpDir := t.TempDir()
	exe := filepath.Join(tmpDir, "phi")
	if err := os.WriteFile(exe, []byte("new\n"), 0755); err != nil {
		t.Fatalf("write exe: %v", err)
	}
	old := exe + ".old"
	if err := os.WriteFile(old, []byte("old\n"), 0755); err != nil {
		t.Fatalf("write old: %v", err)
	}

	origHook := swapTargetHook
	swapTargetHook = func() (string, error) { return exe, nil }
	defer func() { swapTargetHook = origHook }()

	origDelay := CleanupOldBinaryDelay
	CleanupOldBinaryDelay = 20 * time.Millisecond
	defer func() { CleanupOldBinaryDelay = origDelay }()

	start := time.Now()
	removed, err := ScheduleOldBinaryCleanup()
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("ScheduleOldBinaryCleanup: %v", err)
	}
	if removed != old {
		t.Errorf("expected removed=%s, got %s", old, removed)
	}
	if elapsed < 20*time.Millisecond {
		t.Errorf("expected ScheduleOldBinaryCleanup to wait out the delay, only took %s", elapsed)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("expected .old to be gone, stat err: %v", err)
	}
}

func TestLookupChecksum(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "checksums.txt")
	content := `abc123  phi_0.8.0_linux_amd64.tar.gz
def456  phi_0.8.0_windows_amd64.zip
789xyz  ./phi_0.8.0_darwin_arm64.tar.gz
`
	if err := os.WriteFile(tmp, []byte(content), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	cases := []struct {
		asset string
		want  string
	}{
		{"phi_0.8.0_linux_amd64.tar.gz", "abc123"},
		{"phi_0.8.0_windows_amd64.zip", "def456"},
		{"phi_0.8.0_darwin_arm64.tar.gz", "789xyz"}, // leading ./ stripped
	}
	for _, c := range cases {
		got, err := lookupChecksum(tmp, c.asset)
		if err != nil {
			t.Errorf("lookupChecksum(%s): %v", c.asset, err)
		}
		if got != c.want {
			t.Errorf("lookupChecksum(%s) = %s, want %s", c.asset, got, c.want)
		}
	}

	// Missing asset
	_, err := lookupChecksum(tmp, "phi_99.99.99.tar.gz")
	if err == nil {
		t.Error("expected error for missing asset")
	}
}

// rewritingTransport rewrites all outbound request URLs that contain
// `from` to substitute `to`. Lets tests redirect github.com -> httptest.
//
// IMPORTANT: check the full URL string, not just req.URL.Host. The
// apply code uses URLs like
//
//	https://github.com/hypernewbie/phi/releases/download/v0.9.0/...
//
// where `hypernewbie/phi` lives in the path, not the host. A
// Host-only check silently leaks real downloads to github.com,
// which is why the test suite was hitting real release assets and
// getting poisoned by stale files in os.TempDir().
type rewritingTransport struct {
	from string
	to   string
}

func (t rewritingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.Contains(req.URL.String(), t.from) {
		rewritten := strings.Replace(req.URL.String(), "https://"+t.from, "http://"+t.to, 1)
		if rewritten == req.URL.String() {
			rewritten = strings.Replace(req.URL.String(), "http://"+t.from, "http://"+t.to, 1)
		}
		newReq, err := http.NewRequest(req.Method, rewritten, req.Body)
		if err != nil {
			return nil, err
		}
		for k, v := range req.Header {
			newReq.Header[k] = v
		}
		return http.DefaultTransport.RoundTrip(newReq)
	}
	return http.DefaultTransport.RoundTrip(req)
}
