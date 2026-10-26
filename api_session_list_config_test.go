package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
)

func TestSessionListPageSizeConfig(t *testing.T) {
	cases := []struct {
		name   string
		config string
		want   float64
	}{
		{"unset", `{}`, 10},
		{"zero", `{"session_list_page_size":0}`, 10},
		{"negative", `{"session_list_page_size":-1}`, 5},
		{"below minimum", `{"session_list_page_size":1}`, 5},
		{"minimum", `{"session_list_page_size":5}`, 5},
		{"configured", `{"session_list_page_size":7}`, 7},
		{"default value", `{"session_list_page_size":10}`, 10},
		{"maximum", `{"session_list_page_size":100}`, 100},
		{"above maximum", `{"session_list_page_size":101}`, 100},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := withTempConfig(t)
			if err := os.WriteFile(path, []byte(tc.config), 0o644); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}

			rec := httptest.NewRecorder()
			handleConfig(rec, httptest.NewRequest("GET", "/api/config", nil))
			if rec.Code != 200 {
				t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
			}

			var payload map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			got, ok := payload["session_list_page_size"].(float64)
			if !ok {
				t.Fatalf("payload key missing or not numeric: %#v", payload["session_list_page_size"])
			}
			if got != tc.want {
				t.Fatalf("payload size %v, want %v", got, tc.want)
			}

			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(after) != string(before) {
				t.Fatalf("GET /api/config rewrote the config file: %q -> %q", before, after)
			}
		})
	}

	t.Run("raw value round trip", func(t *testing.T) {
		path := withTempConfig(t)
		if err := os.WriteFile(path, []byte(`{"session_list_page_size":7}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if raw := loadConfig().SessionListPageSize; raw != 7 {
			t.Fatalf("raw config value %d, want 7", raw)
		}

		cfg := loadConfig()
		cfg.Workspaces = []string{"/work"}
		saveConfig(cfg)

		reloaded := loadConfig()
		if reloaded.SessionListPageSize != 7 {
			t.Fatalf("round trip value %d, want 7", reloaded.SessionListPageSize)
		}

		rec := httptest.NewRecorder()
		handleConfig(rec, httptest.NewRequest("GET", "/api/config", nil))
		var payload map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		if payload["session_list_page_size"] != float64(7) {
			t.Fatalf("payload after round trip: %v", payload["session_list_page_size"])
		}
	})
}
