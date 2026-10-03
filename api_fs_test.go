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
	"strconv"
	"strings"
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
	mustWriteFile(t, filepath.Join(dir, ".gitignore"), "ignored.txt\nignored.md\nnotes.md/\nbuild/\n")
	mustWriteFile(t, filepath.Join(dir, "ignored.txt"), "x")
	mustWriteFile(t, filepath.Join(dir, "ignored.md"), "x")
	mustWriteFile(t, filepath.Join(dir, "keep.txt"), "x")
	if err := os.Mkdir(filepath.Join(dir, "build"), 0o755); err != nil {
		t.Fatalf("mkdir build: %v", err)
	}
	// Dirs bypass the filter so ignored folders stay browsable.
	if err := os.Mkdir(filepath.Join(dir, "notes.md"), 0o755); err != nil {
		t.Fatalf("mkdir notes.md: %v", err)
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
	for _, want := range []string{"keep.txt", ".gitignore", "ignored.md", "build", "notes.md"} {
		if !names[want] {
			t.Errorf("expected %q to be present, entries=%+v", want, resp.Entries)
		}
	}
	for _, notWant := range []string{"ignored.txt", ".git"} {
		if names[notWant] {
			t.Errorf("expected %q to be absent, entries=%+v", notWant, resp.Entries)
		}
	}

	// Inside an ignored dir everything lists — the user browsed there
	// explicitly, so gitignore filtering stops at the door.
	mustWriteFile(t, filepath.Join(dir, "build", "out.js"), "x")
	mustWriteFile(t, filepath.Join(dir, "build", "notes.md"), "x")
	mustWriteFile(t, filepath.Join(dir, "build", "shot.png"), "x")
	mustWriteFile(t, filepath.Join(dir, "build", "doc.pdf"), "x")
	w = httptest.NewRecorder()
	handleFSList(w, fsListRequest(dir, "build"))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", w.Code, w.Body.String())
	}
	sub := decodeFSListResponse(t, w)
	subNames := map[string]bool{}
	for _, e := range sub.Entries {
		subNames[e.Name] = true
	}
	for _, want := range []string{"notes.md", "out.js", "shot.png", "doc.pdf"} {
		if !subNames[want] {
			t.Errorf("expected %q inside ignored dir, entries=%+v", want, sub.Entries)
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

// fsBrowseRequest builds a /api/fs/browse request with an explicit absolute path.
func fsBrowseRequest(path string) *http.Request {
	q := url.Values{}
	if path != "" {
		q.Set("path", path)
	}
	return httptest.NewRequest(http.MethodGet, "/api/fs/browse?"+q.Encode(), nil)
}

func decodeFSBrowseResponse(t *testing.T, w *httptest.ResponseRecorder) FSBrowseResponse {
	t.Helper()
	var resp FSBrowseResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v\nbody=%s", err, w.Body.String())
	}
	return resp
}

func TestHandleFSBrowse_MethodAndPathValidation(t *testing.T) {
	post := httptest.NewRequest(http.MethodPost, "/api/fs/browse?path=/", nil)
	w := httptest.NewRecorder()
	handleFSBrowse(w, post)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: got %d want 405; body=%s", w.Code, w.Body.String())
	}

	for _, path := range []string{"", "relative/path"} {
		t.Run(strconv.Quote(path), func(t *testing.T) {
			w := httptest.NewRecorder()
			handleFSBrowse(w, fsBrowseRequest(path))
			if w.Code != http.StatusBadRequest {
				t.Errorf("path=%q: got %d want 400; body=%s", path, w.Code, w.Body.String())
			}
		})
	}
}

func TestHandleFSBrowse_ExpandsHomeAndCleansPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("APPDATA", home)
	workspace := filepath.Join(home, "workspace")
	if err := os.Mkdir(workspace, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest("~"))
	if w.Code != http.StatusOK {
		t.Fatalf("home: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	if resp.Path != home || resp.Parent != filepath.Dir(home) {
		t.Fatalf("home path/parent = %q/%q, want %q/%q", resp.Path, resp.Parent, home, filepath.Dir(home))
	}
	if len(resp.Entries) != 1 || resp.Entries[0].Path != workspace {
		t.Fatalf("home entries = %+v, want workspace path %q", resp.Entries, workspace)
	}

	dirtyPath := workspace + string(filepath.Separator) + "missing" + string(filepath.Separator) + ".."
	w = httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(dirtyPath))
	if w.Code != http.StatusOK {
		t.Fatalf("cleaned path: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp = decodeFSBrowseResponse(t, w)
	if resp.Path != filepath.Clean(dirtyPath) || resp.Parent != filepath.Dir(workspace) {
		t.Fatalf("cleaned path/parent = %q/%q, want %q/%q", resp.Path, resp.Parent, filepath.Clean(dirtyPath), filepath.Dir(workspace))
	}
}

func TestHandleFSBrowse_FilesystemRootHasNoParent(t *testing.T) {
	root := t.TempDir()
	for filepath.Dir(root) != root {
		root = filepath.Dir(root)
	}

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(root))
	if w.Code != http.StatusOK {
		t.Fatalf("root: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	if resp.Path != root || resp.Parent != "" {
		t.Fatalf("root path/parent = %q/%q, want %q/empty", resp.Path, resp.Parent, root)
	}
}

func TestHandleFSBrowse_EmptyDirectoryHasEmptyArray(t *testing.T) {
	dir := t.TempDir()
	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(dir))
	if w.Code != http.StatusOK {
		t.Fatalf("empty dir: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	if resp.Entries == nil || len(resp.Entries) != 0 {
		t.Fatalf("empty entries = %#v, want non-nil empty slice", resp.Entries)
	}
	if !strings.Contains(w.Body.String(), `"entries":[]`) {
		t.Fatalf("empty response must encode entries as an array: %s", w.Body.String())
	}
}

func TestHandleFSBrowse_HidesFilesAndDotDirectories(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"visible", ".hidden", ".git"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
	mustWriteFile(t, filepath.Join(dir, "file.txt"), "file")

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(dir))
	if w.Code != http.StatusOK {
		t.Fatalf("listing: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	if len(resp.Entries) != 1 || resp.Entries[0].Name != "visible" {
		t.Fatalf("entries = %+v, want only visible directory", resp.Entries)
	}
}

func TestHandleFSBrowse_ExcludesSymlinkedChildren(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require elevated privileges on windows")
	}
	workspace := t.TempDir()
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(workspace, "linked-dir")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(workspace))
	if w.Code != http.StatusOK {
		t.Fatalf("listing: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	if len(resp.Entries) != 0 {
		t.Fatalf("symlinked child was listed: %+v", resp.Entries)
	}
}

func TestHandleFSBrowse_PreservesRequestedSymlinkAlias(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require elevated privileges on windows")
	}
	workspace := t.TempDir()
	target := t.TempDir()
	if err := os.Mkdir(filepath.Join(target, "child"), 0o755); err != nil {
		t.Fatalf("mkdir child: %v", err)
	}
	alias := filepath.Join(workspace, "alias")
	if err := os.Symlink(target, alias); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(alias))
	if w.Code != http.StatusOK {
		t.Fatalf("alias: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	wantChild := filepath.Join(alias, "child")
	if resp.Path != alias || resp.Parent != workspace || len(resp.Entries) != 1 || resp.Entries[0].Path != wantChild {
		t.Fatalf("alias response = %+v, want path=%q parent=%q child=%q", resp, alias, workspace, wantChild)
	}
}

func TestHandleFSBrowse_IncludesGitIgnoredDirectories(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	mustWriteFile(t, filepath.Join(dir, ".gitignore"), "ignored-dir/\n")
	if err := os.Mkdir(filepath.Join(dir, "ignored-dir"), 0o755); err != nil {
		t.Fatalf("mkdir ignored dir: %v", err)
	}

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(dir))
	if w.Code != http.StatusOK {
		t.Fatalf("listing: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	if len(resp.Entries) != 1 || resp.Entries[0].Name != "ignored-dir" {
		t.Fatalf("entries = %+v, want ignored directory", resp.Entries)
	}
}

func TestHandleFSBrowse_SortsCaseInsensitivelyAndStably(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"bravo", "Alpha", "charlie", "Beta"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
	tieNames := []string{"Folder", "folder"}
	tieSupported := true
	for _, name := range tieNames {
		if err := os.Mkdir(filepath.Join(dir, name), 0o755); err != nil {
			if os.IsExist(err) {
				tieSupported = false
				break
			}
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}

	var wantTieOrder []string
	if tieSupported {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read input order: %v", err)
		}
		for _, entry := range entries {
			if strings.EqualFold(entry.Name(), tieNames[0]) {
				wantTieOrder = append(wantTieOrder, entry.Name())
			}
		}
	}

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(dir))
	if w.Code != http.StatusOK {
		t.Fatalf("listing: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	var gotTieOrder []string
	for i, entry := range resp.Entries {
		if i > 0 && strings.ToLower(resp.Entries[i-1].Name) > strings.ToLower(entry.Name) {
			t.Fatalf("entries are not case-insensitively sorted: %+v", resp.Entries)
		}
		if strings.EqualFold(entry.Name, tieNames[0]) {
			gotTieOrder = append(gotTieOrder, entry.Name)
		}
	}
	if tieSupported && (len(gotTieOrder) != len(wantTieOrder) || gotTieOrder[0] != wantTieOrder[0] || gotTieOrder[1] != wantTieOrder[1]) {
		t.Fatalf("equal-key order = %v, want stable input order %v", gotTieOrder, wantTieOrder)
	}
}

func TestHandleFSBrowse_TruncatesAtMaximum(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i <= fsListMaxEntries; i++ {
		name := "dir-" + strconv.Itoa(i)
		if err := os.Mkdir(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(dir))
	if w.Code != http.StatusOK {
		t.Fatalf("listing: got %d want 200; body=%s", w.Code, w.Body.String())
	}
	resp := decodeFSBrowseResponse(t, w)
	if len(resp.Entries) != fsListMaxEntries || !resp.Truncated {
		t.Fatalf("entries/truncated = %d/%v, want %d/true", len(resp.Entries), resp.Truncated, fsListMaxEntries)
	}
}

func TestHandleFSBrowse_MissingAndNonDirectoryPaths(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	mustWriteFile(t, file, "file")
	for _, path := range []string{filepath.Join(dir, "missing"), file} {
		t.Run(filepath.Base(path), func(t *testing.T) {
			w := httptest.NewRecorder()
			handleFSBrowse(w, fsBrowseRequest(path))
			if w.Code != http.StatusNotFound {
				t.Errorf("path=%q: got %d want 404; body=%s", path, w.Code, w.Body.String())
			}
		})
	}
}

func TestHandleFSBrowse_UnreadableDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions are not supported by this test on windows")
	}
	dir := filepath.Join(t.TempDir(), "unreadable")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Restore permissions before changing them so cleanup can always read the directory.
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if err := os.Chmod(dir, 0); err != nil {
		t.Fatalf("chmod unreadable: %v", err)
	}

	w := httptest.NewRecorder()
	handleFSBrowse(w, fsBrowseRequest(dir))
	if w.Code == http.StatusOK {
		t.Skip("runner privileges allow reading a mode-000 directory")
	}
	if w.Code != http.StatusNotFound {
		t.Fatalf("unreadable path: got %d want 404; body=%s", w.Code, w.Body.String())
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
