package main

import (
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func writeDiskAsset(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func diskHandler(t *testing.T, dir string) http.Handler {
	t.Helper()
	root, err := openDiskWebRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return newDiskStaticHandler(root.FS())
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

func TestDiskRootPaths(t *testing.T) {
	dir := t.TempDir()
	writeDiskAsset(t, dir, "app.js", "disk asset")
	for _, relative := range []bool{false, true} {
		name := "absolute"
		if relative {
			name = "relative"
		}
		t.Run(name, func(t *testing.T) {
			selected := dir
			if relative {
				t.Chdir(filepath.Dir(dir))
				selected = filepath.Base(dir)
			}
			root, err := openDiskWebRoot(selected)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { root.Close() })
			if !filepath.IsAbs(root.Name()) || root.Name() != dir {
				t.Fatalf("root name = %q, want absolute %q", root.Name(), dir)
			}
			// The selected root stays anchored after a later working-directory change.
			t.Chdir(t.TempDir())
			data, err := fs.ReadFile(root.FS(), "app.js")
			if err != nil || string(data) != "disk asset" {
				t.Fatalf("root read = %q, %v", data, err)
			}
		})
	}
	for _, name := range []string{"missing", "app.js"} {
		t.Run(name, func(t *testing.T) {
			root, err := openDiskWebRoot(filepath.Join(dir, name))
			if root != nil {
				root.Close()
				t.Fatal("invalid directory returned an open root")
			}
			if err == nil {
				t.Fatal("invalid directory did not return an error")
			}
		})
	}
}

func TestDiskRootSymlinks(t *testing.T) {
	for _, outside := range []bool{false, true} {
		name := "internal"
		if outside {
			name = "external"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			target := "target.txt"
			writeDiskAsset(t, dir, target, "inside")
			if outside {
				external := t.TempDir()
				writeDiskAsset(t, external, target, "outside secret")
				var err error
				target, err = filepath.Rel(dir, filepath.Join(external, target))
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(target, filepath.Join(dir, "link.txt")); err != nil {
				if runtime.GOOS == "windows" && (errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.Errno(1314))) {
					t.Skipf("symlink creation is not permitted: %v", err)
				}
				t.Fatal(err)
			}
			rec := requestDisk(diskHandler(t, dir), http.MethodGet, "/link.txt", nil)
			if outside {
				if rec.Code == http.StatusOK || rec.Body.String() == "outside secret" {
					t.Fatalf("external symlink escaped root: %d %q", rec.Code, rec.Body.String())
				}
				return
			}
			assertDiskResponse(t, rec, http.StatusOK, "inside")
		})
	}
}

func TestDiskFreshBytes(t *testing.T) {
	for _, asset := range []struct{ name, before, after string }{
		{"page.html", "<p>old</p>", "<p>new</p>"},
		{"app.js", "window.old=1;", "window.new=2;"},
		{"style.css", "p{color:red}", "p{color:tan}"},
		{"data.bin", "\x00\x01\x02", "\x00\x03\x04"},
	} {
		t.Run(asset.name, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, asset.name)
			stamp := time.Unix(1_700_000_000, 0).UTC()
			write := func(body string) {
				writeDiskAsset(t, dir, asset.name, body)
				if err := os.Chtimes(file, stamp, stamp); err != nil {
					t.Fatal(err)
				}
			}
			write(asset.before)
			h := diskHandler(t, dir)
			assertDiskResponse(t, requestDisk(h, http.MethodGet, "/"+asset.name, nil), http.StatusOK, asset.before)
			if len(asset.before) != len(asset.after) {
				t.Fatal("fixture replacement must retain the original length")
			}
			write(asset.after)
			for _, validators := range []map[string]string{
				{},
				{"If-Modified-Since": stamp.Format(http.TimeFormat)},
				{"If-None-Match": `"old-embedded-tag"`},
				{"If-None-Match": "*"},
				{"If-None-Match": "*", "If-Modified-Since": stamp.Format(http.TimeFormat)},
			} {
				validators["Accept-Encoding"] = "gzip, br"
				assertDiskResponse(t, requestDisk(h, http.MethodGet, "/"+asset.name, validators), http.StatusOK, asset.after)
			}
		})
	}
}

func TestDiskFileChanges(t *testing.T) {
	dir := t.TempDir()
	h := diskHandler(t, dir)
	if rec := requestDisk(h, http.MethodGet, "/new.js", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("missing file status = %d", rec.Code)
	}
	writeDiskAsset(t, dir, "new.js", "created")
	assertDiskResponse(t, requestDisk(h, http.MethodGet, "/new.js", nil), http.StatusOK, "created")
	if err := os.Remove(filepath.Join(dir, "new.js")); err != nil {
		t.Fatal(err)
	}
	if rec := requestDisk(h, http.MethodGet, "/new.js", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("deleted file status = %d", rec.Code)
	}
}

func TestDiskHTTP(t *testing.T) {
	dir := t.TempDir()
	writeDiskAsset(t, dir, "index.html", "old index")
	writeDiskAsset(t, dir, "app.js", "old bytes")
	h := diskHandler(t, dir)
	assertDiskResponse(t, requestDisk(h, http.MethodGet, "/", nil), http.StatusOK, "old index")
	writeDiskAsset(t, dir, "index.html", "new index")
	writeDiskAsset(t, dir, "app.js", "current bytes")
	assertDiskResponse(t, requestDisk(h, http.MethodGet, "/", nil), http.StatusOK, "new index")
	redirect := requestDisk(h, http.MethodGet, "/index.html", nil)
	if redirect.Code != http.StatusMovedPermanently || redirect.Header().Get("Location") != "./" {
		t.Fatalf("index redirect = %d %v", redirect.Code, redirect.Header())
	}

	head := requestDisk(h, http.MethodHead, "/app.js", map[string]string{"If-None-Match": "*", "Accept-Encoding": "gzip, br"})
	assertDiskResponse(t, head, http.StatusOK, "")
	if got := head.Header().Get("Content-Length"); got != strconv.Itoa(len("current bytes")) {
		t.Fatalf("HEAD length = %q", got)
	}

	req := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	req.Header.Set("Range", "bytes=1-3")
	req.Header.Set("If-None-Match", "*")
	req.Header.Set("If-Modified-Since", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
	req.Header.Set("X-Test", "preserved")
	headers := req.Header.Clone()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assertDiskResponse(t, rec, http.StatusPartialContent, "urr")
	if !reflect.DeepEqual(req.Header, headers) {
		t.Fatalf("handler changed original request headers: %v", req.Header)
	}
	if rec.Header().Get("Content-Range") != "bytes 1-3/13" {
		t.Fatalf("range response = %v", rec.Header())
	}

	for name, ctype := range map[string]string{
		"module.mjs":  "text/javascript; charset=utf-8",
		"module.wasm": "application/wasm",
	} {
		writeDiskAsset(t, dir, name, "mime fixture")
		rec := requestDisk(h, http.MethodGet, "/"+name, nil)
		assertDiskResponse(t, rec, http.StatusOK, "mime fixture")
		if got := rec.Header().Get("Content-Type"); got != ctype {
			t.Fatalf("%s Content-Type = %q, want %q", name, got, ctype)
		}
	}

	post := requestDisk(h, http.MethodPost, "/app.js", map[string]string{"If-None-Match": "*"})
	if post.Code != http.StatusPreconditionFailed {
		t.Fatalf("POST lost its precondition: status = %d", post.Code)
	}
}

func TestDiskDispatch(t *testing.T) {
	savedHandler, savedRoot := diskStatic, webRoot
	savedAssets, savedBrotli, savedCompression := staticAssets, preBrotli, staticCompressionOn
	t.Cleanup(func() {
		diskStatic, webRoot = savedHandler, savedRoot
		staticAssets, preBrotli, staticCompressionOn = savedAssets, savedBrotli, savedCompression
	})
	diskStatic = nil
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
	diskStatic = diskHandler(t, dir)
	for _, enc := range []string{"gzip", "br"} {
		rec := getStatic(t, "/app.js", map[string]string{
			"Accept-Encoding":   enc,
			"If-None-Match":     etags[enc],
			"If-Modified-Since": time.Now().Add(time.Hour).UTC().Format(http.TimeFormat),
		})
		assertDiskResponse(t, rec, http.StatusOK, "fresh disk bytes")
	}
	diskStatic = nil
	for _, enc := range []string{"gzip", "br"} {
		rec := getStatic(t, "/app.js", map[string]string{"Accept-Encoding": enc})
		if rec.Header().Get("Etag") != etags[enc] || rec.Header().Get("Content-Encoding") != enc || rec.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("embedded %s behavior changed: %v", enc, rec.Header())
		}
	}
}
