package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The no-inject switch mirrors pi_offline: one config field, one
// endpoint, one spawn-time decision. These checks cover the parts
// that fail silently - a renamed JSON tag, a default that flips, a
// flag that does not survive a save/load round trip.
func TestPiBridgeNoInjectSetting(t *testing.T) {
	t.Run("off by default", func(t *testing.T) {
		withTempConfig(t)
		if loadConfig().PiBridgeNoInject {
			t.Fatal("PiBridgeNoInject should default to false so existing configs inject as before")
		}
	})

	t.Run("persists across a save/load round trip", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.PiBridgeNoInject = true
		saveConfig(cfg)
		if !loadConfig().PiBridgeNoInject {
			t.Fatal("PiBridgeNoInject did not survive save/load")
		}
	})

	t.Run("endpoint flips the field", func(t *testing.T) {
		withTempConfig(t)
		req := httptest.NewRequest(http.MethodPost, "/api/config/pi-bridge-no-inject", strings.NewReader(`{"enabled":true}`))
		w := httptest.NewRecorder()
		handlePiBridgeNoInject(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
		}
		if !loadConfig().PiBridgeNoInject {
			t.Fatal("endpoint did not persist the flag")
		}
		var body map[string]bool
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if !body["enabled"] {
			t.Fatalf("response did not report the new state: %v", body)
		}
	})

	t.Run("endpoint turns the field off again", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.PiBridgeNoInject = true
		saveConfig(cfg)
		req := httptest.NewRequest(http.MethodPost, "/api/config/pi-bridge-no-inject", strings.NewReader(`{"enabled":false}`))
		w := httptest.NewRecorder()
		handlePiBridgeNoInject(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
		}
		if loadConfig().PiBridgeNoInject {
			t.Fatal("endpoint did not clear the flag")
		}
	})

	t.Run("endpoint rejects a non-POST method", func(t *testing.T) {
		withTempConfig(t)
		req := httptest.NewRequest(http.MethodGet, "/api/config/pi-bridge-no-inject", nil)
		w := httptest.NewRecorder()
		handlePiBridgeNoInject(w, req)
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
		}
	})
}
