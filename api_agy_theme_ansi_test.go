package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAgyThemeAnsiSetting(t *testing.T) {
	t.Run("off by default", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		if cfg.AgyThemeAnsi {
			t.Fatal("AgyThemeAnsi should default to false so existing configs are unaffected")
		}
	})

	t.Run("persists across a save/load round trip", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.AgyThemeAnsi = true
		saveConfig(cfg)
		if !loadConfig().AgyThemeAnsi {
			t.Fatal("AgyThemeAnsi did not survive save/load")
		}
	})

	t.Run("toggles via handleAgyThemeAnsi endpoint", func(t *testing.T) {
		withTempConfig(t)

		// Toggle on
		bodyOn := bytes.NewBufferString(`{"enabled": true}`)
		reqOn := httptest.NewRequest(http.MethodPost, "/api/config/agy-theme-ansi", bodyOn)
		wOn := httptest.NewRecorder()
		handleAgyThemeAnsi(wOn, reqOn)

		if wOn.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", wOn.Code)
		}
		if !loadConfig().AgyThemeAnsi {
			t.Fatal("expected AgyThemeAnsi to be true after POST with enabled: true")
		}

		// Toggle off
		bodyOff := bytes.NewBufferString(`{"enabled": false}`)
		reqOff := httptest.NewRequest(http.MethodPost, "/api/config/agy-theme-ansi", bodyOff)
		wOff := httptest.NewRecorder()
		handleAgyThemeAnsi(wOff, reqOff)

		if wOff.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", wOff.Code)
		}
		if loadConfig().AgyThemeAnsi {
			t.Fatal("expected AgyThemeAnsi to be false after POST with enabled: false")
		}
	})

	t.Run("rejects non-POST methods", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/config/agy-theme-ansi", nil)
		w := httptest.NewRecorder()
		handleAgyThemeAnsi(w, req)

		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405 Method Not Allowed, got %d", w.Code)
		}
	})

	t.Run("appears in GET /api/config payload", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.AgyThemeAnsi = true
		saveConfig(cfg)

		req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
		w := httptest.NewRecorder()
		handleConfig(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", w.Code)
		}

		var resp map[string]interface{}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("failed to decode /api/config response: %v", err)
		}

		val, ok := resp["agy_theme_ansi"]
		if !ok {
			t.Fatal("agy_theme_ansi missing from /api/config response")
		}
		if enabled, isBool := val.(bool); !isBool || !enabled {
			t.Fatalf("expected agy_theme_ansi to be true, got %v", val)
		}
	})
}
