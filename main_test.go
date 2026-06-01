package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withTempConfig points the config system at a fresh temp file for the duration
// of the test, then restores the original override.
func withTempConfig(t *testing.T) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "phi-test-config-*.json")
	if err != nil {
		t.Fatalf("create temp config: %v", err)
	}
	f.Close()
	orig := testConfigPath
	testConfigPath = f.Name()
	t.Cleanup(func() { testConfigPath = orig })
	return f.Name()
}

// ─── Config defaults ──────────────────────────────────────────────────────────

func TestLoadConfig_DefaultsOnEmptyFile(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()

	if cfg.ThemeColor != "purple" {
		t.Errorf("ThemeColor default: want purple, got %q", cfg.ThemeColor)
	}
	if cfg.Workspaces == nil {
		t.Error("Workspaces should not be nil")
	}
	if len(cfg.ModelPresets) == 0 {
		t.Error("ModelPresets should have defaults")
	}
	if len(cfg.QuickCommands) == 0 {
		t.Error("QuickCommands should have defaults")
	}
	if len(cfg.MarkdownDirs) == 0 {
		t.Error("MarkdownDirs should have defaults")
	}
}

func TestLoadConfig_DefaultQuickCommands(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()

	names := map[string]bool{}
	for _, qc := range cfg.QuickCommands {
		names[qc.Name] = true
	}
	for _, want := range []string{"status", "diff", "commit"} {
		if !names[want] {
			t.Errorf("QuickCommands missing default %q", want)
		}
	}
}

func TestLoadConfig_DefaultMarkdownDirs(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()

	found := false
	for _, d := range cfg.MarkdownDirs {
		if d == "." {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("MarkdownDirs should include '.', got %v", cfg.MarkdownDirs)
	}
}

func TestSaveAndLoadConfig_RoundTrip(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()
	cfg.ThemeColor = "amber"
	cfg.ModelPresets = []string{"test/model-a", "test/model-b"}
	cfg.QuickCommands = []QuickCommand{{Name: "foo", Command: "bar"}}
	cfg.MarkdownDirs = []string{"./notes"}
	saveConfig(cfg)

	got := loadConfig()
	if got.ThemeColor != "amber" {
		t.Errorf("ThemeColor: want amber, got %q", got.ThemeColor)
	}
	if len(got.ModelPresets) != 2 || got.ModelPresets[0] != "test/model-a" {
		t.Errorf("ModelPresets round-trip failed: %v", got.ModelPresets)
	}
	if len(got.QuickCommands) != 1 || got.QuickCommands[0].Name != "foo" {
		t.Errorf("QuickCommands round-trip failed: %v", got.QuickCommands)
	}
	if len(got.MarkdownDirs) != 1 || got.MarkdownDirs[0] != "./notes" {
		t.Errorf("MarkdownDirs round-trip failed: %v", got.MarkdownDirs)
	}
}

// ─── GET /api/config ─────────────────────────────────────────────────────────

func TestHandleConfig_Fields(t *testing.T) {
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	handleConfig(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", w.Code)
	}
	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, field := range []string{"workspaces", "theme_color", "model_presets", "quick_commands", "markdown_dirs"} {
		if _, ok := body[field]; !ok {
			t.Errorf("response missing field %q", field)
		}
	}
}

// ─── Quick commands CRUD ──────────────────────────────────────────────────────

func TestHandleQuickCommands_AddAndDelete(t *testing.T) {
	withTempConfig(t)

	// POST — add
	body := strings.NewReader(`{"name":"mytest","command":"ls -la"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/config/quick-commands", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleQuickCommands(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST status: want 200, got %d — %s", w.Code, w.Body.String())
	}

	cfg := loadConfig()
	found := false
	for _, qc := range cfg.QuickCommands {
		if qc.Name == "mytest" && qc.Command == "ls -la" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("quick command not saved; commands: %v", cfg.QuickCommands)
	}

	// DELETE — remove
	body = strings.NewReader(`{"name":"mytest"}`)
	req = httptest.NewRequest(http.MethodDelete, "/api/config/quick-commands", body)
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	handleQuickCommands(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE status: want 200, got %d", w.Code)
	}

	cfg = loadConfig()
	for _, qc := range cfg.QuickCommands {
		if qc.Name == "mytest" {
			t.Error("quick command still present after DELETE")
		}
	}
}

func TestHandleQuickCommands_UpdateExisting(t *testing.T) {
	withTempConfig(t)

	post := func(name, command string) {
		body := strings.NewReader(`{"name":"` + name + `","command":"` + command + `"}`)
		req := httptest.NewRequest(http.MethodPost, "/api/config/quick-commands", body)
		req.Header.Set("Content-Type", "application/json")
		handleQuickCommands(httptest.NewRecorder(), req)
	}

	post("upd", "original")
	post("upd", "updated") // same name → should update

	cfg := loadConfig()
	count := 0
	for _, qc := range cfg.QuickCommands {
		if qc.Name == "upd" {
			count++
			if qc.Command != "updated" {
				t.Errorf("command not updated: got %q", qc.Command)
			}
		}
	}
	if count != 1 {
		t.Errorf("expected exactly 1 entry named 'upd', got %d", count)
	}
}

// ─── Markdown dirs CRUD ───────────────────────────────────────────────────────

func TestHandleMarkdownDirs_AddAndDelete(t *testing.T) {
	withTempConfig(t)

	// Remove defaults so our test dir is the only one
	cfg := loadConfig()
	cfg.MarkdownDirs = []string{}
	saveConfig(cfg)

	body := strings.NewReader(`{"dir":"./testdocs"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/config/markdown-dirs", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleMarkdownDirs(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST status: %d", w.Code)
	}

	cfg = loadConfig()
	if len(cfg.MarkdownDirs) != 1 || cfg.MarkdownDirs[0] != "./testdocs" {
		t.Errorf("MarkdownDirs not updated: %v", cfg.MarkdownDirs)
	}

	body = strings.NewReader(`{"dir":"./testdocs"}`)
	req = httptest.NewRequest(http.MethodDelete, "/api/config/markdown-dirs", body)
	req.Header.Set("Content-Type", "application/json")
	handleMarkdownDirs(httptest.NewRecorder(), req)

	cfg = loadConfig()
	for _, d := range cfg.MarkdownDirs {
		if d == "./testdocs" {
			t.Error("dir still present after DELETE")
		}
	}
}

// ─── GET /api/markdown/files ──────────────────────────────────────────────────

func TestHandleMarkdownFiles_EmptyDir(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()

	cfg := loadConfig()
	cfg.MarkdownDirs = []string{dir}
	saveConfig(cfg)

	req := httptest.NewRequest(http.MethodGet, "/api/markdown/files?cwd="+dir, nil)
	w := httptest.NewRecorder()
	handleMarkdownFiles(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: %d", w.Code)
	}
	var files []MDFileEntry
	if err := json.NewDecoder(w.Body).Decode(&files); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("expected 0 files, got %d", len(files))
	}
}

func TestHandleMarkdownFiles_FindsMDFiles(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()

	// Create some files
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Hello"), 0644)
	os.WriteFile(filepath.Join(dir, "notes.md"), []byte("## Notes"), 0644)
	os.WriteFile(filepath.Join(dir, "skip.txt"), []byte("not md"), 0644)

	cfg := loadConfig()
	cfg.MarkdownDirs = []string{dir}
	saveConfig(cfg)

	req := httptest.NewRequest(http.MethodGet, "/api/markdown/files?cwd="+dir, nil)
	w := httptest.NewRecorder()
	handleMarkdownFiles(w, req)

	var files []MDFileEntry
	json.NewDecoder(w.Body).Decode(&files)

	if len(files) != 2 {
		t.Errorf("expected 2 .md files, got %d: %v", len(files), files)
	}
	for _, f := range files {
		if !strings.HasSuffix(f.Name, ".md") {
			t.Errorf("non-.md file in results: %s", f.Name)
		}
	}
}

func TestHandleMarkdownFiles_NonExistentDirSkipped(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()

	cfg := loadConfig()
	cfg.MarkdownDirs = []string{"/does/not/exist/at/all", dir}
	saveConfig(cfg)

	req := httptest.NewRequest(http.MethodGet, "/api/markdown/files?cwd="+dir, nil)
	w := httptest.NewRecorder()
	handleMarkdownFiles(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("non-existent dir should not cause error, got status %d", w.Code)
	}
}

// ─── GET /api/markdown/file ───────────────────────────────────────────────────

func TestHandleMarkdownFile_Success(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	content := "# Test\nHello world"
	mdPath := filepath.Join(dir, "test.md")
	os.WriteFile(mdPath, []byte(content), 0644)

	cfg := loadConfig()
	cfg.MarkdownDirs = []string{dir}
	saveConfig(cfg)

	req := httptest.NewRequest(http.MethodGet,
		"/api/markdown/file?path="+mdPath+"&cwd="+dir, nil)
	w := httptest.NewRecorder()
	handleMarkdownFile(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: %d — %s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != content {
		t.Errorf("content mismatch: got %q", got)
	}
}

func TestHandleMarkdownFile_RejectsNonMD(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	cfg := loadConfig()
	cfg.MarkdownDirs = []string{dir}
	saveConfig(cfg)

	badPath := filepath.Join(dir, "secrets.txt")
	os.WriteFile(badPath, []byte("secret"), 0644)

	req := httptest.NewRequest(http.MethodGet,
		"/api/markdown/file?path="+badPath+"&cwd="+dir, nil)
	w := httptest.NewRecorder()
	handleMarkdownFile(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for non-.md file, got %d", w.Code)
	}
}

func TestHandleMarkdownFile_RejectsPathOutsideAllowedDirs(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	cfg := loadConfig()
	cfg.MarkdownDirs = []string{dir}
	saveConfig(cfg)

	// A file that is an .md file but NOT under any configured dir
	outsidePath := filepath.Join(t.TempDir(), "escape.md")
	os.WriteFile(outsidePath, []byte("evil"), 0644)

	req := httptest.NewRequest(http.MethodGet,
		"/api/markdown/file?path="+outsidePath+"&cwd="+dir, nil)
	w := httptest.NewRecorder()
	handleMarkdownFile(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for path outside allowed dirs, got %d", w.Code)
	}
}
