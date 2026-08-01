package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// assetRequest runs a GET /api/markdown/asset for the given path through
// handleMarkdownAsset. cwd is left empty everywhere: the tests configure
// absolute markdown dirs, which sidesteps activeCWD entirely.
func assetRequest(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	q := url.Values{"path": {path}, "cwd": {""}}
	req := httptest.NewRequest(http.MethodGet, "/api/markdown/asset?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	handleMarkdownAsset(w, req)
	return w
}

func TestHandleMarkdownAsset(t *testing.T) {
	withTempConfig(t)
	allowed := t.TempDir()
	outside := t.TempDir()
	writeConfigWithMarkdownDirs(t, allowed)

	// Anchor the workspace to the allowed temp dir so the confinement gate
	// (workspaceRoots) treats it as a real project root; restore after.
	origCWD := activeCWD
	activeCWD = allowed
	t.Cleanup(func() { activeCWD = origCWD })

	pngPath := filepath.Join(allowed, "pic.png")
	if err := os.WriteFile(pngPath, []byte("\x89PNG fake image bytes"), 0644); err != nil {
		t.Fatalf("write png: %v", err)
	}
	outsidePng := filepath.Join(outside, "outside.png")
	if err := os.WriteFile(outsidePng, []byte("outside"), 0644); err != nil {
		t.Fatalf("write outside png: %v", err)
	}
	dirNamedPng := filepath.Join(allowed, "fake.png")
	if err := os.MkdirAll(dirNamedPng, 0755); err != nil {
		t.Fatalf("mkdir fake.png: %v", err)
	}
	// Build the traversal path by string concatenation: filepath.Join
	// would pre-clean the `..` away, and a bare relative path would be
	// resolved against the test process cwd — either would make the case
	// pass for the wrong reason. This literal `..` is cleaned by the
	// handler's filepath.Abs, landing OUTSIDE the allowed dir.
	traversal := allowed + "/sub/../../escape.png"

	cases := []struct {
		name       string
		path       string
		wantStatus int
	}{
		{"png inside allowed dir", pngPath, http.StatusOK},
		{"md file rejected by extension allowlist", filepath.Join(allowed, "notes.md"), http.StatusForbidden},
		{"png outside allowed dirs", outsidePng, http.StatusForbidden},
		{"traversal with literal dot-dot", traversal, http.StatusForbidden},
		{"missing but allowed png", filepath.Join(allowed, "missing.png"), http.StatusNotFound},
		{"directory named like an image", dirNamedPng, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := assetRequest(t, tc.path)
			if w.Code != tc.wantStatus {
				t.Fatalf("status: got %d want %d (body=%s)", w.Code, tc.wantStatus, w.Body.String())
			}
		})
	}

	t.Run("happy path content type and security headers", func(t *testing.T) {
		w := assetRequest(t, pngPath)
		if w.Code != http.StatusOK {
			t.Fatalf("status %d body=%s", w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/png") {
			t.Fatalf("Content-Type: got %q want image/png", ct)
		}
		if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("X-Content-Type-Options: got %q want nosniff", got)
		}
		if got := w.Header().Get("Content-Security-Policy"); got != "script-src 'none'" {
			t.Fatalf("Content-Security-Policy: got %q want script-src 'none'", got)
		}
	})

	// A symlink whose target stays inside the workspace resolves and serves
	// normally — the symlink ban was dropped in favor of resolve-then-confine.
	t.Run("symlink within workspace serves", func(t *testing.T) {
		link := filepath.Join(allowed, "link.png")
		if err := os.Symlink(pngPath, link); err != nil {
			t.Skipf("symlinks unsupported here: %v", err)
		}
		defer os.Remove(link)
		if w := assetRequest(t, link); w.Code != http.StatusOK {
			t.Fatalf("status: got %d want 200 (body=%s)", w.Code, w.Body.String())
		}
	})

	// A symlink inside an allowed dir pointing OUTSIDE the workspace is
	// blocked: the confinement gate runs on the resolved target.
	t.Run("symlink escaping workspace blocked", func(t *testing.T) {
		link := filepath.Join(allowed, "escape-link.png")
		if err := os.Symlink(outsidePng, link); err != nil {
			t.Skipf("symlinks unsupported here: %v", err)
		}
		defer os.Remove(link)
		if w := assetRequest(t, link); w.Code != http.StatusForbidden {
			t.Fatalf("status: got %d want 403 (body=%s)", w.Code, w.Body.String())
		}
	})

	// A crafted cwd makes the target pass the markdown-dir gate (relative
	// "." dir resolves against cwd), but workspace confinement rejects it —
	// the client-supplied cwd cannot reach outside the real workspace.
	t.Run("crafted cwd cannot escape workspace", func(t *testing.T) {
		writeConfigWithMarkdownDirs(t, ".")
		q := url.Values{"path": {outsidePng}, "cwd": {outside}}
		req := httptest.NewRequest(http.MethodGet, "/api/markdown/asset?"+q.Encode(), nil)
		rec := httptest.NewRecorder()
		handleMarkdownAsset(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status: got %d want 403 (body=%s)", rec.Code, rec.Body.String())
		}
	})
}
