package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// fsListRequest builds a /api/fs/list request with explicit cwd/path query
// params — never rely on the activeCWD global, which is process-wide state.
func fsListRequest(cwd, path string) *http.Request {
	q := url.Values{}
	q.Set("cwd", cwd)
	if path != "" {
		q.Set("path", path)
	}
	return httptest.NewRequest(http.MethodGet, "/api/fs/list?"+q.Encode(), nil)
}

func TestHandleFSList_NonRepoListing(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "a.txt"), "hi")
	mustWriteFile(t, filepath.Join(dir, ".hidden"), "shh")
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}

	w := httptest.NewRecorder()
	handleFSList(w, fsListRequest(dir, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSListResponse(t, w)
	want := []FSEntry{{Name: "sub", Dir: true}, {Name: "a.txt", Dir: false}}
	if !fsEntriesEqual(resp.Entries, want) {
		t.Errorf("entries = %+v, want %+v", resp.Entries, want)
	}
}

func TestHandleFSList_TraversalRejected(t *testing.T) {
	dir := t.TempDir()

	cases := []struct {
		name string
		path string
		// A drive-letter path is only absolute on Windows; elsewhere it is an
		// ordinary (odd) relative filename and rejecting it would be wrong.
		windowsOnly bool
	}{
		{name: "dotdot", path: ".."},
		// filepath.IsAbs("/etc") is false on Windows, where an absolute path
		// needs a drive letter or UNC prefix, so without an explicit
		// root-relative check these are treated as relative to cwd.
		{name: "absolute", path: "/etc"},
		{name: "backslashRooted", path: `\etc`},
		{name: "driveLetter", path: `C:\Windows`, windowsOnly: true},
		{name: "collapsesToParent", path: "a/../../b"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.windowsOnly && runtime.GOOS != "windows" {
				t.Skip("drive-letter paths are only absolute on windows")
			}
			w := httptest.NewRecorder()
			handleFSList(w, fsListRequest(dir, c.path))
			if w.Code != http.StatusBadRequest {
				t.Errorf("path=%q: got %d want 400; body=%s", c.path, w.Code, w.Body.String())
			}
		})
	}
}

func TestHandleFSList_SymlinkEscapeBlocked(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require elevated privileges on windows")
	}
	workspace := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(workspace, "link")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	w := httptest.NewRecorder()
	handleFSList(w, fsListRequest(workspace, "link"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d want 403; body=%s", w.Code, w.Body.String())
	}
}

func TestHandleFSList_RepoFiltering(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	mustWriteFile(t, filepath.Join(dir, ".gitignore"), "ignored.txt\nbuild/\n")
	mustWriteFile(t, filepath.Join(dir, "ignored.txt"), "x")
	mustWriteFile(t, filepath.Join(dir, "keep.txt"), "x")
	if err := os.Mkdir(filepath.Join(dir, "build"), 0o755); err != nil {
		t.Fatalf("mkdir build: %v", err)
	}

	w := httptest.NewRecorder()
	handleFSList(w, fsListRequest(dir, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSListResponse(t, w)

	names := map[string]bool{}
	for _, e := range resp.Entries {
		names[e.Name] = true
	}
	for _, want := range []string{"keep.txt", ".gitignore"} {
		if !names[want] {
			t.Errorf("expected %q to be present, entries=%+v", want, resp.Entries)
		}
	}
	for _, notWant := range []string{"ignored.txt", "build", ".git"} {
		if names[notWant] {
			t.Errorf("expected %q to be absent, entries=%+v", notWant, resp.Entries)
		}
	}
}

func TestHandleFSList_MissingDir(t *testing.T) {
	dir := t.TempDir()
	w := httptest.NewRecorder()
	handleFSList(w, fsListRequest(dir, "nope"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d want 404; body=%s", w.Code, w.Body.String())
	}
}

func mustWriteFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func decodeFSListResponse(t *testing.T, w *httptest.ResponseRecorder) FSListResponse {
	t.Helper()
	var resp FSListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v\nbody=%s", err, w.Body.String())
	}
	return resp
}

func fsEntriesEqual(got, want []FSEntry) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
