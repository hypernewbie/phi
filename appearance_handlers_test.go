package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestHandleAppearanceUpdate_PersistsFields — POST all three font
// fields, reload config from disk, confirm everything landed.
// Mirrors how the Settings modal's live-apply flow works on the
// frontend.
func TestHandleAppearanceUpdate_PersistsFields(t *testing.T) {
	path := withTempConfig(t)
	body := `{"ui_font_family":"Inter","ui_font_size":16,"terminal_font_family":"Fira Code","terminal_font_size":18}`
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
	if cfg.TerminalFontSize != 18 {
		t.Errorf("TerminalFontSize: got %d want 18", cfg.TerminalFontSize)
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
	if !strings.Contains(string(raw), `"terminal_font_size"`) {
		t.Errorf("terminal_font_size not in persisted file: %s", raw)
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

// TestHandleAppearanceUpdate_ClampsTerminalFontSize — terminal font
// size clamps to [8, 32], but 0 (the "unset/default" sentinel) must
// round-trip as 0 rather than clamping up to 8.
func TestHandleAppearanceUpdate_ClampsTerminalFontSize(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{4, 8},   // below min
		{7, 8},   // just below min
		{8, 8},   // at min — unchanged
		{32, 32}, // at max — unchanged
		{99, 32}, // above max
		{0, 0},   // zero (sentinel for "unset") — must NOT clamp up to 8
		{16, 16}, // middle — unchanged
	}
	for _, tc := range cases {
		t.Run("", func(t *testing.T) {
			withTempConfig(t)
			body := `{"terminal_font_size":` + itoaSmall(tc.in) + `}`
			req := httptest.NewRequest(http.MethodPost, "/api/config/appearance",
				strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handleAppearanceUpdate(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
			}
			cfg := loadConfig()
			if cfg.TerminalFontSize != tc.want {
				t.Errorf("size %d: got %d want %d", tc.in, cfg.TerminalFontSize, tc.want)
			}
		})
	}
}

func TestHandleAppearanceUpdate_HostnameOverride(t *testing.T) {
	// Shared vectors with test-js/hostOverride.test.js: both sides must
	// accept the same values.
	cases := []struct {
		in   string
		want string
	}{
		{`example.com:8080`, `example.com:8080`},
		{`https://example.com:8080/path`, `example.com:8080`},
		{`[::1]:9000`, `[::1]:9000`},
		{``, ``}, // blank clears back to page-host default
	}
	for _, tc := range cases {
		t.Run("", func(t *testing.T) {
			withTempConfig(t)
			body := `{"hostname_override":` + strconv.Quote(tc.in) + `}`
			req := httptest.NewRequest(http.MethodPost, "/api/config/appearance",
				strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handleAppearanceUpdate(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
			}
			if cfg := loadConfig(); cfg.HostnameOverride != tc.want {
				t.Errorf("in %q: got %q want %q", tc.in, cfg.HostnameOverride, tc.want)
			}
		})
	}
}

func TestHandleAppearanceUpdate_HostnameOverrideRejectsGarbage(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()
	cfg.HostnameOverride = "example.com:8080"
	saveConfig(cfg)
	for _, bad := range []string{`not a host!`, `user@example.com`, `example.com:abc`, `-leading-dash.com`, `[]`} {
		body := `{"hostname_override":` + strconv.Quote(bad) + `}`
		req := httptest.NewRequest(http.MethodPost, "/api/config/appearance",
			strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handleAppearanceUpdate(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("in %q: status %d", bad, w.Code)
		}
		// Garbage leaves the stored value unchanged: a typo can never
		// brick connectivity.
		if got := loadConfig().HostnameOverride; got != "example.com:8080" {
			t.Errorf("in %q: stored value changed to %q", bad, got)
		}
	}
}

func TestHandleAppearanceUpdate_ClampsMobileScrollback(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{100, 500},     // below min
		{499, 500},     // just below min
		{500, 500},     // at min — unchanged
		{2000, 2000},   // middle — unchanged
		{10000, 10000}, // at max — unchanged
		{99999, 10000}, // above max
		{0, 0},         // zero (sentinel for full history) — must NOT clamp up
	}
	for _, tc := range cases {
		t.Run("", func(t *testing.T) {
			withTempConfig(t)
			body := `{"mobile_scrollback_rows":` + itoaSmall(tc.in) + `}`
			req := httptest.NewRequest(http.MethodPost, "/api/config/appearance",
				strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handleAppearanceUpdate(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
			}
			cfg := loadConfig()
			if cfg.MobileScrollbackRows != tc.want {
				t.Errorf("rows %d: got %d want %d", tc.in, cfg.MobileScrollbackRows, tc.want)
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
	cfg.TerminalFontSize = 20
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
	if sz, ok := got["terminal_font_size"].(float64); !ok || int(sz) != 20 {
		t.Errorf("terminal_font_size: got %v want 20", got["terminal_font_size"])
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

func TestReportedHostname(t *testing.T) {
	// Pure function on the Config value — no disk touch, so no
	// withTempConfig needed.
	osHost, _ := os.Hostname()
	if osHost == "" {
		osHost = "localhost"
	}
	cases := []struct {
		name     string
		override string
		want     string
	}{
		{"blank falls back to OS hostname", "", osHost},
		{"override wins over OS hostname", "example.com", "example.com"},
		{"override port stripped for identity", "example.com:8080", "example.com"},
		{"bracketed IPv6 keeps brackets, port stripped", "[::1]:9000", "[::1]"},
		{"whitespace-only override falls back", "   ", osHost},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := reportedHostname(Config{HostnameOverride: tc.override}); got != tc.want {
				t.Errorf("override %q: got %q want %q", tc.override, got, tc.want)
			}
		})
	}
}

func TestHandleConfig_ReportsOverrideHostname(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()
	cfg.HostnameOverride = "example.com:8080"
	saveConfig(cfg)
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	handleConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status: %d", w.Code)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Identity field reports the override (uppercased, like before);
	// the raw override rides separately for the settings input.
	if body["hostname"] != "EXAMPLE.COM" {
		t.Errorf("hostname: got %v want EXAMPLE.COM", body["hostname"])
	}
	if body["hostname_override"] != "example.com:8080" {
		t.Errorf("hostname_override: got %v", body["hostname_override"])
	}
}
