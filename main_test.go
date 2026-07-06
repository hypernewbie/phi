package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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

	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/session"
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

func TestLoadConfig_DefaultTerminalCommands(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()

	names := map[string]bool{}
	for _, tc := range cfg.TerminalCommands {
		names[tc.Name] = true
	}
	for _, want := range []string{"vim", "nvim", "git push", "git pull --rebase"} {
		if !names[want] {
			t.Errorf("TerminalCommands missing default %q", want)
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
	// use_existing_terminal_tab is always present in response (even when
	// false — the field's zero value is the documented default).
	if _, ok := body["use_existing_terminal_tab"]; !ok {
		t.Errorf("response missing field %q", "use_existing_terminal_tab")
	}
}

func TestUseExistingTerminalTab_DefaultIsFalse(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()
	if cfg.UseExistingTerminalTab {
		t.Errorf("UseExistingTerminalTab default: want false, got true")
	}
}

func TestUseExistingTerminalTab_StaysFalseOnLegacyConfig(t *testing.T) {
	// Simulate a config file from a previous version that does NOT contain
	// the use_existing_terminal_tab field. Backwards compatibility requires
	// the field to default to false after load.
	configPath := withTempConfig(t)
	legacy := `{
		"workspaces": ["/tmp/legacy"],
		"theme_color": "amber",
		"quick_commands": [],
		"terminal_commands": [],
		"markdown_dirs": []
	}`
	if err := os.WriteFile(configPath, []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy config: %v", err)
	}

	cfg := loadConfig()
	if cfg.UseExistingTerminalTab {
		t.Errorf("legacy config: UseExistingTerminalTab should default to false, got true")
	}
}

func TestHandleUseExistingTerminalTab_Toggle(t *testing.T) {
	withTempConfig(t)

	// Initial GET: field is false
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	handleConfig(w, req)
	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode initial: %v", err)
	}
	if enabled, _ := body["use_existing_terminal_tab"].(bool); enabled {
		t.Errorf("initial use_existing_terminal_tab: want false, got true")
	}

	// POST: enable
	body1 := strings.NewReader(`{"enabled":true}`)
	req1 := httptest.NewRequest(http.MethodPost, "/api/config/use-existing-terminal-tab", body1)
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	handleUseExistingTerminalTab(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("POST status: want 200, got %d — %s", w1.Code, w1.Body.String())
	}

	// Verify persisted to disk
	cfg := loadConfig()
	if !cfg.UseExistingTerminalTab {
		t.Errorf("after POST enabled=true, config still false")
	}

	// POST: disable
	body2 := strings.NewReader(`{"enabled":false}`)
	req2 := httptest.NewRequest(http.MethodPost, "/api/config/use-existing-terminal-tab", body2)
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	handleUseExistingTerminalTab(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("POST disable status: want 200, got %d", w2.Code)
	}
	cfg = loadConfig()
	if cfg.UseExistingTerminalTab {
		t.Errorf("after POST enabled=false, config still true")
	}
}

func TestHandleUseExistingTerminalTab_RejectsWrongMethod(t *testing.T) {
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/api/config/use-existing-terminal-tab", nil)
	w := httptest.NewRecorder()
	handleUseExistingTerminalTab(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET status: want 405, got %d", w.Code)
	}
}

// ─── Clipboard handler ─────────────────────────────────────────────────────────────

func TestHandleGetClipboard_NoPTYManager(t *testing.T) {
	// Without a ?pane= query parameter, the handler should not panic even
	// when ptyManager is nil (which is the case in unit tests that don't
	// initialize it). The response should have empty=true and source=system.
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/api/clipboard", nil)
	w := httptest.NewRecorder()
	handleGetClipboard(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d — %s", w.Code, w.Body.String())
	}
	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, field := range []string{"text", "empty", "source"} {
		if _, ok := body[field]; !ok {
			t.Errorf("response missing field %q", field)
		}
	}
	// Without an active pane query, source should default to "system"
	if src, _ := body["source"].(string); src != "system" {
		t.Errorf("source: want %q, got %q", "system", src)
	}
}

func TestHandleGetClipboard_PaneWithoutManager(t *testing.T) {
	// If ?pane= is provided but no PTY manager exists (test environment),
	// the handler must still respond 200 with empty=true and source=system.
	// It must not panic or 500.
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/api/clipboard?pane=ghost-pane-id", nil)
	w := httptest.NewRecorder()
	handleGetClipboard(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", w.Code)
	}
	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if src, _ := body["source"].(string); src != "system" {
		t.Errorf("source: want %q (no ptyManager so falls back to system), got %q", "system", src)
	}
}

// ─── System stats ───────────────────────────────────────────────────────────────

func TestHandleSystemCPU_ReturnsValidShape(t *testing.T) {
	// Warm up the sampler first so we get a real (non-zero-initial) value.
	_, _ = cpuSampler.Sample(context.Background())

	req := httptest.NewRequest(http.MethodGet, "/api/system/cpu", nil)
	w := httptest.NewRecorder()
	handleSystemCPU(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d — %s", w.Code, w.Body.String())
	}
	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, field := range []string{"cpu", "timestamp"} {
		if _, ok := body[field]; !ok {
			t.Errorf("response missing field %q", field)
		}
	}
	cpu, ok := body["cpu"].(float64)
	if !ok {
		t.Fatalf("cpu should be a number, got %T", body["cpu"])
	}
	if cpu < 0 || cpu > 100 {
		t.Errorf("cpu out of range [0, 100]: %v", cpu)
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

func TestHandleTerminalCommands_AddAndDelete(t *testing.T) {
	withTempConfig(t)

	// POST — add
	body := strings.NewReader(`{"name":"mytermtest","command":"vim file.txt"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/config/terminal-commands", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleTerminalCommands(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST status: want 200, got %d — %s", w.Code, w.Body.String())
	}

	cfg := loadConfig()
	found := false
	for _, tc := range cfg.TerminalCommands {
		if tc.Name == "mytermtest" && tc.Command == "vim file.txt" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("terminal command not saved; commands: %v", cfg.TerminalCommands)
	}

	// DELETE — remove
	body = strings.NewReader(`{"name":"mytermtest"}`)
	req = httptest.NewRequest(http.MethodDelete, "/api/config/terminal-commands", body)
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	handleTerminalCommands(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE status: want 200, got %d", w.Code)
	}

	cfg = loadConfig()
	for _, tc := range cfg.TerminalCommands {
		if tc.Name == "mytermtest" {
			t.Error("terminal command still present after DELETE")
		}
	}
}

func TestHandleTerminalCommands_UpdateExisting(t *testing.T) {
	withTempConfig(t)

	post := func(name, command string) {
		body := strings.NewReader(`{"name":"` + name + `","command":"` + command + `"}`)
		req := httptest.NewRequest(http.MethodPost, "/api/config/terminal-commands", body)
		req.Header.Set("Content-Type", "application/json")
		handleTerminalCommands(httptest.NewRecorder(), req)
	}

	post("updterm", "original")
	post("updterm", "updated") // same name → should update

	cfg := loadConfig()
	count := 0
	for _, tc := range cfg.TerminalCommands {
		if tc.Name == "updterm" {
			count++
			if tc.Command != "updated" {
				t.Errorf("terminal command not updated: got %q", tc.Command)
			}
		}
	}
	if count != 1 {
		t.Errorf("expected exactly 1 entry named 'updterm', got %d", count)
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

func TestHandleMarkdownPasteAndDelete(t *testing.T) {
	withTempConfig(t)
	cwd := t.TempDir()
	docsDir := filepath.Join(cwd, "docs")
	if err := os.MkdirAll(docsDir, 0755); err != nil {
		t.Fatalf("mkdir docs: %v", err)
	}

	cfg := loadConfig()
	cfg.MarkdownDirs = []string{"docs"}
	saveConfig(cfg)

	pasteBody := `{"cwd":` + strconv.Quote(cwd) + `,"dir":"docs","name":"notes","content":"# hi\nthere\n"}`
	pasteReq := httptest.NewRequest(http.MethodPost, "/api/markdown/paste", strings.NewReader(pasteBody))
	pasteReq.Header.Set("Content-Type", "application/json")
	pasteW := httptest.NewRecorder()
	handleMarkdownPaste(pasteW, pasteReq)
	if pasteW.Code != http.StatusOK {
		t.Fatalf("paste status: %d body=%s", pasteW.Code, pasteW.Body.String())
	}

	target := filepath.Join(docsDir, "notes.md")
	if data, err := os.ReadFile(target); err != nil || string(data) != "# hi\nthere\n" {
		t.Fatalf("paste file mismatch: err=%v data=%q", err, string(data))
	}

	deleteBody := `{"cwd":` + strconv.Quote(cwd) + `,"path":` + strconv.Quote(target) + `}`
	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/markdown/delete", strings.NewReader(deleteBody))
	deleteReq.Header.Set("Content-Type", "application/json")
	deleteW := httptest.NewRecorder()
	handleMarkdownDelete(deleteW, deleteReq)
	if deleteW.Code != http.StatusOK {
		t.Fatalf("delete status: %d body=%s", deleteW.Code, deleteW.Body.String())
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("expected file deleted, stat err=%v", err)
	}
}

func TestHandleMarkdownCopyAllWorktrees(t *testing.T) {
	withTempConfig(t)
	cwd := t.TempDir()
	runGit := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
		}
	}

	runGit(cwd, "init")
	runGit(cwd, "config", "user.name", "Test User")
	runGit(cwd, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(cwd, "seed.txt"), []byte("seed\n"), 0644); err != nil {
		t.Fatalf("write seed: %v", err)
	}
	runGit(cwd, "add", "seed.txt")
	runGit(cwd, "commit", "-m", "seed")

	otherWt := filepath.Join(t.TempDir(), "wt-other")
	runGit(cwd, "worktree", "add", otherWt, "-b", "wt-other")

	cfg := loadConfig()
	cfg.MarkdownDirs = []string{"docs"}
	saveConfig(cfg)

	sourceDir := filepath.Join(cwd, "docs")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatalf("mkdir source docs: %v", err)
	}
	sourcePath := filepath.Join(sourceDir, "shared.md")
	if err := os.WriteFile(sourcePath, []byte("# shared\n"), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	copyBody := `{"cwd":` + strconv.Quote(cwd) + `,"dir":"docs","path":` + strconv.Quote(sourcePath) + `}`
	copyReq := httptest.NewRequest(http.MethodPost, "/api/markdown/copy-all-worktrees", strings.NewReader(copyBody))
	copyReq.Header.Set("Content-Type", "application/json")
	copyW := httptest.NewRecorder()
	handleMarkdownCopyAllWorktrees(copyW, copyReq)
	if copyW.Code != http.StatusOK {
		t.Fatalf("copy-all status: %d body=%s", copyW.Code, copyW.Body.String())
	}

	targetPath := filepath.Join(otherWt, "docs", "shared.md")
	if data, err := os.ReadFile(targetPath); err != nil || string(data) != "# shared\n" {
		t.Fatalf("copied worktree file mismatch: err=%v data=%q", err, string(data))
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

	// Untracked files should also appear in the unstaged diff output.
	newFilePath := filepath.Join(tempDir, "new_untracked.txt")
	err = os.WriteFile(newFilePath, []byte("brand new\nfile\n"), 0644)
	if err != nil {
		t.Fatalf("write untracked file: %v", err)
	}

	reqUntracked := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir+"&context=3", nil)
	wUntracked := httptest.NewRecorder()
	handleRawDiff(wUntracked, reqUntracked)

	if wUntracked.Code != http.StatusOK {
		t.Fatalf("Expected status 200 for untracked diff, got %d", wUntracked.Code)
	}

	bodyUntracked := wUntracked.Body.String()
	if !strings.Contains(bodyUntracked, "diff --git a/new_untracked.txt b/new_untracked.txt") ||
		!strings.Contains(bodyUntracked, "new file mode 100644") ||
		!strings.Contains(bodyUntracked, "@@ -0,0 +1,2 @@") ||
		!strings.Contains(bodyUntracked, "+brand new") {
		t.Errorf("Untracked file missing pretty patch structure: %s", bodyUntracked)
	}
}

func TestHandleGetWorktreeDirtyStates(t *testing.T) {
	tempDir := t.TempDir()

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

	filePath := filepath.Join(tempDir, "dirty.txt")
	if err := os.WriteFile(filePath, []byte("hi\n"), 0644); err != nil {
		t.Fatalf("write dirty file: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/git/worktree-dirty?cwd="+tempDir, nil)
	w := httptest.NewRecorder()
	handleGetWorktreeDirtyStates(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	var body map[string]bool
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}

	foundDirty := false
	for _, dirty := range body {
		if dirty {
			foundDirty = true
			break
		}
	}
	if !foundDirty {
		t.Fatalf("expected at least one dirty worktree, got %v", body)
	}
}

func TestHandleGetSessionTranscript_Unsupported(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/session-transcript?coder=nonexistent&id=123", nil)
	w := httptest.NewRecorder()
	handleGetSessionTranscript(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400 for unsupported coder, got %d", w.Code)
	}
}

func TestHandleGetSessionTranscript_EmptyPi(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/session-transcript?coder=pi&id=nonexistent&cwd=/tmp/nonexistent", nil)
	w := httptest.NewRecorder()
	handleGetSessionTranscript(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200 for empty transcript, got %d", w.Code)
	}

	var msgs []interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &msgs); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("Expected 0 messages, got %d", len(msgs))
	}
}

func TestHandleProxy_Success(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("Expected method POST, got %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("Expected Authorization bearer token, got %s", r.Header.Get("Authorization"))
		}
		bodyBytes, _ := io.ReadAll(r.Body)
		if string(bodyBytes) != `{"foo":"bar"}` {
			t.Errorf("Expected body '{\"foo\":\"bar\"}', got '%s'", string(bodyBytes))
		}
		w.Header().Set("X-Mock-Header", "hello")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	}))
	defer mockServer.Close()

	reqBody := strings.NewReader(`{"foo":"bar"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/proxy?url="+url.QueryEscape(mockServer.URL), reqBody)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	handleProxy(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}
	if w.Header().Get("X-Mock-Header") != "hello" {
		t.Errorf("Expected header X-Mock-Header to be 'hello', got %s", w.Header().Get("X-Mock-Header"))
	}
	bodyStr := w.Body.String()
	if bodyStr != `{"success":true}` {
		t.Errorf("Expected body '{\"success\":true}', got '%s'", bodyStr)
	}
}

func TestHandleProxy_MissingUrl(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/proxy", nil)
	w := httptest.NewRecorder()
	handleProxy(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400 for missing url, got %d", w.Code)
	}
}

func TestEncodeDecodeConfigData(t *testing.T) {
	type DummyData struct {
		Name string `json:"name"`
		Val  int    `json:"val"`
	}

	orig := DummyData{Name: "testing-dry", Val: 42}
	prefix := "TESTPREFIX"

	encoded, err := encodeConfigData(prefix, orig)
	if err != nil {
		t.Fatalf("encodeConfigData failed: %v", err)
	}

	if !strings.HasPrefix(encoded, prefix+":") {
		t.Errorf("expected prefix %s in encoded string, got %s", prefix, encoded)
	}

	decodedBytes, err := decodeConfigData(encoded, prefix)
	if err != nil {
		t.Fatalf("decodeConfigData failed: %v", err)
	}

	var decoded DummyData
	if err := json.Unmarshal(decodedBytes, &decoded); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if decoded.Name != orig.Name || decoded.Val != orig.Val {
		t.Errorf("decoded data mismatch: got %+v, want %+v", decoded, orig)
	}

	// Test invalid prefix
	_, err = decodeConfigData(encoded, "WRONGPREFIX")
	if err == nil {
		t.Error("expected error decoding with wrong prefix, got nil")
	}

	// Test malformed payload
	_, err = decodeConfigData("TESTPREFIX:hash", prefix)
	if err == nil {
		t.Error("expected error for malformed payload, got nil")
	}

	// Test corrupted payload/hash mismatch
	parts := strings.Split(encoded, ":")
	parts[2] = "YWJj" // base64 for "abc", will mismatch hash
	corrupted := strings.Join(parts, ":")
	_, err = decodeConfigData(corrupted, prefix)
	if err == nil {
		t.Error("expected error for corrupted payload (hash mismatch), got nil")
	}
}

func TestConfigExportImportModelsHandlers(t *testing.T) {
	withTempConfig(t)

	// Set initial config
	cfg := loadConfig()
	cfg.ModelPresets = ModelPresetsMap{"pi": []string{"original-model"}}
	cfg.QuickCommands = []QuickCommand{{Name: "test", Command: "echo 1"}}
	cfg.TerminalCommands = []QuickCommand{{Name: "term", Command: "bash"}}
	saveConfig(cfg)

	// Call export
	reqExport := httptest.NewRequest(http.MethodGet, "/api/config/export-models", nil)
	wExport := httptest.NewRecorder()
	handleConfigExportModels(wExport, reqExport)

	if wExport.Code != http.StatusOK {
		t.Fatalf("export handler failed, code %d", wExport.Code)
	}

	var exportRes struct {
		Config string `json:"config"`
	}
	if err := json.NewDecoder(wExport.Body).Decode(&exportRes); err != nil {
		t.Fatalf("failed to decode export body: %v", err)
	}

	if !strings.HasPrefix(exportRes.Config, "PHIMODELS:") {
		t.Errorf("expected config to start with PHIMODELS:, got %q", exportRes.Config)
	}

	// Update configuration so we can verify import overwrites it
	cfg = loadConfig()
	cfg.ModelPresets = ModelPresetsMap{"pi": []string{"overwritten-model"}}
	cfg.QuickCommands = []QuickCommand{{Name: "test2", Command: "echo 2"}}
	cfg.TerminalCommands = []QuickCommand{{Name: "term-different", Command: "sh"}}
	saveConfig(cfg)

	// Call import with the exported config
	importReqBody, _ := json.Marshal(map[string]string{"config": exportRes.Config})
	reqImport := httptest.NewRequest(http.MethodPost, "/api/config/import-models", strings.NewReader(string(importReqBody)))
	wImport := httptest.NewRecorder()
	handleConfigImportModels(wImport, reqImport)

	if wImport.Code != http.StatusOK {
		t.Fatalf("import handler failed, code %d, body: %s", wImport.Code, wImport.Body.String())
	}

	// Reload config and assert models + quick commands are restored, but terminal commands are UNCHANGED (still have term-different)
	loaded := loadConfig()
	if loaded.ModelPresets["pi"][0] != "original-model" {
		t.Errorf("model presets not restored, got %+v", loaded.ModelPresets)
	}
	if loaded.QuickCommands[0].Name != "test" {
		t.Errorf("quick commands not restored, got %+v", loaded.QuickCommands)
	}
	if loaded.TerminalCommands[0].Name != "term-different" {
		t.Errorf("terminal commands should NOT have been restored/overwritten, got %+v", loaded.TerminalCommands)
	}
}

func TestWorktreeParsingWithSpaces(t *testing.T) {
	// Verify porcelain worktree list output with spaces in path is parsed cleanly
	porcelainOutput := `worktree /home/user/my project path
HEAD 50527dd
branch refs/heads/main

worktree /home/user/my project path/worktree 2
HEAD 999999
branch refs/heads/feature/space test

`
	var worktrees []session.GitWorktree
	var current session.GitWorktree

	for _, line := range strings.Split(porcelainOutput, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			if current.Path != "" {
				worktrees = append(worktrees, current)
				current = session.GitWorktree{}
			}
			continue
		}
		if strings.HasPrefix(line, "worktree ") {
			current.Path = strings.TrimPrefix(line, "worktree ")
		} else if strings.HasPrefix(line, "branch ") {
			ref := strings.TrimPrefix(line, "branch ")
			if idx := strings.LastIndex(ref, "/"); idx >= 0 {
				current.Branch = ref[idx+1:]
			} else {
				current.Branch = ref
			}
		}
	}
	if current.Path != "" {
		worktrees = append(worktrees, current)
	}

	if len(worktrees) != 2 {
		t.Fatalf("expected 2 worktrees, got %d", len(worktrees))
	}
	if worktrees[0].Path != "/home/user/my project path" || worktrees[0].Branch != "main" {
		t.Errorf("worktree[0] mismatch: %+v", worktrees[0])
	}
	if worktrees[1].Path != "/home/user/my project path/worktree 2" || worktrees[1].Branch != "space test" {
		t.Errorf("worktree[1] mismatch: %+v", worktrees[1])
	}
}

func TestWindowsCoderSpawnQuoting(t *testing.T) {
	cases := []struct {
		command string
		args    []string
		want    string
	}{
		{
			command: "pi",
			args:    []string{"--session", "123"},
			want:    "& 'pi' '--session' '123'",
		},
		{
			command: "C:\\Users\\John Smith\\.local\\bin\\pi.cmd",
			args:    []string{"--resume", "abc-123"},
			want:    "& 'C:\\Users\\John Smith\\.local\\bin\\pi.cmd' '--resume' 'abc-123'",
		},
		{
			command: "C:\\path with spaces\\agy.exe",
			args:    []string{"--conversation", "id with spaces"},
			want:    "& 'C:\\path with spaces\\agy.exe' '--conversation' 'id with spaces'",
		},
		{
			command: "C:\\it's a path\\pi",
			args:    []string{"arg'with'quotes"},
			want:    "& 'C:\\it''s a path\\pi' 'arg''with''quotes'",
		},
	}

	for _, tc := range cases {
		var parts []string
		parts = append(parts, fmt.Sprintf("& '%s'", strings.ReplaceAll(tc.command, "'", "''")))
		for _, a := range tc.args {
			parts = append(parts, fmt.Sprintf("'%s'", strings.ReplaceAll(a, "'", "''")))
		}
		got := strings.Join(parts, " ")
		if got != tc.want {
			t.Errorf("quoting mismatch for %s:\n got:  %s\n want: %s", tc.command, got, tc.want)
		}
	}
}

func TestPushoverAPI(t *testing.T) {
	tmpDir := t.TempDir()
	origHome := os.Getenv("USERPROFILE")
	os.Setenv("USERPROFILE", tmpDir)
	defer os.Setenv("USERPROFILE", origHome)

	// GET Pushover config
	reqGet := httptest.NewRequest(http.MethodGet, "/api/config/pushover", nil)
	wGet := httptest.NewRecorder()
	handleGetPushoverConfig(wGet, reqGet)

	if wGet.Code != http.StatusOK {
		t.Fatalf("handleGetPushoverConfig failed: %d", wGet.Code)
	}

	// POST Pushover config
	postBody, _ := json.Marshal(map[string]interface{}{
		"pushover_user_key":  "test_user_key",
		"pushover_app_token": "test_app_token",
		"pushover_enabled":   true,
	})
	reqPost := httptest.NewRequest(http.MethodPost, "/api/config/pushover", strings.NewReader(string(postBody)))
	wPost := httptest.NewRecorder()
	handlePostPushoverConfig(wPost, reqPost)

	if wPost.Code != http.StatusOK {
		t.Fatalf("handlePostPushoverConfig failed: %d", wPost.Code)
	}

	cfg := loadConfig()
	if !cfg.PushoverEnabled || cfg.PushoverUserKey != "test_user_key" || cfg.PushoverAppToken != "test_app_token" {
		t.Errorf("Config mismatch after Pushover POST: %+v", cfg)
	}
}

func TestWebhookAPI(t *testing.T) {
	tmpDir := t.TempDir()
	origHome := os.Getenv("USERPROFILE")
	os.Setenv("USERPROFILE", tmpDir)
	defer os.Setenv("USERPROFILE", origHome)

	// GET Webhook config
	reqGet := httptest.NewRequest(http.MethodGet, "/api/config/webhook", nil)
	wGet := httptest.NewRecorder()
	handleGetWebhookConfig(wGet, reqGet)

	if wGet.Code != http.StatusOK {
		t.Fatalf("handleGetWebhookConfig failed: %d", wGet.Code)
	}

	// POST Webhook config
	postBody, _ := json.Marshal(map[string]interface{}{
		"webhook_url":     "https://api.day.app/test_key/",
		"webhook_enabled": true,
	})
	reqPost := httptest.NewRequest(http.MethodPost, "/api/config/webhook", bytes.NewReader(postBody))
	wPost := httptest.NewRecorder()
	handlePostWebhookConfig(wPost, reqPost)

	if wPost.Code != http.StatusOK {
		t.Fatalf("handlePostWebhookConfig failed: %d", wPost.Code)
	}

	cfg := loadConfig()
	if !cfg.WebhookEnabled || cfg.WebhookURL != "https://api.day.app/test_key/" {
		t.Errorf("Config mismatch after Webhook POST: %+v", cfg)
	}
}

func TestKanbanVaultAPI(t *testing.T) {
	tmpDir := t.TempDir()
	origHome := os.Getenv("USERPROFILE")
	os.Setenv("USERPROFILE", tmpDir)
	defer os.Setenv("USERPROFILE", origHome)

	// POST save password
	postBody, _ := json.Marshal(map[string]string{"password": "my_test_password"})
	reqPost := httptest.NewRequest(http.MethodPost, "/api/config/kanban-vault", strings.NewReader(string(postBody)))
	wPost := httptest.NewRecorder()
	handleKanbanVault(wPost, reqPost)

	if wPost.Code != http.StatusOK {
		t.Fatalf("handleKanbanVault POST failed: %d", wPost.Code)
	}

	// Verify encrypted string in config file
	cfg := loadConfig()
	if cfg.KanbanPasswordEnc == "" || cfg.KanbanPasswordEnc == "my_test_password" {
		t.Errorf("Expected encrypted password in config, got %q", cfg.KanbanPasswordEnc)
	}

	// GET password
	reqGet := httptest.NewRequest(http.MethodGet, "/api/config/kanban-vault", nil)
	wGet := httptest.NewRecorder()
	handleKanbanVault(wGet, reqGet)

	if wGet.Code != http.StatusOK {
		t.Fatalf("handleKanbanVault GET failed: %d", wGet.Code)
	}
	var getRes map[string]string
	json.NewDecoder(wGet.Body).Decode(&getRes)
	if getRes["password"] != "my_test_password" {
		t.Errorf("Expected decrypted password 'my_test_password', got %q", getRes["password"])
	}

	// DELETE password
	reqDel := httptest.NewRequest(http.MethodDelete, "/api/config/kanban-vault", nil)
	wDel := httptest.NewRecorder()
	handleKanbanVault(wDel, reqDel)

	if wDel.Code != http.StatusOK {
		t.Fatalf("handleKanbanVault DELETE failed: %d", wDel.Code)
	}

	cfgAfterDel := loadConfig()
	if cfgAfterDel.KanbanPasswordEnc != "" {
		t.Errorf("Expected empty KanbanPasswordEnc after DELETE")
	}
}





