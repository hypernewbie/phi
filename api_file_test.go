package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fileAssetRequest builds a /api/file/asset request with explicit
// cwd/path query params — never relies on activeCWD global, which is
// process-wide state and would race across parallel tests.
func fileAssetRequest(cwd, path string) *http.Request {
	q := url.Values{}
	q.Set("cwd", cwd)
	q.Set("path", path)
	return httptest.NewRequest(http.MethodGet, "/api/file/asset?"+q.Encode(), nil)
}

func fileAssetHeadRequest(cwd, path string) *http.Request {
	r := fileAssetRequest(cwd, path)
	r.Method = http.MethodHead
	return r
}

func TestHandleFileAsset_ServesFileBytes(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "a.txt"), "hello world")

	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetRequest(dir, "a.txt"))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != "hello world" {
		t.Errorf("body = %q want %q", got, "hello world")
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q want nosniff", got)
	}
}

func TestHandleFileAsset_RejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	mustWriteFile(t, filepath.Join(outside, "secret.txt"), "shh")

	cases := []struct {
		name string
		path string
	}{
		{"dotdot", ".."},
		{"rooted-slash", "/etc/passwd"},
		{"dotdot-prefix", "../secret.txt"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			handleFileAsset(w, fileAssetRequest(dir, c.path))
			if w.Code != http.StatusBadRequest {
				t.Errorf("got %d want 400; body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestHandleFileAsset_RejectsSymlinkEscape(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "secret.txt")
	mustWriteFile(t, outsideFile, "shh")
	// Create an in-tree symlink that points outside the workspace.
	linkPath := filepath.Join(dir, "leak.txt")
	if err := os.Symlink(outsideFile, linkPath); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetRequest(dir, "leak.txt"))
	// EvalSymlinks + HasPrefix check resolves the symlink and confirms
	// it's outside cwd, returning 403.
	if w.Code != http.StatusForbidden {
		t.Errorf("got %d want 403; body=%s", w.Code, w.Body.String())
	}
}

func TestHandleFileAsset_RejectsDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetRequest(dir, "sub"))
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d want 400; body=%s", w.Code, w.Body.String())
	}
}

func TestHandleFileAsset_NotFound(t *testing.T) {
	dir := t.TempDir()
	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetRequest(dir, "missing.txt"))
	if w.Code != http.StatusNotFound {
		t.Errorf("got %d want 404; body=%s", w.Code, w.Body.String())
	}
}

func TestHandleFileAsset_NeuteredHTML(t *testing.T) {
	// HTML is forced to text/plain + attachment so the browser never
	// renders it as active content, even if the agent plants a .html
	// file in the workspace and a user clicks it.
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "evil.html"),
		"<!DOCTYPE html><script>alert(1)</script>")

	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetRequest(dir, "evil.html"))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain prefix", ct)
	}
	disp := w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, "attachment;") {
		t.Errorf("Content-Disposition = %q, want attachment prefix", disp)
	}
	// The body should still be the raw HTML bytes (the dispatcher
	// fetches and renders as text), so the audit trail in the file
	// is preserved.
	body, _ := io.ReadAll(w.Body)
	if !strings.Contains(string(body), "<script>") {
		t.Errorf("body should contain raw HTML bytes, got %q", string(body))
	}
}

func TestHandleFileAsset_NeuteredJS(t *testing.T) {
	// Same defense for JS/CSS/XML/WASM/MHT — the browser must never
	// interpret them as active content.
	dir := t.TempDir()
	cases := []string{"a.js", "a.mjs", "a.css", "a.xml", "a.xsl", "a.wasm", "a.mht"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			mustWriteFile(t, filepath.Join(dir, name), "evil-content")
			w := httptest.NewRecorder()
			handleFileAsset(w, fileAssetRequest(dir, name))
			if w.Code != http.StatusOK {
				t.Fatalf("got %d want 200", w.Code)
			}
			if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
				t.Errorf("%s: Content-Type = %q want text/plain", name, ct)
			}
			if disp := w.Header().Get("Content-Disposition"); !strings.HasPrefix(disp, "attachment;") {
				t.Errorf("%s: Content-Disposition = %q want attachment", name, disp)
			}
		})
	}
}

func TestHandleFileAsset_SVGInline(t *testing.T) {
	// SVG is NOT active content here — image/svg+xml renders in <img>
	// with no script execution, and the dispatcher mounts it that way.
	// http.ServeFile returns image/svg+xml by extension; the test
	// confirms the handler does NOT force text/plain on SVG.
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "logo.svg"),
		`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)

	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetRequest(dir, "logo.svg"))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/svg+xml") {
		t.Errorf("Content-Type = %q want image/svg+xml", ct)
	}
	if disp := w.Header().Get("Content-Disposition"); disp != "" {
		t.Errorf("Content-Disposition = %q want empty (inline)", disp)
	}
}

func TestHandleFileAsset_RejectsAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetRequest(dir, "/etc/passwd"))
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d want 400", w.Code)
	}
}

func TestHandleFileAsset_RejectsBadCwd(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "a.txt"), "ok")
	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetRequest(filepath.Join(dir, "missing"), "a.txt"))
	if w.Code != http.StatusBadRequest {
		t.Errorf("got %d want 400", w.Code)
	}
}

func TestHandleFileAsset_HEADSupported(t *testing.T) {
	// HEAD requests are valid for video/audio range probing; the
	// dispatcher uses HEAD to discover Content-Length before deciding
	// whether to stream or download.
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "video.mp4"), "fake-mp4-bytes")

	w := httptest.NewRecorder()
	handleFileAsset(w, fileAssetHeadRequest(dir, "video.mp4"))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200", w.Code)
	}
	if w.Body.Len() != 0 {
		t.Errorf("HEAD body should be empty, got %d bytes", w.Body.Len())
	}
}

func TestHandleFileAsset_RangeSupported(t *testing.T) {
	// http.ServeFile handles Range for partial-content video scrubbing.
	// The handler does not interfere — this test pins that we still
	// return 206 for a Range request.
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "video.mp4"),
		"0123456789abcdef0123456789abcdef")

	r := fileAssetRequest(dir, "video.mp4")
	r.Header.Set("Range", "bytes=0-3")
	w := httptest.NewRecorder()
	handleFileAsset(w, r)
	if w.Code != http.StatusPartialContent {
		t.Errorf("got %d want 206; body=%s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != "0123" {
		t.Errorf("body = %q want %q", got, "0123")
	}
}

func TestHandleFileAsset_RejectsNonGetOrHead(t *testing.T) {
	dir := t.TempDir()
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		r := fileAssetRequest(dir, "a.txt")
		r.Method = m
		w := httptest.NewRecorder()
		handleFileAsset(w, r)
		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: got %d want 405", m, w.Code)
		}
	}
}
