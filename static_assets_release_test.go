//go:build embedassets

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"testing"
)

// These tests compile only with -tags=embedassets and pin the release
// contract: br responses are the build-time bytes verbatim, identity
// responses reconstruct the original web/ sources, and ETags derive
// from identity content (stable across brotli version bumps).

func TestReleaseBrServedVerbatim(t *testing.T) {
	setupStaticAssets(t)
	rec := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": "br"})
	if ce := rec.Header().Get("Content-Encoding"); ce != "br" {
		t.Fatalf("Content-Encoding = %q, want br", ce)
	}
	want, err := fs.ReadFile(distFS, "webdist/app.js.br")
	if err != nil {
		t.Fatalf("read embedded app.js.br: %v", err)
	}
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatal("br body is not the embedded build-time payload")
	}
}

func TestReleaseIdentityMatchesSourceTree(t *testing.T) {
	setupStaticAssets(t)
	// vendor/ is never minified, so its decompressed identity bytes must
	// reconstruct the checkout's web/ copy exactly (generator gate order).
	src, err := os.ReadFile("web/vendor/xterm.js")
	if err != nil {
		t.Fatalf("read web/vendor/xterm.js from disk: %v", err)
	}
	got, err := fs.ReadFile(webRoot, "vendor/xterm.js")
	if err != nil {
		t.Fatalf("read vendor/xterm.js from webRoot: %v", err)
	}
	if !bytes.Equal(got, src) {
		t.Fatal("decompressed webRoot bytes differ from web/vendor/xterm.js")
	}
}

func TestReleaseETagIdentityDerived(t *testing.T) {
	setupStaticAssets(t)
	src, err := fs.ReadFile(webRoot, "app.js")
	if err != nil {
		t.Fatalf("read app.js: %v", err)
	}
	sum := sha256.Sum256(src)
	want := `"` + hex.EncodeToString(sum[:8]) + `"`
	if got := getStatic(t, "/app.js", nil).Header().Get("Etag"); got != want {
		t.Fatalf("ETag = %q, want identity-derived %q", got, want)
	}
}

func TestReleaseWebRootSeekable(t *testing.T) {
	setupStaticAssets(t)
	f, err := webRoot.Open("app.js")
	if err != nil {
		t.Fatalf("open app.js: %v", err)
	}
	defer f.Close()
	// http.ServeContent needs Seek for Range; MapFS providing it is an
	// implementation detail of testing/fstest — this assertion pins it.
	if _, ok := f.(io.Seeker); !ok {
		t.Fatal("webRoot files must implement io.Seeker for Range support")
	}
}

func TestReleaseFirstPartyMinified(t *testing.T) {
	setupStaticAssets(t)
	for _, p := range []string{"app.js", "style.css"} {
		src, err := os.ReadFile("web/" + p)
		if err != nil {
			t.Fatalf("read web/%s from disk: %v", p, err)
		}
		got, err := fs.ReadFile(webRoot, p)
		if err != nil {
			t.Fatalf("read %s from webRoot: %v", p, err)
		}
		if len(got) == 0 || len(got) >= len(src) {
			t.Fatalf("%s: webRoot %d bytes, source %d — expected minified (smaller, non-empty)", p, len(got), len(src))
		}
	}
}
