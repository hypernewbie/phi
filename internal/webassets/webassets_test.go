package webassets

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

// testRoot is the real web/ tree from the repository. Embedded trees are
// built from the same files, so serving behavior against disk matches it.
func testRoot() fs.FS { return os.DirFS("../../web") }

// newTestHandler builds a handler over testRoot with compression on.
// Each call re-reads the tree, which is what a process restart does.
func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	return New(testRoot(), nil, true)
}

func getStatic(t *testing.T, h *Handler, target string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestStaticETagAndCacheControl(t *testing.T) {
	h := newTestHandler(t)
	rec := getStatic(t, h, "/app.js", nil)
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
	want, err := fs.ReadFile(testRoot(), "app.js")
	if err != nil {
		t.Fatalf("read app.js: %v", err)
	}
	if rec.Body.String() != string(want) {
		t.Fatal("body differs from app.js")
	}
}

func TestStaticConditionalGet304(t *testing.T) {
	h := newTestHandler(t)
	etag := getStatic(t, h, "/app.js", nil).Header().Get("Etag")
	rec := getStatic(t, h, "/app.js", map[string]string{"If-None-Match": etag})
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 body = %d bytes, want 0", rec.Body.Len())
	}
}

func TestStaticRootSharesIndexETag(t *testing.T) {
	h := newTestHandler(t)
	root := getStatic(t, h, "/", nil).Header().Get("Etag")
	index := h.assets["index.html"].etag("")
	if root != index {
		t.Fatalf("ETag for / = %q, want index.html's %q", root, index)
	}
}

func TestStaticNonGetUntouched(t *testing.T) {
	h := newTestHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/app.js", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Header().Get("Etag") != "" || rec.Header().Get("Cache-Control") != "" {
		t.Fatal("POST must not receive cache headers")
	}
}

func TestStaticBellHasETag(t *testing.T) {
	h := newTestHandler(t)
	if getStatic(t, h, "/vendor/bell.wav", nil).Header().Get("Etag") == "" {
		t.Fatal("bell.wav missing ETag")
	}
}

func TestStaticGzipNegotiation(t *testing.T) {
	h := newTestHandler(t)
	rec := getStatic(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip"})
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
	want, _ := fs.ReadFile(testRoot(), "app.js")
	if !bytes.Equal(got, want) {
		t.Fatal("gunzipped body differs from app.js")
	}
}

func TestStaticBrotliPreferredOverGzip(t *testing.T) {
	h := newTestHandler(t)
	rec := getStatic(t, h, "/style.css", map[string]string{"Accept-Encoding": "gzip, deflate, br"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "br" {
		t.Fatalf("Content-Encoding = %q, want br", ce)
	}
	got, err := io.ReadAll(brotli.NewReader(rec.Body))
	if err != nil {
		t.Fatalf("brotli decode: %v", err)
	}
	want, _ := fs.ReadFile(testRoot(), "style.css")
	if !bytes.Equal(got, want) {
		t.Fatal("brotli body differs from style.css")
	}
}

func TestStaticUnknownEncodingIdentity(t *testing.T) {
	h := newTestHandler(t)
	rec := getStatic(t, h, "/app.js", map[string]string{"Accept-Encoding": "zstd"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "" {
		t.Fatalf("Content-Encoding = %q, want identity", ce)
	}
}

func TestStaticSkipListNotCompressed(t *testing.T) {
	h := newTestHandler(t)
	rec := getStatic(t, h, "/vendor/logos/claude.png", map[string]string{"Accept-Encoding": "gzip, br"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "" {
		t.Fatalf("png got Content-Encoding %q", ce)
	}
	if rec.Header().Get("Etag") == "" {
		t.Fatal("skip-listed asset still needs an ETag")
	}
}

func TestStaticBellCompresses(t *testing.T) {
	h := newTestHandler(t)
	rec := getStatic(t, h, "/vendor/bell.wav", map[string]string{"Accept-Encoding": "gzip"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "gzip" {
		t.Fatalf("bell.wav Content-Encoding = %q, want gzip", ce)
	}
	orig, _ := fs.ReadFile(testRoot(), "vendor/bell.wav")
	if rec.Body.Len() >= len(orig) {
		t.Fatalf("compressed bell (%d) not smaller than original (%d)", rec.Body.Len(), len(orig))
	}
}

func TestStaticCompressed304UsesVariantETag(t *testing.T) {
	h := newTestHandler(t)
	first := getStatic(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip"})
	etag := first.Header().Get("Etag")
	if !strings.HasSuffix(etag, `-gzip"`) {
		t.Fatalf("variant ETag = %q, want -gzip suffix", etag)
	}
	rec := getStatic(t, h, "/app.js", map[string]string{
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
	h := newTestHandler(t)
	rec := getStatic(t, h, "/app.js", map[string]string{
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

// TestStaticCompressionDisabled pins the startup-only compression
// snapshot: a handler built with compression=false never encodes, but
// keeps ETags.
func TestStaticCompressionDisabled(t *testing.T) {
	h := New(testRoot(), nil, false)
	rec := getStatic(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip, br"})
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
	h := newTestHandler(t)
	rec := getStatic(t, h, "/app.js", map[string]string{
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
	h := newTestHandler(t)
	etag := getStatic(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip"}).Header().Get("Etag")
	rec := getStatic(t, h, "/app.js", map[string]string{
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

// TestStaticMjsMimeOverride pins the .mjs MIME override. On Windows,
// mime.TypeByExtension returns text/plain; charset=utf-8 for .mjs,
// which Chromium refuses to load as an ES module. The vendored PDF.js
// runtime ships .mjs (pdf.min.mjs, pdf.worker.min.mjs) so the override
// is load-bearing for the file viewer feature — the previous Windows
// behavior would break module loading with no error log.
func TestStaticMjsMimeOverride(t *testing.T) {
	h := newTestHandler(t)
	rec := getStatic(t, h, "/vendor/pdfjs/pdf.min.mjs", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("Content-Type = %q, want text/javascript prefix", ct)
	}
	if !strings.Contains(ct, "charset=utf-8") {
		t.Errorf("Content-Type = %q, want charset=utf-8", ct)
	}
}

func TestStaticWasmMimeOverride(t *testing.T) {
	h := newTestHandler(t)
	rec := getStatic(t, h, "/vendor/pdfjs/image_decoders/pdf.image_decoders.min.mjs", nil)
	// .mjs files in image_decoders/ are loaded by the pdfjs worker as
	// ES modules. They get the same MIME override.
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("Content-Type = %q, want text/javascript", ct)
	}
}

func TestStaticMjsCompresses(t *testing.T) {
	// .mjs is text — gzip should shrink it ~70%. This is a regression
	// guard against accidentally excluding .mjs from the compressible
	// extensions list.
	h := newTestHandler(t)
	rec := getStatic(t, h, "/vendor/pdfjs/pdf.min.mjs", map[string]string{
		"Accept-Encoding": "gzip",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ce := rec.Header().Get("Content-Encoding"); ce != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", ce)
	}
	// Body must actually decode to the original file.
	body := rec.Body.Bytes()
	gr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	decoded, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("gzip read: %v", err)
	}
	want, err := fs.ReadFile(testRoot(), "vendor/pdfjs/pdf.min.mjs")
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	if !bytes.Equal(decoded, want) {
		t.Errorf("decoded body length = %d, want %d", len(decoded), len(want))
	}
}

func TestStaticIfMatchWeakTagFails(t *testing.T) {
	h := newTestHandler(t)
	etag := getStatic(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip"}).Header().Get("Etag")
	rec := getStatic(t, h, "/app.js", map[string]string{
		"Accept-Encoding": "gzip",
		"If-Match":        "W/" + etag,
	})
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412 (strong comparison rejects weak tags)", rec.Code)
	}
}
