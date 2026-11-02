package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/hypernewbie/phi/internal/webassets"
)

// Request the composed application, not the handler assigned to a field.
// A disk override must bypass embedded validators and representation caches.
func TestDiskDispatch(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	app := testServer
	embedded := webassets.New(fstest.MapFS{"app.js": {Data: []byte(strings.Repeat("const answer = 42;\n", 200))}}, nil, true)
	app.static = embedded
	handler := app.Handler()
	get := func(enc, etag string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/app.js", nil)
		req.Header.Set("Accept-Encoding", enc)
		if etag != "" {
			req.Header.Set("If-None-Match", etag)
			req.Header.Set("If-Modified-Since", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	etags := map[string]string{}
	for _, enc := range []string{"gzip", "br"} {
		w := get(enc, "")
		if w.Code != 200 || w.Header().Get("Content-Encoding") != enc || w.Header().Get("Etag") == "" {
			t.Fatalf("embedded %s: %d %v", enc, w.Code, w.Header())
		}
		etags[enc] = w.Header().Get("Etag")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("fresh disk bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := webassets.OpenDiskRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	app.static = webassets.NewDisk(root.FS())
	for _, enc := range []string{"gzip", "br"} {
		w := get(enc, etags[enc])
		if w.Code != 200 || w.Body.String() != "fresh disk bytes" || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Etag") != "" || w.Header().Get("Content-Encoding") != "" {
			t.Fatalf("disk %s: %d %q %v", enc, w.Code, w.Body.String(), w.Header())
		}
	}
	app.static = embedded
	for _, enc := range []string{"gzip", "br"} {
		w := get(enc, "")
		if w.Header().Get("Etag") != etags[enc] || w.Header().Get("Content-Encoding") != enc || w.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("restored embedded %s: %d %v", enc, w.Code, w.Header())
		}
	}
}
