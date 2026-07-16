package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// withTempHome redirects os.UserHomeDir() to a fresh temp dir for the
// duration of the test. Mirrors withTempConfig's intent for the config
// subsystem, but for the home-directory-dependent attachment handler.
// Without this, tests would write real files into the developer's
// ~/.phi/clipboard/ directory.
func withTempHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	homeKey := "HOME"
	if runtime.GOOS == "windows" {
		homeKey = "USERPROFILE"
	}
	t.Setenv(homeKey, tmp)
	t.Setenv("HOME", tmp) // belt-and-suspenders for cross-platform tooling
	return tmp
}

// attachmentFixturePNG returns a minimal valid PNG byte slice. Real PNG
// parsing is not exercised by the handler — only the bytes need to be
// non-empty and the MIME type set on the multipart header.
func attachmentFixturePNG(size int) []byte {
	if size < 8 {
		size = 8
	}
	// PNG signature (8 bytes) + zero padding. Not a valid image but
	// indistinguishable from bytes for handler purposes.
	out := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	out = append(out, bytes.Repeat([]byte{0}, size-8)...)
	return out
}

func newMultipartRequest(t *testing.T, fieldName, filename, mime string, content []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	// CreateFormFile hardcodes Content-Type: application/octet-stream.
	// Use CreatePart with an explicit header so the MIME flows through
	// to the handler, matching what real browsers send for image uploads.
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, fieldName, filename))
	h.Set("Content-Type", mime)
	w, err := mw.CreatePart(h)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	if _, err := w.Write(content); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close mw: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/attachments", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func TestHandleAttachments_HappyPath(t *testing.T) {
	home := withTempHome(t)
	data := attachmentFixturePNG(64)

	req := newMultipartRequest(t, "file", "client-name-ignored.png", "image/png", data)
	w := httptest.NewRecorder()
	handleAttachments(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	path, _ := resp["path"].(string)
	name, _ := resp["name"].(string)
	mime, _ := resp["mimeType"].(string)
	size, _ := resp["sizeBytes"].(float64)

	if !strings.HasPrefix(name, "clip-") || !strings.HasSuffix(name, ".png") {
		t.Fatalf("name format wrong: %q", name)
	}
	if mime != "image/png" {
		t.Fatalf("mime: %v", mime)
	}
	if int(size) != len(data) {
		t.Fatalf("sizeBytes: %v want %d", size, len(data))
	}
	if !strings.HasPrefix(path, filepath.Join(home, ".phi", "clipboard")) {
		t.Fatalf("path not under home/clipboard: %s", path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not on disk: %v", err)
	}
	// Ensure server ignored the client-supplied basename.
	if strings.Contains(path, "client-name-ignored") {
		t.Fatalf("server should ignore client basename, got %s", path)
	}
}

func TestHandleAttachments_RejectsDisallowedMIME(t *testing.T) {
	withTempHome(t)
	req := newMultipartRequest(t, "file", "evil.html", "text/html", []byte("<html>"))
	w := httptest.NewRecorder()
	handleAttachments(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestHandleAttachments_RejectsOversize(t *testing.T) {
	withTempHome(t)
	// 26 MB > attachmentMaxBytes (25 MB). The handler's MaxBytesReader
	// should trip before the body is fully read.
	data := attachmentFixturePNG(26 << 20)
	req := newMultipartRequest(t, "file", "big.png", "image/png", data)
	w := httptest.NewRecorder()
	handleAttachments(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestHandleAttachments_RejectsNonPost(t *testing.T) {
	withTempHome(t)
	req := httptest.NewRequest(http.MethodGet, "/api/attachments", nil)
	w := httptest.NewRecorder()
	handleAttachments(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestHandleAttachments_RejectsMissingFileField(t *testing.T) {
	withTempHome(t)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("notfile", "x"); err != nil {
		t.Fatalf("writefield: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/attachments", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	handleAttachments(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestHandleAttachments_SweepKeepsRecentFifty(t *testing.T) {
	home := withTempHome(t)
	dir := filepath.Join(home, ".phi", "clipboard")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// Pre-create 60 files with increasing mtimes.
	for i := 0; i < 60; i++ {
		p := filepath.Join(dir, "presweep-"+string(rune('a'+i%26))+string(rune('a'+(i/26)%26))+".png")
		if err := os.WriteFile(p, []byte{0x89, 'P', 'N', 'G'}, 0644); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		// Stagger mtimes deterministically by sleeping 1ms.
		// (Tests aren't time-critical; 60ms total is fine.)
		if i < 59 {
			now := offsetMtimeBy(int64(i))
			_ = os.Chtimes(p, now, now)
		}
	}

	// Trigger one upload; sweep should drop the 10 oldest.
	data := attachmentFixturePNG(16)
	req := newMultipartRequest(t, "file", "fresh.png", "image/png", data)
	w := httptest.NewRecorder()
	handleAttachments(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) > attachmentSweepKeep {
		t.Fatalf("after sweep, dir has %d entries; want <= %d", len(entries), attachmentSweepKeep)
	}
}

// offsetMtimeBy returns a deterministic past time. Used by the sweep test
// to give the pre-seeded files distinguishable mtimes without flake.
func offsetMtimeBy(secs int64) (t time.Time) {
	return time.Now().Add(-time.Hour).Add(time.Duration(secs) * time.Second)
}

// silence unused-import warnings if a future refactor removes reads.
var _ = io.Discard