package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/pty"
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
	cfg.ModelPresets = ModelPresetsMap{"pi": {"test/model-a", "test/model-b"}}
	cfg.QuickCommands = []QuickCommand{{Name: "foo", Command: "bar"}}
	cfg.MarkdownDirs = []string{"./notes"}
	saveConfig(cfg)

	got := loadConfig()
	if got.ThemeColor != "amber" {
		t.Errorf("ThemeColor: want amber, got %q", got.ThemeColor)
	}
	if len(got.ModelPresets["pi"]) != 2 || got.ModelPresets["pi"][0] != "test/model-a" {
		t.Errorf("ModelPresets round-trip failed: %v", got.ModelPresets)
	}
	if len(got.QuickCommands) != 1 || got.QuickCommands[0].Name != "foo" {
		t.Errorf("QuickCommands round-trip failed: %v", got.QuickCommands)
	}
	if len(got.MarkdownDirs) != 1 || got.MarkdownDirs[0] != "./notes" {
		t.Errorf("MarkdownDirs round-trip failed: %v", got.MarkdownDirs)
	}
}

func TestModelPresets_BackwardCompatibilityAndDefaults(t *testing.T) {
	// JSON payload in legacy list format
	legacyJSON := `{"model_presets": ["test-model-1", "test-model-2"]}`

	var cfg Config
	err := json.Unmarshal([]byte(legacyJSON), &cfg)
	if err != nil {
		t.Fatalf("failed to unmarshal legacy config: %v", err)
	}

	// Verify legacy models migrated under "pi"
	piModels := cfg.ModelPresets["pi"]
	if len(piModels) != 2 || piModels[0] != "test-model-1" || piModels[1] != "test-model-2" {
		t.Errorf("expected legacy presets to migrate to 'pi', got %v", cfg.ModelPresets)
	}

	// Trigger defaults merging helper
	cfg.ModelPresets = ensureModelPresetDefaults(cfg.ModelPresets)

	// Verify defaults merged for other backends
	opencodeModels := cfg.ModelPresets["opencode"]
	if len(opencodeModels) != 1 || opencodeModels[0] != "opencode/big-pickle" {
		t.Errorf("expected 'opencode' default 'opencode/big-pickle', got %v", opencodeModels)
	}

	claudeModels := cfg.ModelPresets["claude"]
	if len(claudeModels) == 0 || claudeModels[0] != "claude-sonnet-4-6" {
		t.Errorf("expected 'claude' defaults populated, got %v", claudeModels)
	}

	// Test mapping format unmarshal works natively too
	mapJSON := `{"model_presets": {"opencode": ["custom-pickle"], "pi": ["pi-model"]}}`
	var mapCfg Config
	err = json.Unmarshal([]byte(mapJSON), &mapCfg)
	if err != nil {
		t.Fatalf("failed to unmarshal map config: %v", err)
	}

	if mapCfg.ModelPresets["opencode"][0] != "custom-pickle" || mapCfg.ModelPresets["pi"][0] != "pi-model" {
		t.Errorf("expected map unmarshal to load presets directly, got %v", mapCfg.ModelPresets)
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

// ─── API Route Tests (Phase 3) ────────────────────────────────────────────────

func TestHandleGetCoders(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	w := httptest.NewRecorder()
	handleGetCoders(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var registry map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&registry); err != nil {
		t.Fatalf("Failed to decode registry response: %v", err)
	}

	// We must ensure that our default coders are all present in the returned JSON.
	for _, id := range []string{"opencode", "claude", "agy", "pi", "bash", "pwsh"} {
		if _, ok := registry[id]; !ok {
			t.Errorf("Expected registry to contain coder preset %q", id)
		}
	}
}

func testMainShell() (string, []string) {
	if runtime.GOOS == "windows" {
		return "pwsh", []string{"-NoLogo", "-NoProfile", "-NonInteractive"}
	}
	return "bash", []string{"--norc", "--noprofile"}
}

func TestHandleFallback_Pinning(t *testing.T) {
	// Re-initialise the global manager to ensure a clean state.
	ptyManager = pty.NewManager()
	shell, args := testMainShell()

	inst, err := ptyManager.Spawn("", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY for pinning test: %v", err)
	}
	defer func() {
		_ = ptyManager.Kill(inst.ID)
	}()

	// Verify posting to a non-existent terminal returns 404.
	reqNotFound := httptest.NewRequest(http.MethodPost, "/api/terminals/non-existent-id/pin", strings.NewReader(`{"pinned":true}`))
	wNotFound := httptest.NewRecorder()
	handleFallback(wNotFound, reqNotFound)
	if wNotFound.Code != http.StatusNotFound {
		t.Errorf("Expected 404 for non-existent terminal pinning, got %d", wNotFound.Code)
	}

	// Verify posting invalid JSON returns 400.
	reqBadJSON := httptest.NewRequest(http.MethodPost, "/api/terminals/"+inst.ID+"/pin", strings.NewReader(`{"pinned":`))
	wBadJSON := httptest.NewRecorder()
	handleFallback(wBadJSON, reqBadJSON)
	if wBadJSON.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for malformed JSON request, got %d", wBadJSON.Code)
	}

	// Verify successful pinning returns 200.
	reqPin := httptest.NewRequest(http.MethodPost, "/api/terminals/"+inst.ID+"/pin", strings.NewReader(`{"pinned":true}`))
	wPin := httptest.NewRecorder()
	handleFallback(wPin, reqPin)
	if wPin.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for valid pinning request, got %d", wPin.Code)
	}

	if !inst.Pinned {
		t.Error("Expected terminal instance to be pinned in the manager")
	}

	// Verify successful unpinning returns 200.
	reqUnpin := httptest.NewRequest(http.MethodPost, "/api/terminals/"+inst.ID+"/pin", strings.NewReader(`{"pinned":false}`))
	wUnpin := httptest.NewRecorder()
	handleFallback(wUnpin, reqUnpin)
	if wUnpin.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for valid unpinning request, got %d", wUnpin.Code)
	}

	if inst.Pinned {
		t.Error("Expected terminal instance to be unpinned in the manager")
	}
}

func TestHandleFallback_Delete(t *testing.T) {
	ptyManager = pty.NewManager()
	shell, args := testMainShell()

	inst, err := ptyManager.Spawn("", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY for delete test: %v", err)
	}

	// Verify deleting non-existent terminal returns 404.
	reqNotFound := httptest.NewRequest(http.MethodDelete, "/api/terminals/non-existent-id", nil)
	wNotFound := httptest.NewRecorder()
	handleFallback(wNotFound, reqNotFound)
	if wNotFound.Code != http.StatusNotFound {
		t.Errorf("Expected 404 for non-existent terminal deletion, got %d", wNotFound.Code)
	}

	// Verify successful deletion returns 200 and cleans up the terminal.
	reqDelete := httptest.NewRequest(http.MethodDelete, "/api/terminals/"+inst.ID, nil)
	wDelete := httptest.NewRecorder()
	handleFallback(wDelete, reqDelete)
	if wDelete.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for valid deletion request, got %d", wDelete.Code)
	}

	_, found := ptyManager.Get(inst.ID)
	if found {
		t.Error("Expected PTY instance to be removed from manager registry after delete request")
	}
}

func TestHandleRawDiff(t *testing.T) {
	// Create a temporary directory that represents our Git workspace
	tempDir := t.TempDir()

	// Initialise a new Git repository
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = tempDir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git %v failed: %v", args, err)
		}
	}

	runGit("init")
	runGit("config", "user.name", "Test User")
	runGit("config", "user.email", "test@example.com")

	// Create and commit a base file with multiple lines
	filePath := filepath.Join(tempDir, "file.txt")
	lines := []string{
		"line 1",
		"line 2",
		"line 3",
		"line 4",
		"line 5",
		"line 6",
		"line 7",
		"line 8",
		"line 9",
		"line 10",
	}
	err := os.WriteFile(filePath, []byte(strings.Join(lines, "\n")+"\n"), 0644)
	if err != nil {
		t.Fatalf("write file: %v", err)
	}

	runGit("add", "file.txt")
	runGit("commit", "-m", "initial commit")

	// Modify the file at line 5
	lines[4] = "line 5 modified"
	err = os.WriteFile(filePath, []byte(strings.Join(lines, "\n")+"\n"), 0644)
	if err != nil {
		t.Fatalf("write file modification: %v", err)
	}

	// Test raw-diff of unstaged changes with default context (3 lines)
	req := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir+"&context=3", nil)
	w := httptest.NewRecorder()
	handleRawDiff(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	body := w.Body.String()
	if !strings.Contains(body, "-line 5") || !strings.Contains(body, "+line 5 modified") {
		t.Errorf("Diff body does not contain expected changes: %s", body)
	}

	// The diff should contain line 2 but not line 10 under U3 (since line 5 is modified, lines 2, 3, 4 and 6, 7, 8 are context)
	if strings.Contains(body, "line 10") {
		t.Errorf("Diff body should not contain line 10 under context=3, got: %s", body)
	}

	// Test raw-diff of unstaged changes with extended context (30 lines)
	req30 := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir+"&context=30", nil)
	w30 := httptest.NewRecorder()
	handleRawDiff(w30, req30)

	if w30.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w30.Code)
	}

	body30 := w30.Body.String()
	if !strings.Contains(body30, "line 1") {
		t.Errorf("Diff body should contain line 1 under context=30, got: %s", body30)
	}
}


