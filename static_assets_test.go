package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/webassets"
)

// Root tests cover the binary's embed adapter. HTTP representation behavior
// belongs to internal/webassets; real --web dispatch is in web-assets.spec.ts.
func setupStaticAssets(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	store := config.NewStore(config.Paths{Primary: path}, nil)
	root, precompressed, err := newWebRoot()
	if err != nil {
		t.Fatal(err)
	}
	testWebRoot = root
	testStatic = webassets.New(root, precompressed, store.Load().CompressionEnabled)
	t.Cleanup(func() { testWebRoot, testStatic = nil, nil })
	return path
}

// Prove config controls compression when the real embedded tree is loaded.
func TestStaticCompressionDisabledByConfig(t *testing.T) {
	path := setupStaticAssets(t)
	if err := os.WriteFile(path, []byte("compression_enabled = false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	store := config.NewStore(config.Paths{Primary: path}, nil)
	root, precompressed, err := newWebRoot()
	if err != nil {
		t.Fatal(err)
	}
	testStatic = webassets.New(root, precompressed, store.Load().CompressionEnabled)
	rec := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": "gzip, br"})
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("Vary") != "" || rec.Header().Get("Etag") == "" {
		t.Fatalf("compression-disabled response: %d %v", rec.Code, rec.Header())
	}
}

func getStatic(t *testing.T, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	testStatic.ServeHTTP(w, req)
	return w
}

var (
	testStatic  *webassets.Handler
	testWebRoot fs.FS
)
