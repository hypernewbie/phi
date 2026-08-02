package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
)

// setupStaticAssets initializes webRoot and the ETag map from the real
// embedded assets. Re-inits every call: initStaticAssets captures
// compression_enabled at startup, so each test gets the default-true
// snapshot from its own temp config regardless of what an earlier test
// captured. Returns the temp config path for tests that rewrite it.
func setupStaticAssets(t *testing.T) string {
	t.Helper()
	cfgPath := withTempConfig(t)
	if webRoot == nil {
		root, err := newWebRoot()
		if err != nil {
			t.Fatalf("newWebRoot: %v", err)
		}
		webRoot = root
	}
	initStaticAssets(webRoot)
	return cfgPath
}

func getStatic(t *testing.T, target string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	serveStatic(rec, req)
	return rec
}

func TestStaticETagAndCacheControl(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/app.js", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	etag := rec.Header().Get("Etag")
	if len(etag) < 3 || etag[0] != '"' || etag[len(etag)-1] != '"' {
		t.Fatalf("ETag %q is not a quoted strong ETag", etag)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", cc)
	}
	want, err := fs.ReadFile(webRoot, "app.js")
	if err != nil {
		t.Fatalf("read embedded app.js: %v", err)
	}
	if rec.Body.String() != string(want) {
		t.Fatal("body differs from embedded app.js")
	}
}

func TestStaticConditionalGet304(t *testing.T) {
	setupStaticAssets(t)
	etag := getStatic(t, "/app.js", nil).Header().Get("Etag")
	rec := getStatic(t, "/app.js", map[string]string{"If-None-Match": etag})
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 body = %d bytes, want 0", rec.Body.Len())
	}
}

func TestStaticRootSharesIndexETag(t *testing.T) {
	setupStaticAssets(t)
	root := getStatic(t, "/", nil).Header().Get("Etag")
	index := staticAssets["index.html"].etag("")
	if root != index {
		t.Fatalf("ETag for / = %q, want index.html's %q", root, index)
	}
}

func TestStaticNonGetUntouched(t *testing.T) {
	setupStaticAssets(t)
	req := httptest.NewRequest(http.MethodPost, "/app.js", nil)
	rec := httptest.NewRecorder()
	serveStatic(rec, req)
	if rec.Header().Get("Etag") != "" || rec.Header().Get("Cache-Control") != "" {
		t.Fatal("POST must not receive cache headers")
	}
}

func TestStaticBellHasETag(t *testing.T) {
	setupStaticAssets(t)
	if getStatic(t, "/vendor/bell.wav", nil).Header().Get("Etag") == "" {
		t.Fatal("bell.wav missing ETag")
	}
}

func TestStaticGzipNegotiation(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": "gzip"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", ce)
	}
	if v := rec.Header().Get("Vary"); v != "Accept-Encoding" {
		t.Fatalf("Vary = %q, want Accept-Encoding", v)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	want, _ := fs.ReadFile(webRoot, "app.js")
	if !bytes.Equal(got, want) {
		t.Fatal("gunzipped body differs from embedded app.js")
	}
}

func TestStaticBrotliPreferredOverGzip(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/style.css", map[string]string{"Accept-Encoding": "gzip, deflate, br"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "br" {
		t.Fatalf("Content-Encoding = %q, want br", ce)
	}
	got, err := io.ReadAll(brotli.NewReader(rec.Body))
	if err != nil {
		t.Fatalf("brotli decode: %v", err)
	}
	want, _ := fs.ReadFile(webRoot, "style.css")
	if !bytes.Equal(got, want) {
		t.Fatal("brotli body differs from embedded style.css")
	}
}

func TestStaticUnknownEncodingIdentity(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": "zstd"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "" {
		t.Fatalf("Content-Encoding = %q, want identity", ce)
	}
}

func TestStaticSkipListNotCompressed(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/vendor/logos/claude.png", map[string]string{"Accept-Encoding": "gzip, br"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "" {
		t.Fatalf("png got Content-Encoding %q", ce)
	}
	if rec.Header().Get("Etag") == "" {
		t.Fatal("skip-listed asset still needs an ETag")
	}
}

func TestStaticBellCompresses(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/vendor/bell.wav", map[string]string{"Accept-Encoding": "gzip"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "gzip" {
		t.Fatalf("bell.wav Content-Encoding = %q, want gzip", ce)
	}
	orig, _ := fs.ReadFile(webRoot, "vendor/bell.wav")
	if rec.Body.Len() >= len(orig) {
		t.Fatalf("compressed bell (%d) not smaller than original (%d)", rec.Body.Len(), len(orig))
	}
}

func TestStaticCompressed304UsesVariantETag(t *testing.T) {
	setupStaticAssets(t)
	first := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": "gzip"})
	etag := first.Header().Get("Etag")
	if !strings.HasSuffix(etag, `-gzip"`) {
		t.Fatalf("variant ETag = %q, want -gzip suffix", etag)
	}
	rec := getStatic(t, "/app.js", map[string]string{
		"Accept-Encoding": "gzip",
		"If-None-Match":   etag,
	})
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatal("304 must have an empty body")
	}
}

func TestStaticRangeServedIdentity(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/app.js", map[string]string{
		"Accept-Encoding": "gzip",
		"Range":           "bytes=0-99",
	})
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rec.Code)
	}
	if ce := rec.Header().Get("Content-Encoding"); ce != "" {
		t.Fatalf("range response got Content-Encoding %q", ce)
	}
	if rec.Body.Len() != 100 {
		t.Fatalf("range body = %d bytes, want 100", rec.Body.Len())
	}
}

func TestStaticCompressionDisabledByConfig(t *testing.T) {
	cfgPath := setupStaticAssets(t)
	if err := os.WriteFile(cfgPath, []byte(`{"compression_enabled":false}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	// The flag is captured at startup, not per request — re-init to
	// simulate a restart with the new config.
	initStaticAssets(webRoot)
	rec := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": "gzip, br"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "" {
		t.Fatalf("Content-Encoding = %q, want identity when disabled", ce)
	}
	if v := rec.Header().Get("Vary"); v != "" {
		t.Fatalf("Vary = %q, want unset when compression disabled", v)
	}
	if rec.Header().Get("Etag") == "" {
		t.Fatal("ETag must remain when compression is disabled")
	}
}

func TestStaticIfMatchMismatch412(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/app.js", map[string]string{
		"Accept-Encoding": "gzip",
		"If-Match":        `"stale-tag"`,
	})
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatal("412 must have an empty body")
	}
}

func TestStaticIfMatchCurrentTag200(t *testing.T) {
	setupStaticAssets(t)
	etag := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": "gzip"}).Header().Get("Etag")
	rec := getStatic(t, "/app.js", map[string]string{
		"Accept-Encoding": "gzip",
		"If-Match":        `"other-tag", ` + etag,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ce := rec.Header().Get("Content-Encoding"); ce != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", ce)
	}
}

func TestStaticIfMatchWeakTagFails(t *testing.T) {
	setupStaticAssets(t)
	etag := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": "gzip"}).Header().Get("Etag")
	rec := getStatic(t, "/app.js", map[string]string{
		"Accept-Encoding": "gzip",
		"If-Match":        "W/" + etag,
	})
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412 (strong comparison rejects weak tags)", rec.Code)
	}
}
