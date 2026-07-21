package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// TestHandleAppearanceUpdate_PersistsFields — POST all three font
// fields, reload config from disk, confirm everything landed.
// Mirrors how the Settings modal's live-apply flow works on the
// frontend.
func TestHandleAppearanceUpdate_PersistsFields(t *testing.T) {
	path := withTempConfig(t)
	body := `{"ui_font_family":"Inter","ui_font_size":16,"terminal_font_family":"Fira Code"}`
	req := httptest.NewRequest(http.MethodPost, "/api/config/appearance", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleAppearanceUpdate(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
	}

	cfg := loadConfig()
	if cfg.UIFontFamily != "Inter" {
		t.Errorf("UIFontFamily: got %q want %q", cfg.UIFontFamily, "Inter")
	}
	if cfg.UIFontSize != 16 {
		t.Errorf("UIFontSize: got %d want 16", cfg.UIFontSize)
	}
	if cfg.TerminalFontFamily != "Fira Code" {
		t.Errorf("TerminalFontFamily: got %q want %q", cfg.TerminalFontFamily, "Fira Code")
	}

	// Confirm the on-disk file also has them (so a process restart
	// would re-load them).
	raw, err := readFile(path)
	if err != nil {
		t.Fatalf("read persisted config: %v", err)
	}
	if !strings.Contains(string(raw), `"ui_font_family"`) {
		t.Errorf("ui_font_family not in persisted file: %s", raw)
	}
	if !strings.Contains(string(raw), `"ui_font_size"`) {
		t.Errorf("ui_font_size not in persisted file: %s", raw)
	}
	if !strings.Contains(string(raw), `"terminal_font_family"`) {
		t.Errorf("terminal_font_family not in persisted file: %s", raw)
	}
}

// TestHandleAppearanceUpdate_PartialUpdate — only one field in the
// body. The others must be left untouched on disk.
func TestHandleAppearanceUpdate_PartialUpdate(t *testing.T) {
	withTempConfig(t)
	// Seed: all three set.
	cfg := loadConfig()
	cfg.UIFontFamily = "SeedFamily"
	cfg.UIFontSize = 18
	cfg.TerminalFontFamily = "SeedTerm"
	saveConfig(cfg)

	// POST only one field.
	req := httptest.NewRequest(http.MethodPost, "/api/config/appearance",
		strings.NewReader(`{"ui_font_size":13}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleAppearanceUpdate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status: %d", w.Code)
	}

	cfg2 := loadConfig()
	if cfg2.UIFontFamily != "SeedFamily" {
		t.Errorf("UIFontFamily should be untouched: got %q", cfg2.UIFontFamily)
	}
	if cfg2.UIFontSize != 13 {
		t.Errorf("UIFontSize should be updated: got %d", cfg2.UIFontSize)
	}
	if cfg2.TerminalFontFamily != "SeedTerm" {
		t.Errorf("TerminalFontFamily should be untouched: got %q", cfg2.TerminalFontFamily)
	}
}

// TestHandleAppearanceUpdate_ClampsFontSize — 4 must become 10, 99
// must become 24. Anything outside [10, 24] silently clamps; the
// client could overshoot via stale UI state.
func TestHandleAppearanceUpdate_ClampsFontSize(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{4, 10},  // below min
		{9, 10},  // just below min
		{10, 10}, // at min — unchanged
		{24, 24}, // at max — unchanged
		{99, 24}, // above max
		{16, 16}, // middle — unchanged
		{0, 10},  // zero (sentinel for "unset") — clamp to min so client sees a real value
	}
	for _, tc := range cases {
		t.Run("", func(t *testing.T) {
			withTempConfig(t)
			body := `{"ui_font_size":` + itoaSmall(tc.in) + `}`
			req := httptest.NewRequest(http.MethodPost, "/api/config/appearance",
				strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handleAppearanceUpdate(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
			}
			cfg := loadConfig()
			if cfg.UIFontSize != tc.want {
				t.Errorf("size %d: got %d want %d", tc.in, cfg.UIFontSize, tc.want)
			}
		})
	}
}

// TestHandleAppearanceUpdate_RequiresPost — GET/DELETE/etc. all 405.
func TestHandleAppearanceUpdate_RequiresPost(t *testing.T) {
	withTempConfig(t)
	for _, method := range []string{http.MethodGet, http.MethodDelete, http.MethodPut} {
		req := httptest.NewRequest(method, "/api/config/appearance", nil)
		w := httptest.NewRecorder()
		handleAppearanceUpdate(w, req)
		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: got %d want 405", method, w.Code)
		}
	}
}

// TestHandleAppearanceUpdate_RejectsGarbageBody — non-JSON body
// returns 400, leaving config untouched.
func TestHandleAppearanceUpdate_RejectsGarbageBody(t *testing.T) {
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodPost, "/api/config/appearance",
		strings.NewReader(`{not json`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleAppearanceUpdate(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("garbage body: got %d want 400", w.Code)
	}
}

// TestHandleConfig_IncludesAppearanceFields — /api/config response
// must surface the three new fields so the Settings modal can read
// them on open.
func TestHandleConfig_IncludesAppearanceFields(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()
	cfg.UIFontFamily = "Inter"
	cfg.UIFontSize = 15
	cfg.TerminalFontFamily = "JetBrains Mono"
	saveConfig(cfg)

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	handleConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status: %d", w.Code)
	}

	var got map[string]any
	body, _ := io.ReadAll(w.Body)
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v body=%s", err, body)
	}
	if got["ui_font_family"] != "Inter" {
		t.Errorf("ui_font_family: got %v want Inter", got["ui_font_family"])
	}
	// JSON numbers decode as float64.
	if sz, ok := got["ui_font_size"].(float64); !ok || int(sz) != 15 {
		t.Errorf("ui_font_size: got %v want 15", got["ui_font_size"])
	}
	if got["terminal_font_family"] != "JetBrains Mono" {
		t.Errorf("terminal_font_family: got %v", got["terminal_font_family"])
	}
}

// itoaSmall is a minimal int->string for table-driven tests so we
// don't pull fmt into the test file just to format sizes.
func itoaSmall(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	digits := "0123456789"
	var buf [12]byte
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = digits[n%10]
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// readFile is a thin wrapper for test readability.
func readFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}
