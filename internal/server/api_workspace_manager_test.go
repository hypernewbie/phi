package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/internal/config"
)

// workspaceRequest runs one workspace request against the test server.
func workspaceRequest(t *testing.T, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	switch target {
	case "/api/config/workspaces":
		testServer.handleWorkspaceToggle(rec, req)
	case "/api/config/workspace-roots":
		testServer.handleWorkspaceRoots(rec, req)
	default:
		t.Fatalf("unexpected target %q", target)
	}
	return rec
}

// withStore replaces the package config store, so a test can inject a failing
// writer or an unreadable config without touching the live one.
func withStore(t *testing.T, store *config.Store) {
	t.Helper()
	previous, previousServer := testStore, testServer
	testStore = store
	testServer = New(Options{Config: store, Version: "dev", Commit: "none", Date: "unknown", BuildSource: "source"})
	t.Cleanup(func() { testStore, testServer = previous, previousServer })
}

// seedConfig writes a config file with the given TOML body.
func seedConfig(t *testing.T, body string) string {
	t.Helper()
	path := withTempConfig(t)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWorkspaceToggleBatch(t *testing.T) {
	seedConfig(t, "workspaces = [\"/one\"]\n")

	// POST appends in request order and never duplicates an existing entry.
	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspaces",
		`{"paths":["/two","/one","/three","/two"]}`); rec.Code != http.StatusOK {
		t.Fatalf("batch POST status %d: %s", rec.Code, rec.Body.String())
	}
	if got, want := testServer.loadConfig().Workspaces, []string{"/one", "/two", "/three"}; !equalStrings(got, want) {
		t.Fatalf("after batch POST: got %v, want %v", got, want)
	}

	// DELETE removes only the named paths, keeps the rest in order, and is
	// idempotent on a repeat request.
	if rec := workspaceRequest(t, http.MethodDelete, "/api/config/workspaces",
		`{"paths":["/one","/missing"]}`); rec.Code != http.StatusOK {
		t.Fatalf("batch DELETE status %d: %s", rec.Code, rec.Body.String())
	}
	if got, want := testServer.loadConfig().Workspaces, []string{"/two", "/three"}; !equalStrings(got, want) {
		t.Fatalf("after batch DELETE: got %v, want %v", got, want)
	}
	if rec := workspaceRequest(t, http.MethodDelete, "/api/config/workspaces",
		`{"paths":["/one"]}`); rec.Code != http.StatusOK {
		t.Fatalf("repeat batch DELETE status %d: %s", rec.Code, rec.Body.String())
	}
	if got, want := testServer.loadConfig().Workspaces, []string{"/two", "/three"}; !equalStrings(got, want) {
		t.Fatalf("repeat DELETE changed the list: got %v, want %v", got, want)
	}
}

// The pre-existing single-path contract stays byte-for-byte compatible: same
// bodies, same 200, same resulting list. External clients depend on it.
func TestWorkspaceToggleSinglePathStillWorks(t *testing.T) {
	seedConfig(t, "workspaces = []\n")

	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspaces", `{"path":"/solo"}`); rec.Code != http.StatusOK {
		t.Fatalf("single POST status %d: %s", rec.Code, rec.Body.String())
	}
	if got, want := testServer.loadConfig().Workspaces, []string{"/solo"}; !equalStrings(got, want) {
		t.Fatalf("after single POST: got %v, want %v", got, want)
	}
	if rec := workspaceRequest(t, http.MethodDelete, "/api/config/workspaces", `{"path":"/solo"}`); rec.Code != http.StatusOK {
		t.Fatalf("single DELETE status %d: %s", rec.Code, rec.Body.String())
	}
	if got := testServer.loadConfig().Workspaces; len(got) != 0 {
		t.Fatalf("after single DELETE: got %v, want empty", got)
	}
}

func TestWorkspaceTogglePreservesDirectoryWhitespace(t *testing.T) {
	for _, body := range []string{`{"path":"/code/project "}`, `{"paths":["/code/project "]}`} {
		seedConfig(t, "workspaces = []\n")
		if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspaces", body); rec.Code != http.StatusOK {
			t.Fatalf("POST: %d %s", rec.Code, rec.Body.String())
		}
		if got := testServer.loadConfig().Workspaces; !equalStrings(got, []string{"/code/project "}) {
			t.Fatalf("directory name changed: %q", got)
		}
		if rec := workspaceRequest(t, http.MethodDelete, "/api/config/workspaces", body); rec.Code != http.StatusOK {
			t.Fatalf("DELETE: %d %s", rec.Code, rec.Body.String())
		}
		if got := testServer.loadConfig().Workspaces; len(got) != 0 {
			t.Fatalf("directory could not be removed: %q", got)
		}
	}
}

func TestWorkspaceToggleRejectsInvalidBodies(t *testing.T) {
	path := seedConfig(t, "workspaces = [\"/keep\"]\n")

	cases := []struct {
		name string
		body string
	}{
		{"empty object", `{}`},
		{"empty batch", `{"paths":[]}`},
		{"blank element", `{"paths":["/new",""]}`},
		{"both forms", `{"path":"/a","paths":["/b"]}`},
		{"empty batch mixed with path", `{"path":"/a","paths":[]}`},
		{"blank path mixed with batch", `{"path":"","paths":["/b"]}`},
		{"whitespace element", `{"paths":["/new","   "]}`},
		{"malformed json", `{"paths":`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := workspaceRequest(t, http.MethodPost, "/api/config/workspaces", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400", rec.Code)
			}
			if got, want := testServer.loadConfig().Workspaces, []string{"/keep"}; !equalStrings(got, want) {
				t.Fatalf("rejected request changed the list: got %v, want %v", got, want)
			}
			body, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(body), "/new") || strings.Contains(string(body), "/b") {
				t.Fatalf("rejected request reached disk: %s", body)
			}
		})
	}

	if rec := workspaceRequest(t, http.MethodGet, "/api/config/workspaces", ``); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status %d, want 405", rec.Code)
	}
}

// A root groups live child directories for the manager. It is configuration
// only: it must never appear in, or expand into, the workspace list.
func TestWorkspaceRootsNeverTouchWorkspaces(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "project")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	path := seedConfig(t, "workspaces = [\"/keep\"]\n")

	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots",
		`{"path":"`+root+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("root POST status %d: %s", rec.Code, rec.Body.String())
	}
	cfg := testServer.loadConfig()
	if got, want := cfg.WorkspaceRoots, []string{root}; !equalStrings(got, want) {
		t.Fatalf("roots: got %v, want %v", got, want)
	}
	if got, want := cfg.Workspaces, []string{"/keep"}; !equalStrings(got, want) {
		t.Fatalf("root POST changed workspaces: got %v, want %v", got, want)
	}

	// Adding the same root twice is a no-op, not a duplicate entry.
	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots",
		`{"path":"`+root+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("repeat root POST status %d: %s", rec.Code, rec.Body.String())
	}
	if got := testServer.loadConfig().WorkspaceRoots; len(got) != 1 {
		t.Fatalf("duplicate root stored: %v", got)
	}

	// The config payload carries the roots so the manager can render them.
	rec := httptest.NewRecorder()
	testServer.handleConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("config status %d", rec.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	roots, ok := payload["workspace_roots"].([]any)
	if !ok || len(roots) != 1 || roots[0] != root {
		t.Fatalf("config payload roots: %#v", payload["workspace_roots"])
	}
	if workspaces, ok := payload["workspaces"].([]any); !ok || len(workspaces) != 1 {
		t.Fatalf("config payload workspaces: %#v", payload["workspaces"])
	}

	// Deletion removes the root and still leaves workspaces alone.
	if rec := workspaceRequest(t, http.MethodDelete, "/api/config/workspace-roots",
		`{"path":"`+root+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("root DELETE status %d: %s", rec.Code, rec.Body.String())
	}
	cfg = testServer.loadConfig()
	if len(cfg.WorkspaceRoots) != 0 {
		t.Fatalf("roots after delete: %v", cfg.WorkspaceRoots)
	}
	if got, want := cfg.Workspaces, []string{"/keep"}; !equalStrings(got, want) {
		t.Fatalf("root DELETE changed workspaces: got %v, want %v", got, want)
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), child) {
		t.Fatalf("root child reached the config file: %s", body)
	}
}

// A root must point at a directory that exists, but a root whose directory has
// since vanished stays removable.
func TestWorkspaceRootsRejectInvalidDirectories(t *testing.T) {
	seedConfig(t, "workspaces = []\n")
	missing := filepath.Join(t.TempDir(), "gone")
	file := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{missing, file} {
		if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots",
			`{"path":"`+path+`"}`); rec.Code != http.StatusBadRequest {
			t.Fatalf("POST %q status %d, want 400", path, rec.Code)
		}
	}
	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots",
		`{"path":"relative/dir"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("relative root status %d, want 400", rec.Code)
	}
	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots", `{}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing root status %d, want 400", rec.Code)
	}
	if got := testServer.loadConfig().WorkspaceRoots; len(got) != 0 {
		t.Fatalf("invalid roots were stored: %v", got)
	}

	root := t.TempDir()
	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots",
		`{"path":"`+root+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("root POST status %d: %s", rec.Code, rec.Body.String())
	}
	// A "~" root is stored expanded, so the client can compare it with the
	// listing it reads back. The home directory is redirected so the test
	// never touches the real one.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if err := os.Mkdir(filepath.Join(home, "phi-root"), 0o755); err != nil {
		t.Fatal(err)
	}
	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots",
		`{"path":"~/phi-root"}`); rec.Code != http.StatusOK {
		t.Fatalf("tilde root POST status %d: %s", rec.Code, rec.Body.String())
	}
	if got := testServer.loadConfig().WorkspaceRoots; len(got) != 2 ||
		got[1] != filepath.Join(home, "phi-root") {
		t.Fatalf("tilde root was not expanded: %v", got)
	}
	if rec := workspaceRequest(t, http.MethodDelete, "/api/config/workspace-roots",
		`{"path":"~/phi-root"}`); rec.Code != http.StatusOK {
		t.Fatalf("tilde root DELETE status %d: %s", rec.Code, rec.Body.String())
	}
	if got := testServer.loadConfig().WorkspaceRoots; len(got) != 1 || got[0] != root {
		t.Fatalf("tilde root survived DELETE: %v", got)
	}
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if rec := workspaceRequest(t, http.MethodDelete, "/api/config/workspace-roots",
		`{"path":"`+root+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("stale root DELETE status %d: %s", rec.Code, rec.Body.String())
	}
	if got := testServer.loadConfig().WorkspaceRoots; len(got) != 0 {
		t.Fatalf("stale root survived DELETE: %v", got)
	}
}

// An old config without the key must report an empty list, not null, so the
// manager can render without a special case.
func TestConfigPayloadDefaultsEmptyRoots(t *testing.T) {
	seedConfig(t, "theme_color = \"amber\"\n")

	rec := httptest.NewRecorder()
	testServer.handleConfig(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("config status %d", rec.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	roots, ok := payload["workspace_roots"].([]any)
	if !ok || len(roots) != 0 {
		t.Fatalf("workspace_roots: %#v, want []", payload["workspace_roots"])
	}
}

// A write failure must surface as 500 and leave the stored config untouched;
// silently reporting success would let the UI show state the server never saved.
func TestWorkspaceMutationsReportWriteFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	seed := "workspaces = [\"/keep\"]\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	withStore(t, config.NewStore(config.Paths{Primary: path},
		func(string, []byte, os.FileMode) error { return errors.New("disk full") }))

	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspaces",
		`{"paths":["/new"]}`); rec.Code != http.StatusInternalServerError {
		t.Fatalf("batch POST status %d, want 500", rec.Code)
	}
	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots",
		`{"path":"`+dir+`"}`); rec.Code != http.StatusInternalServerError {
		t.Fatalf("root POST status %d, want 500", rec.Code)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != seed {
		t.Fatalf("failed write replaced the config: %q", got)
	}
}

// An unreadable config is an error, not an empty config. Reporting 200 would
// write a fresh file over whatever the user actually has.
func TestWorkspaceMutationsReportReadFailure(t *testing.T) {
	malformed := "workspaces = [\n"
	path := seedConfig(t, malformed)

	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspaces",
		`{"paths":["/new"]}`); rec.Code != http.StatusInternalServerError {
		t.Fatalf("batch POST status %d, want 500", rec.Code)
	}
	if rec := workspaceRequest(t, http.MethodPost, "/api/config/workspace-roots",
		`{"path":"`+t.TempDir()+`"}`); rec.Code != http.StatusInternalServerError {
		t.Fatalf("root POST status %d, want 500", rec.Code)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != malformed {
		t.Fatalf("unreadable config was replaced: %q", got)
	}
}

func equalStrings(got, want []string) bool {
	return slices.Equal(got, want)
}
