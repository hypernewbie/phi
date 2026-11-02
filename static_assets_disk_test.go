package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/server"
	"github.com/hypernewbie/phi/internal/webassets"
)

// setupStaticAssets installs a handler over the real embedded tree as the
// process-wide static handler. The embedded tree is read once at startup,
// so each call re-reads it, which is what a restart does. Returns the temp
// config path for tests that rewrite it.
func setupStaticAssets(t *testing.T) string {
	t.Helper()
	cfgPath := withTempConfig(t)
	root, precompressed, err := newWebRoot()
	if err != nil {
		t.Fatalf("newWebRoot: %v", err)
	}
	h := webassets.New(root, precompressed, loadConfig().CompressionEnabled)
	testWebRoot = root
	testStatic = h
	server.Static = h
	t.Cleanup(func() {
		testWebRoot, testStatic, server.Static = nil, nil, nil
	})
	return cfgPath
}

func getStatic(t *testing.T, target string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	testStatic.ServeHTTP(rec, req)
	return rec
}

var (
	testStatic  *webassets.Handler
	testWebRoot fs.FS
)

func writeDiskAsset(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func diskHandler(t *testing.T, dir string) http.Handler {
	t.Helper()
	root, err := webassets.OpenDiskRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return webassets.NewDisk(root.FS())
}

func requestDisk(h http.Handler, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func assertDiskResponse(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status || rec.Body.String() != body {
		t.Fatalf("response = %d %q, want %d %q", rec.Code, rec.Body.String(), status, body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if rec.Header().Get("Etag") != "" || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("disk response has embedded metadata: %v", rec.Header())
	}
}

// TestDiskDispatch pins the --web precedence rule: a disk override wins
// over the embedded handler, and dropping it restores embedded serving
// with its own validators. Pure disk serving lives in internal/webassets.
func TestDiskDispatch(t *testing.T) {
	diskHandlerSaved, testStaticSaved := server.Static, testStatic
	testWebRootSaved := testWebRoot
	t.Cleanup(func() {
		server.Static, testStatic = diskHandlerSaved, testStaticSaved
		testWebRoot = testWebRootSaved
	})
	server.Static = nil
	setupStaticAssets(t)
	etags := make(map[string]string)
	for _, enc := range []string{"gzip", "br"} {
		rec := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": enc})
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != enc {
			t.Fatalf("embedded %s cache not populated: %d %v", enc, rec.Code, rec.Header())
		}
		etags[enc] = rec.Header().Get("Etag")
	}
	dir := t.TempDir()
	writeDiskAsset(t, dir, "app.js", "fresh disk bytes")
	server.Static = diskHandler(t, dir)
	for _, enc := range []string{"gzip", "br"} {
		rec := requestDisk(server.Static, http.MethodGet, "/app.js", map[string]string{
			"Accept-Encoding":   enc,
			"If-None-Match":     etags[enc],
			"If-Modified-Since": time.Now().Add(time.Hour).UTC().Format(http.TimeFormat),
		})
		assertDiskResponse(t, rec, http.StatusOK, "fresh disk bytes")
	}
	server.Static = testStatic
	for _, enc := range []string{"gzip", "br"} {
		rec := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": enc})
		if rec.Header().Get("Etag") != etags[enc] || rec.Header().Get("Content-Encoding") != enc || rec.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("embedded %s behavior changed: %v", enc, rec.Header())
		}
	}
}
