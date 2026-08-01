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
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/session"
	"github.com/hypernewbie/phi/pkg/update"
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
	wantClaudeModels := []string{"fable", "opus", "sonnet", "haiku"}
	if !reflect.DeepEqual(claudeModels, wantClaudeModels) {
		t.Errorf("expected Claude defaults %v, got %v", wantClaudeModels, claudeModels)
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

func TestHandleModelPresets_AddEditAndDelete(t *testing.T) {
	withTempConfig(t)

	body := strings.NewReader(`{"coder":"pi","model":"model-one"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/config/models", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleModelPresets(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST status: want 200, got %d - %s", w.Code, w.Body.String())
	}

	body = strings.NewReader(`{"coder":"pi","old_model":"model-one","model":"model-two"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/config/models", body)
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	handleModelPresets(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("edit POST status: want 200, got %d - %s", w.Code, w.Body.String())
	}

	cfg := loadConfig()
	if containsString(cfg.ModelPresets["pi"], "model-one") {
		t.Error("old model preset still present after edit")
	}
	if !containsString(cfg.ModelPresets["pi"], "model-two") {
		t.Errorf("edited model preset not saved, got %v", cfg.ModelPresets["pi"])
	}

	body = strings.NewReader(`{"coder":"pi","model":"model-two"}`)
	req = httptest.NewRequest(http.MethodDelete, "/api/config/models", body)
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	handleModelPresets(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE status: want 200, got %d - %s", w.Code, w.Body.String())
	}

	cfg = loadConfig()
	if containsString(cfg.ModelPresets["pi"], "model-two") {
		t.Error("model preset still present after DELETE")
	}
}

func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
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
	for _, field := range []string{"workspaces", "theme_color", "model_presets", "quick_commands", "markdown_dirs", "auto_reconnect"} {
		if _, ok := body[field]; !ok {
			t.Errorf("response missing field %q", field)
		}
	}
	// use_existing_terminal_tab is always present in response (even when
	// false — the field's zero value is the documented default).
	if _, ok := body["use_existing_terminal_tab"]; !ok {
		t.Errorf("response missing field %q", "use_existing_terminal_tab")
	}
	// fast_mode is always present in response (even when false — the
	// field's zero value is the documented default).
	if _, ok := body["fast_mode"]; !ok {
		t.Errorf("response missing field %q", "fast_mode")
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

func TestHandleFastMode_Toggle(t *testing.T) {
	withTempConfig(t)

	// Initial GET: field is false
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	handleConfig(w, req)
	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode initial: %v", err)
	}
	if enabled, _ := body["fast_mode"].(bool); enabled {
		t.Errorf("initial fast_mode: want false, got true")
	}

	// POST: enable
	body1 := strings.NewReader(`{"enabled":true}`)
	req1 := httptest.NewRequest(http.MethodPost, "/api/config/fast-mode", body1)
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	handleFastMode(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("POST status: want 200, got %d — %s", w1.Code, w1.Body.String())
	}

	// Verify persisted to disk
	cfg := loadConfig()
	if !cfg.FastMode {
		t.Errorf("after POST enabled=true, config still false")
	}

	// POST: disable
	body2 := strings.NewReader(`{"enabled":false}`)
	req2 := httptest.NewRequest(http.MethodPost, "/api/config/fast-mode", body2)
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	handleFastMode(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("POST disable status: want 200, got %d", w2.Code)
	}
	cfg = loadConfig()
	if cfg.FastMode {
		t.Errorf("after POST enabled=false, config still true")
	}
}

func TestHandleFastMode_RejectsWrongMethod(t *testing.T) {
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/api/config/fast-mode", nil)
	w := httptest.NewRecorder()
	handleFastMode(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET status: want 405, got %d", w.Code)
	}
}

func TestAutoReconnect_DefaultIsVisible(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()
	if cfg.AutoReconnect != "visible" {
		t.Errorf("AutoReconnect default: want %q, got %q", "visible", cfg.AutoReconnect)
	}
}

func TestAutoReconnect_PreservesExplicitOff(t *testing.T) {
	// Locked decision: an on-disk "off" (whether user-chosen or persisted by
	// an unrelated settings save) is respected as-is — no migration.
	configPath := withTempConfig(t)
	legacy := `{"workspaces": [], "auto_reconnect": "off"}`
	if err := os.WriteFile(configPath, []byte(legacy), 0644); err != nil {
		t.Fatalf("write legacy config: %v", err)
	}
	cfg := loadConfig()
	if cfg.AutoReconnect != "off" {
		t.Errorf("legacy off: want %q preserved, got %q", "off", cfg.AutoReconnect)
	}
}

func TestHandleAutoReconnect_Toggle(t *testing.T) {
	withTempConfig(t)

	// POST: disable
	body1 := strings.NewReader(`{"enabled":false}`)
	req1 := httptest.NewRequest(http.MethodPost, "/api/config/auto-reconnect", body1)
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	handleAutoReconnect(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("POST disable status: want 200, got %d — %s", w1.Code, w1.Body.String())
	}
	if cfg := loadConfig(); cfg.AutoReconnect != "off" {
		t.Errorf("after POST enabled=false: want %q, got %q", "off", cfg.AutoReconnect)
	}

	// POST: enable
	body2 := strings.NewReader(`{"enabled":true}`)
	req2 := httptest.NewRequest(http.MethodPost, "/api/config/auto-reconnect", body2)
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	handleAutoReconnect(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("POST enable status: want 200, got %d", w2.Code)
	}
	if cfg := loadConfig(); cfg.AutoReconnect != "visible" {
		t.Errorf("after POST enabled=true: want %q, got %q", "visible", cfg.AutoReconnect)
	}
}

func TestHandleAutoReconnect_RejectsWrongMethod(t *testing.T) {
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/api/config/auto-reconnect", nil)
	w := httptest.NewRecorder()
	handleAutoReconnect(w, req)
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

	body := strings.NewReader(`{"old_name":"upd","name":"renamed","command":"renamed command"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/config/quick-commands", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleQuickCommands(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("rename POST status: want 200, got %d - %s", w.Code, w.Body.String())
	}

	cfg = loadConfig()
	for _, qc := range cfg.QuickCommands {
		if qc.Name == "upd" {
			t.Error("old quick command name still present after rename")
		}
		if qc.Name == "renamed" && qc.Command != "renamed command" {
			t.Errorf("renamed quick command has wrong command: %q", qc.Command)
		}
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

	body := strings.NewReader(`{"old_name":"updterm","name":"renamedterm","command":"renamed terminal command"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/config/terminal-commands", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleTerminalCommands(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("rename POST status: want 200, got %d - %s", w.Code, w.Body.String())
	}

	cfg = loadConfig()
	for _, tc := range cfg.TerminalCommands {
		if tc.Name == "updterm" {
			t.Error("old terminal command name still present after rename")
		}
		if tc.Name == "renamedterm" && tc.Command != "renamed terminal command" {
			t.Errorf("renamed terminal command has wrong command: %q", tc.Command)
		}
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

	// Anchor the workspace to dir so the confinement gate accepts it.
	origCWD := activeCWD
	activeCWD = dir
	t.Cleanup(func() { activeCWD = origCWD })

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

// A crafted cwd + relative "." markdown dir passes the dir gate for a file
// outside the workspace, but confinement rejects it — the .md endpoint gets
// the same workspace guard as the asset endpoint.
func TestHandleMarkdownFile_RejectsCraftedCwdEscape(t *testing.T) {
	withTempConfig(t)
	workspace := t.TempDir()
	outside := t.TempDir()

	cfg := loadConfig()
	cfg.MarkdownDirs = []string{"."} // base controlled by cwd
	saveConfig(cfg)

	origCWD := activeCWD
	activeCWD = workspace
	t.Cleanup(func() { activeCWD = origCWD })

	outsideMD := filepath.Join(outside, "secret.md")
	os.WriteFile(outsideMD, []byte("secret"), 0644)

	req := httptest.NewRequest(http.MethodGet,
		"/api/markdown/file?path="+outsideMD+"&cwd="+outside, nil)
	w := httptest.NewRecorder()
	handleMarkdownFile(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for crafted-cwd escape, got %d (%s)", w.Code, w.Body.String())
	}
}

// A symlink inside the workspace pointing OUTSIDE it is blocked: the guard
// confines the symlink-resolved target, not the link's own path.
func TestHandleMarkdownFile_RejectsSymlinkEscape(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	outside := t.TempDir()

	cfg := loadConfig()
	cfg.MarkdownDirs = []string{dir}
	saveConfig(cfg)

	origCWD := activeCWD
	activeCWD = dir
	t.Cleanup(func() { activeCWD = origCWD })

	target := filepath.Join(outside, "target.md")
	os.WriteFile(target, []byte("secret"), 0644)
	link := filepath.Join(dir, "link.md")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unsupported here: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet,
		"/api/markdown/file?path="+link+"&cwd="+dir, nil)
	w := httptest.NewRecorder()
	handleMarkdownFile(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for symlink escaping workspace, got %d (%s)", w.Code, w.Body.String())
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

func TestHandleGetVersion(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	w := httptest.NewRecorder()
	handleGetVersion(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var res map[string]string
	if err := json.NewDecoder(w.Body).Decode(&res); err != nil {
		t.Fatalf("Failed to decode version response: %v", err)
	}

	for _, field := range []string{"version", "commit", "date", "build_source", "install_method"} {
		if _, ok := res[field]; !ok {
			t.Errorf("Expected version response to contain %q", field)
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

	inst, err := ptyManager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
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

func TestHandleFallback_Rename(t *testing.T) {
	ptyManager = pty.NewManager()
	shell, args := testMainShell()

	inst, err := ptyManager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY for rename test: %v", err)
	}
	defer func() { _ = ptyManager.Kill(inst.ID) }()

	// 404 for unknown pane.
	reqNF := httptest.NewRequest(http.MethodPost, "/api/terminals/nope/title", strings.NewReader(`{"title":"x"}`))
	wNF := httptest.NewRecorder()
	handleFallback(wNF, reqNF)
	if wNF.Code != http.StatusNotFound {
		t.Errorf("unknown pane: want 404, got %d", wNF.Code)
	}

	// 400 for malformed JSON.
	reqBad := httptest.NewRequest(http.MethodPost, "/api/terminals/"+inst.ID+"/title", strings.NewReader(`{"title":`))
	wBad := httptest.NewRecorder()
	handleFallback(wBad, reqBad)
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("malformed JSON: want 400, got %d", wBad.Code)
	}

	// 200 + title mutated.
	reqOK := httptest.NewRequest(http.MethodPost, "/api/terminals/"+inst.ID+"/title", strings.NewReader(`{"title":"deploy hotfix"}`))
	wOK := httptest.NewRecorder()
	handleFallback(wOK, reqOK)
	if wOK.Code != http.StatusOK {
		t.Fatalf("rename: want 200, got %d", wOK.Code)
	}
	if inst.Title != "deploy hotfix" {
		t.Errorf("title not applied: want %q, got %q", "deploy hotfix", inst.Title)
	}
}

func TestHandleFallback_Delete(t *testing.T) {
	ptyManager = pty.NewManager()
	shell, args := testMainShell()

	inst, err := ptyManager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
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

// TestHandleRawDiff_CancelledContext (L6): a request whose ctx is already
// cancelled must short-circuit through IsGitRepo's `git rev-parse` probe
// (which the ctx kills via exec.CommandContext), not run the actual
// `git diff` subprocess at all. Either observable result is fine, but
// neither must leak the git fatal-stderr spam. Proves the ctx threading
// reaches git, not just the function signature.
func TestHandleRawDiff_CancelledContext(t *testing.T) {
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

	req := httptest.NewRequest(http.MethodGet, "/api/git/raw-diff?cwd="+tempDir, nil)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	handleRawDiff(w, req)

	// The cancelled ctx reaches IsGitRepo's git rev-parse probe, which
	// gets killed and returns non-zero — IsGitRepo treats that as
	// "not a repo" and the handler emits the NOT_GIT_REPO sentinel.
	// Either a 200 with that sentinel or a 500 with a context-related
	// error is acceptable; the test invariant is "git fatal-stderr
	// never reaches the wire".
	body := w.Body.String()
	if strings.Contains(body, "fatal: not a git repository") ||
		strings.Contains(body, "fatal: ambiguous") {
		t.Errorf("git stderr leaked into response: %s", body)
	}
	switch w.Code {
	case http.StatusOK:
		if body != "NOT_GIT_REPO" {
			t.Errorf("expected body NOT_GIT_REPO when ctx cancels early, got %q", body)
		}
	case http.StatusInternalServerError:
		if !strings.Contains(body, "context canceled") &&
			!strings.Contains(body, "context deadline exceeded") {
			t.Errorf("expected 500 body to mention context, got %q", body)
		}
	default:
		t.Fatalf("expected 200 (NOT_GIT_REPO) or 500 (context error), got %d: %s", w.Code, body)
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

	// Reload config and assert only models are restored. Commands remain unchanged.
	loaded := loadConfig()
	if loaded.ModelPresets["pi"][0] != "original-model" {
		t.Errorf("model presets not restored, got %+v", loaded.ModelPresets)
	}
	if loaded.QuickCommands[0].Name != "test2" {
		t.Errorf("quick commands should NOT have been restored/overwritten, got %+v", loaded.QuickCommands)
	}
	if loaded.TerminalCommands[0].Name != "term-different" {
		t.Errorf("terminal commands should NOT have been restored/overwritten, got %+v", loaded.TerminalCommands)
	}
}

// Until v0.7.16 the cmd panel and the quick-commands dropup both called
// `exportCmdsConfig` -> /api/config/export-cmds, which dumped BOTH
// quick_commands (sent to active PTY) and terminal_commands (spawn new
// shell tabs) into a single payload. They're different concepts; one
// user's "cmds" is the other's data. They were conflated, like crack
// isn't the same as crack - same word, different (legal/illegal) thing.
//
// These tests lock in the split: each export endpoint returns ONLY its
// own list, and the corresponding import is scoped to that same list. The
// old /api/config/export-cmds endpoint is gone; the import endpoint
// stays but only accepts data with a known prefix (PHIQUICKCMDS,
// PHITERMCMDS, or the legacy PHICMDS for paste-back-compat).

func TestConfigExportQuickCommandsOnly(t *testing.T) {
	withTempConfig(t)

	cfg := loadConfig()
	cfg.QuickCommands = []QuickCommand{
		{Name: "q1", Command: "echo q1"},
		{Name: "q2", Command: "echo q2"},
	}
	// Terminal cmds are also set; the quick export must NOT include them.
	cfg.TerminalCommands = []QuickCommand{{Name: "t1", Command: "bash t1"}}
	saveConfig(cfg)

	reqExport := httptest.NewRequest(http.MethodGet, "/api/config/export-quick-commands", nil)
	wExport := httptest.NewRecorder()
	handleConfigExportQuickCommands(wExport, reqExport)
	if wExport.Code != http.StatusOK {
		t.Fatalf("quick export handler failed, code %d, body: %s", wExport.Code, wExport.Body.String())
	}

	var exportRes struct {
		Config string `json:"config"`
	}
	if err := json.NewDecoder(wExport.Body).Decode(&exportRes); err != nil {
		t.Fatalf("failed to decode quick export body: %v", err)
	}
	if !strings.HasPrefix(exportRes.Config, "PHIQUICKCMDS:") {
		t.Fatalf("expected config to start with PHIQUICKCMDS:, got %q", exportRes.Config[:min(40, len(exportRes.Config))])
	}

	// Round-trip decode and confirm ONLY quick_commands was carried.
	jsonData, err := decodeConfigData(exportRes.Config, "PHIQUICKCMDS")
	if err != nil {
		t.Fatalf("decode PHIQUICKCMDS: %v", err)
	}
	var got struct {
		QuickCommands    []QuickCommand `json:"quick_commands"`
		TerminalCommands []QuickCommand `json:"terminal_commands"`
	}
	if err := json.Unmarshal(jsonData, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.QuickCommands) != 2 {
		t.Errorf("expected 2 quick commands, got %+v", got.QuickCommands)
	}
	// The whole point: terminal_commands must be absent or empty, NOT leaked.
	if len(got.TerminalCommands) != 0 {
		t.Errorf("quick-only export leaked terminal_commands: %+v", got.TerminalCommands)
	}
}

func TestConfigExportTerminalCommandsOnly(t *testing.T) {
	withTempConfig(t)

	cfg := loadConfig()
	// Quick cmds are also set; the terminal export must NOT include them.
	cfg.QuickCommands = []QuickCommand{{Name: "q1", Command: "echo q1"}}
	cfg.TerminalCommands = []QuickCommand{
		{Name: "t1", Command: "bash t1"},
		{Name: "t2", Command: "bash t2"},
	}
	saveConfig(cfg)

	reqExport := httptest.NewRequest(http.MethodGet, "/api/config/export-terminal-commands", nil)
	wExport := httptest.NewRecorder()
	handleConfigExportTerminalCommands(wExport, reqExport)
	if wExport.Code != http.StatusOK {
		t.Fatalf("terminal export handler failed, code %d, body: %s", wExport.Code, wExport.Body.String())
	}

	var exportRes struct {
		Config string `json:"config"`
	}
	if err := json.NewDecoder(wExport.Body).Decode(&exportRes); err != nil {
		t.Fatalf("failed to decode terminal export body: %v", err)
	}
	if !strings.HasPrefix(exportRes.Config, "PHITERMCMDS:") {
		t.Fatalf("expected config to start with PHITERMCMDS:, got %q", exportRes.Config[:min(40, len(exportRes.Config))])
	}

	jsonData, err := decodeConfigData(exportRes.Config, "PHITERMCMDS")
	if err != nil {
		t.Fatalf("decode PHITERMCMDS: %v", err)
	}
	var got struct {
		QuickCommands    []QuickCommand `json:"quick_commands"`
		TerminalCommands []QuickCommand `json:"terminal_commands"`
	}
	if err := json.Unmarshal(jsonData, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.TerminalCommands) != 2 {
		t.Errorf("expected 2 terminal commands, got %+v", got.TerminalCommands)
	}
	// And the OTHER way: quick commands must NOT leak into the terminal export.
	if len(got.QuickCommands) != 0 {
		t.Errorf("terminal-only export leaked quick_commands: %+v", got.QuickCommands)
	}
}

// Round-trip a quick-only export through the import endpoint and assert
// terminal_commands is left untouched (not cleared, not overwritten).
func TestConfigImportCmdsScoping(t *testing.T) {
	withTempConfig(t)

	cfg := loadConfig()
	cfg.QuickCommands = []QuickCommand{{Name: "q-old", Command: "echo old"}}
	cfg.TerminalCommands = []QuickCommand{{Name: "t-existing", Command: "bash existing"}}
	saveConfig(cfg)

	// Build a PHIQUICKCMDS payload and import it.
	encoded, err := encodeConfigData("PHIQUICKCMDS", struct {
		QuickCommands []QuickCommand `json:"quick_commands"`
	}{
		QuickCommands: []QuickCommand{{Name: "q-new", Command: "echo new"}},
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	body, _ := json.Marshal(map[string]string{"config": encoded})
	req := httptest.NewRequest(http.MethodPost, "/api/config/import-cmds", strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handleConfigImportCmds(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("import handler failed, code %d, body: %s", w.Code, w.Body.String())
	}

	loaded := loadConfig()
	if len(loaded.QuickCommands) != 1 || loaded.QuickCommands[0].Name != "q-new" {
		t.Errorf("quick commands not updated, got %+v", loaded.QuickCommands)
	}
	// Terminal commands must be EXACTLY what it was - quick import must not touch it.
	if len(loaded.TerminalCommands) != 1 || loaded.TerminalCommands[0].Name != "t-existing" {
		t.Errorf("quick-only import clobbered terminal_commands: %+v", loaded.TerminalCommands)
	}

	// Now do the symmetric case: import a PHITERMCMDS payload and assert
	// quick_commands is left alone.
	cfg = loadConfig()
	cfg.QuickCommands = []QuickCommand{{Name: "q-existing", Command: "echo q-existing"}}
	saveConfig(cfg)

	encoded2, err := encodeConfigData("PHITERMCMDS", struct {
		TerminalCommands []QuickCommand `json:"terminal_commands"`
	}{
		TerminalCommands: []QuickCommand{{Name: "t-new", Command: "bash t-new"}},
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	body2, _ := json.Marshal(map[string]string{"config": encoded2})
	req2 := httptest.NewRequest(http.MethodPost, "/api/config/import-cmds", strings.NewReader(string(body2)))
	w2 := httptest.NewRecorder()
	handleConfigImportCmds(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("import handler failed, code %d, body: %s", w2.Code, w2.Body.String())
	}

	loaded = loadConfig()
	if len(loaded.TerminalCommands) != 1 || loaded.TerminalCommands[0].Name != "t-new" {
		t.Errorf("terminal commands not updated, got %+v", loaded.TerminalCommands)
	}
	if len(loaded.QuickCommands) != 1 || loaded.QuickCommands[0].Name != "q-existing" {
		t.Errorf("terminal-only import clobbered quick_commands: %+v", loaded.QuickCommands)
	}
}

// Backwards compatibility: the old combined PHICMDS paste format must still
// work, so users with previously-copied config can still paste it in.
func TestConfigImportCmdsLegacyPHICMDS(t *testing.T) {
	withTempConfig(t)

	cfg := loadConfig()
	cfg.QuickCommands = []QuickCommand{{Name: "q-old", Command: "echo old"}}
	cfg.TerminalCommands = []QuickCommand{{Name: "t-old", Command: "bash old"}}
	saveConfig(cfg)

	// Build the legacy combined format and import.
	encoded, err := encodeConfigData("PHICMDS", struct {
		QuickCommands    []QuickCommand `json:"quick_commands"`
		TerminalCommands []QuickCommand `json:"terminal_commands"`
	}{
		QuickCommands:    []QuickCommand{{Name: "q-new", Command: "echo new"}},
		TerminalCommands: []QuickCommand{{Name: "t-new", Command: "bash new"}},
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	body, _ := json.Marshal(map[string]string{"config": encoded})
	req := httptest.NewRequest(http.MethodPost, "/api/config/import-cmds", strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handleConfigImportCmds(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("legacy PHICMDS import failed, code %d, body: %s", w.Code, w.Body.String())
	}

	loaded := loadConfig()
	if len(loaded.QuickCommands) != 1 || loaded.QuickCommands[0].Name != "q-new" {
		t.Errorf("legacy PHICMDS: quick commands not updated, got %+v", loaded.QuickCommands)
	}
	if len(loaded.TerminalCommands) != 1 || loaded.TerminalCommands[0].Name != "t-new" {
		t.Errorf("legacy PHICMDS: terminal commands not updated, got %+v", loaded.TerminalCommands)
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
	withTempConfig(t)

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
	withTempConfig(t)

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

func TestSimplepushAPI(t *testing.T) {
	withTempConfig(t)

	// GET Simplepush config
	reqGet := httptest.NewRequest(http.MethodGet, "/api/config/simplepush", nil)
	wGet := httptest.NewRecorder()
	handleGetSimplepushConfig(wGet, reqGet)

	if wGet.Code != http.StatusOK {
		t.Fatalf("handleGetSimplepushConfig failed: %d", wGet.Code)
	}

	// POST Simplepush config
	postBody, _ := json.Marshal(map[string]interface{}{
		"simplepush_key":     "ABC123",
		"simplepush_enabled": true,
	})
	reqPost := httptest.NewRequest(http.MethodPost, "/api/config/simplepush", bytes.NewReader(postBody))
	wPost := httptest.NewRecorder()
	handlePostSimplepushConfig(wPost, reqPost)

	if wPost.Code != http.StatusOK {
		t.Fatalf("handlePostSimplepushConfig failed: %d", wPost.Code)
	}

	cfg := loadConfig()
	if !cfg.SimplepushEnabled || cfg.SimplepushKey != "ABC123" {
		t.Errorf("Config mismatch after Simplepush POST: %+v", cfg)
	}
}

func TestKanbanVaultAPI(t *testing.T) {
	withTempConfig(t)

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

func TestSyncMessagesCRUD(t *testing.T) {
	tmpDir := t.TempDir()
	testSyncPath = filepath.Join(tmpDir, "syncboard-test.json")
	defer func() { testSyncPath = "" }()

	syncMu.Lock()
	syncStore = make(map[string]*SyncMessage)
	syncMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/sync/messages", nil)
	w := httptest.NewRecorder()
	handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/sync/messages failed: status %d", w.Code)
	}
	var list []SyncMessage
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("failed to decode list: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected 0 messages, got %d", len(list))
	}

	payload, _ := json.Marshal(map[string]string{"key": "alpha", "value": "hello"})
	req = httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(string(payload)))
	w = httptest.NewRecorder()
	handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /api/sync/messages failed: status %d", w.Code)
	}
	var created SyncMessage
	json.NewDecoder(w.Body).Decode(&created)
	if created.Key != "alpha" || created.Value != "hello" {
		t.Errorf("unexpected created message: %+v", created)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/alpha", nil)
	w = httptest.NewRecorder()
	handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/sync/messages/alpha failed: status %d", w.Code)
	}
	var fetched SyncMessage
	json.NewDecoder(w.Body).Decode(&fetched)
	if fetched.Key != "alpha" || fetched.Value != "hello" {
		t.Errorf("unexpected fetched message: %+v", fetched)
	}

	payload, _ = json.Marshal(map[string]string{"key": "alpha", "value": "updated"})
	req = httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(string(payload)))
	w = httptest.NewRecorder()
	handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /api/sync/messages upsert failed: status %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/alpha", nil)
	w = httptest.NewRecorder()
	handleSyncMessages(w, req)
	json.NewDecoder(w.Body).Decode(&fetched)
	if fetched.Value != "updated" {
		t.Errorf("expected value 'updated', got %q", fetched.Value)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/nonexistent", nil)
	w = httptest.NewRecorder()
	handleSyncMessages(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/sync/messages/alpha", nil)
	w = httptest.NewRecorder()
	handleSyncMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE /api/sync/messages/alpha failed: status %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sync/messages/alpha", nil)
	w = httptest.NewRecorder()
	handleSyncMessages(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404 after delete, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/sync/messages/nonexistent", nil)
	w = httptest.NewRecorder()
	handleSyncMessages(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404 on delete nonexistent, got %d", w.Code)
	}
}

func TestSyncCoordinatorConfig(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()
	if cfg.SyncCoordinator != "http://localhost:7070" {
		t.Errorf("expected default coordinator to be http://localhost:7070, got %q", cfg.SyncCoordinator)
	}

	body, _ := json.Marshal(map[string]string{"sync_coordinator": "http://coordinator.test"})
	req := httptest.NewRequest(http.MethodPost, "/api/config/sync-coordinator", strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handleSyncCoordinator(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /api/config/sync-coordinator failed: status %d", w.Code)
	}

	cfg = loadConfig()
	if cfg.SyncCoordinator != "http://coordinator.test" {
		t.Errorf("expected updated coordinator 'http://coordinator.test', got %q", cfg.SyncCoordinator)
	}

	// Verify GET /api/config returns the sync_coordinator value
	reqGet := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	wGet := httptest.NewRecorder()
	handleConfig(wGet, reqGet)
	if wGet.Code != http.StatusOK {
		t.Fatalf("GET /api/config failed: status %d", wGet.Code)
	}
	var resMap map[string]interface{}
	json.NewDecoder(wGet.Body).Decode(&resMap)
	if val, ok := resMap["sync_coordinator"].(string); !ok || val != "http://coordinator.test" {
		t.Errorf("GET /api/config response did not return the updated sync_coordinator, got: %v", resMap)
	}
}

func TestPeersStatusContract(t *testing.T) {
	// /api/peers/status must always return a JSON array (never null, never 500)
	req := httptest.NewRequest(http.MethodGet, "/api/peers/status", nil)
	w := httptest.NewRecorder()
	handleGetPeersStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var statuses []interface{}
	if err := json.NewDecoder(w.Body).Decode(&statuses); err != nil {
		t.Fatalf("response body is not a JSON array: %v", err)
	}
}

func TestPeersStatusMethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/peers/status", nil)
	w := httptest.NewRecorder()
	handleGetPeersStatus(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestConfigPeersCRUD(t *testing.T) {
	// Use a temp config file so we don't touch the user's live
	// ~/.phi/config.json. See config.go:testConfigPath.
	withTempConfig(t)

	// POST peers
	payload, _ := json.Marshal([]PeerConfig{
		{Name: "server-a", URL: "http://192.168.1.10:7070"},
		{Name: "server-b", URL: "http://192.168.1.11:7070"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/config/peers", strings.NewReader(string(payload)))
	w := httptest.NewRecorder()
	handleConfigPeers(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("POST /api/config/peers failed: %d", w.Code)
	}

	// GET peers
	req = httptest.NewRequest(http.MethodGet, "/api/config/peers", nil)
	w = httptest.NewRecorder()
	handleConfigPeers(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/config/peers failed: %d", w.Code)
	}

	var peers []PeerConfig
	if err := json.NewDecoder(w.Body).Decode(&peers); err != nil {
		t.Fatalf("failed to decode peers: %v", err)
	}
	if len(peers) != 2 {
		t.Errorf("expected 2 peers, got %d", len(peers))
	}
	if peers[0].Name != "server-a" {
		t.Errorf("unexpected peer name: %s", peers[0].Name)
	}
}

// /api/update/status contract: always returns a Status JSON object with
// the documented fields. Pin the shape — this is a cross-version API.
func TestUpdateStatusContract(t *testing.T) {
	// Override the package-level updateChecker so the handler can run.
	orig := updateChecker
	updateChecker = update.NewChecker("v0.7.15", "standalone")
	defer func() { updateChecker = orig }()

	req := httptest.NewRequest(http.MethodGet, "/api/update/status", nil)
	w := httptest.NewRecorder()
	handleUpdateStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var status map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&status); err != nil {
		t.Fatalf("response is not a JSON object: %v", err)
	}
	requiredKeys := []string{"current", "latest", "update_available", "install_method", "instructions"}
	for _, k := range requiredKeys {
		if _, ok := status[k]; !ok {
			t.Errorf("missing required field %q in /api/update/status response: %+v", k, status)
		}
	}
	if status["current"] != "v0.7.15" {
		t.Errorf("expected current=v0.7.15, got %v", status["current"])
	}
	if status["install_method"] != "standalone" {
		t.Errorf("expected install_method=standalone, got %v", status["install_method"])
	}
}

func TestUpdateStatusMethodNotAllowed(t *testing.T) {
	orig := updateChecker
	updateChecker = update.NewChecker("v0.7.15", "standalone")
	defer func() { updateChecker = orig }()

	req := httptest.NewRequest(http.MethodPost, "/api/update/status", nil)
	w := httptest.NewRecorder()
	handleUpdateStatus(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestUpdateStatusWithoutChecker(t *testing.T) {
	orig := updateChecker
	updateChecker = nil
	defer func() { updateChecker = orig }()

	req := httptest.NewRequest(http.MethodGet, "/api/update/status", nil)
	w := httptest.NewRecorder()
	handleUpdateStatus(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 when checker nil, got %d", w.Code)
	}
}

// runGatedUpdateCheck tests: network call when due, skip when cached status is fresh.

func TestRunGatedUpdateCheck_RunsOnFreshChecker(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Location", "https://github.com/hypernewbie/phi/releases/tag/v9.9.9")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	c := update.NewChecker("0.7.15", "standalone")
	c.SetReleaseURLForTesting(srv.URL)

	// Fresh checker: both gates true, must hit the server once.
	runGatedUpdateCheck(c, "test")

	if hits != 1 {
		t.Fatalf("expected exactly 1 network hit on a fresh checker, got %d", hits)
	}
	if got := c.Status().Latest; got != "v9.9.9" {
		t.Errorf("expected latest=v9.9.9 after a due check, got %q", got)
	}
}

func TestRunGatedUpdateCheck_SkipsWhenAlreadyFresh(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Location", "https://github.com/hypernewbie/phi/releases/tag/v9.9.9")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	c := update.NewChecker("0.7.15", "standalone")
	c.SetReleaseURLForTesting(srv.URL)

	// Prime the checker, then confirm a second call skips the network.
	c.RunCheck(false)
	if hits != 1 {
		t.Fatalf("priming check should have hit the server once, got %d", hits)
	}

	// cached status is fresh → must not hit the network.
	runGatedUpdateCheck(c, "test")

	if hits != 1 {
		t.Fatalf("expected the second, too-soon call to skip the network (still 1 hit), got %d", hits)
	}
}

// /api/update/progress contract: returns a Progress JSON object with
// the documented fields. Even when no apply has been triggered, it
// must respond cleanly with Phase="idle".
func TestUpdateProgressContract(t *testing.T) {
	orig := updateApplier
	updateApplier = update.NewApplier("v0.7.15", "standalone")
	defer func() { updateApplier = orig }()

	req := httptest.NewRequest(http.MethodGet, "/api/update/progress", nil)
	w := httptest.NewRecorder()
	handleUpdateProgress(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var p map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&p); err != nil {
		t.Fatalf("response is not a JSON object: %v", err)
	}
	if p["phase"] != "idle" {
		t.Errorf("expected phase=idle on fresh applier, got %v", p["phase"])
	}
}

func TestUpdateApplyRequiresVersion(t *testing.T) {
	orig := updateApplier
	updateApplier = update.NewApplier("v0.7.15", "standalone")
	defer func() { updateApplier = orig }()

	req := httptest.NewRequest(http.MethodPost, "/api/update/apply", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	handleUpdateApply(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing version, got %d", w.Code)
	}
}

func TestUpdateApplyRejectsIneligibleMethod(t *testing.T) {
	orig := updateApplier
	updateApplier = update.NewApplier("v0.7.15", "go-install")
	defer func() { updateApplier = orig }()

	req := httptest.NewRequest(http.MethodPost, "/api/update/apply", strings.NewReader(`{"version":"v0.8.0"}`))
	w := httptest.NewRecorder()
	handleUpdateApply(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for ineligible method, got %d", w.Code)
	}
}

func TestUpdateApplyRejectsSameVersion(t *testing.T) {
	orig := updateApplier
	updateApplier = update.NewApplier("v0.7.15", "standalone")
	defer func() { updateApplier = orig }()

	req := httptest.NewRequest(http.MethodPost, "/api/update/apply", strings.NewReader(`{"version":"v0.7.15"}`))
	w := httptest.NewRecorder()
	handleUpdateApply(w, req)

	// handleUpdateApply returns 200 immediately and the actual apply
	// runs in a goroutine; the progress will reflect the eventual
	// rejection. We just confirm the handler didn't blow up and the
	// request body was accepted.
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (async), got %d body=%s", w.Code, w.Body.String())
	}
}

// /api/restart accepts POST only. We don't exercise the actual restart
// path here - that would tear down the test binary. We just pin the
// method-not-allowed shape and the early-return-200 acknowledgement.
func TestRestartMethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/restart", nil)
	w := httptest.NewRecorder()
	handleRestart(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405 on GET, got %d", w.Code)
	}
}

// /api/diag contract: returns a JSON object with the documented fields.
// Pin the shape — this is what the diag panel reads.
func TestDiagContract(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/diag", nil)
	w := httptest.NewRecorder()
	handleDiag(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var d map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&d); err != nil {
		t.Fatalf("response is not a JSON object: %v", err)
	}
	requiredKeys := []string{
		"version", "install_method", "uptime_seconds", "goroutines", "mem_alloc_mb", "pty_count", "panes",
		// M4: additive runtime fields.
		"go_version", "gomaxprocs", "num_cpu", "num_gc",
	}
	for _, k := range requiredKeys {
		if _, ok := d[k]; !ok {
			t.Errorf("missing required field %q in /api/diag response: %+v", k, d)
		}
	}
	if _, ok := d["panes"].([]interface{}); !ok {
		t.Errorf("panes should be an array, got %T", d["panes"])
	}
}

func TestDiagMethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/diag", nil)
	w := httptest.NewRecorder()
	handleDiag(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405 on POST, got %d", w.Code)
	}
}
