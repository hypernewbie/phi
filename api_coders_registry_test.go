package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
)

// TestHandleGetCodersExcludesSecrets verifies the public descriptor
// never carries command, args, env, default_cwd, session_source,
// or any embedded secret. R2: the descriptor is the only thing the
// browser sees, and env-bound API keys must not reach it.
func TestHandleGetCodersExcludesSecrets(t *testing.T) {
	// Seed a custom backend with an env-bound secret. handleGetCoders
	// reads from coderManager, so we add directly.
	withTempBackends(t) // not strictly needed but keeps the test honest
	ensureCoderManager()
	coderManager.Add(coders.Coder{
		ID:             "secret-agent",
		Name:           "Secret Agent",
		ShortLabel:     "SA",
		Command:        "evil-bin",
		Args:           []string{"--api-key-from-args"},
		Env:            map[string]string{"API_KEY": "sk-leak-1234567890"},
		DefaultCwd:     "/home/user/secret",
		SessionSource:  "none",
		SidebarVisible: true,
		IsShell:        false,
		InputMode:      "staged",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	w := httptest.NewRecorder()
	handleGetCoders(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	body := w.Body.String()
	for _, secret := range []string{
		"API_KEY", "sk-leak", "evil-bin",
		"--api-key-from-args", "/home/user/secret",
	} {
		if strings.Contains(body, secret) {
			t.Errorf("descriptor leaked %q to browser: %s", secret, body)
		}
	}

	// Confirm the descriptor for secret-agent is present and has
	// only the allowlisted fields.
	var m map[string]coders.CoderDescriptor
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&m); err != nil {
		t.Fatal(err)
	}
	d, ok := m["secret-agent"]
	if !ok {
		t.Fatal("secret-agent missing from descriptors")
	}
	if d.ID != "secret-agent" || d.Name != "Secret Agent" {
		t.Fatalf("descriptor fields wrong: %+v", d)
	}
}

// TestHandleGetCodersIsObjectShape verifies the wire format is the
// same map[string]<descriptor> shape the existing frontend keys off
// (R9 — app.codersPresetRegistry[coderId]). A refactor that turned
// this into an array would silently break the existing client.
func TestHandleGetCodersIsObjectShape(t *testing.T) {
	ensureCoderManager()
	req := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	w := httptest.NewRecorder()
	handleGetCoders(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	body := w.Body.String()
	trimmed := strings.TrimSpace(body)
	if strings.HasPrefix(trimmed, "[") {
		t.Fatalf("/api/coders returned an array; the frontend keys by ID, so this is a wire-format break: %s", body)
	}
	if !strings.HasPrefix(trimmed, "{") {
		t.Fatalf("/api/coders did not return an object: %s", body)
	}
}

// TestCustomBackendsNotInConfigSave verifies that adding a custom
// backend and saving the config does not absorb the custom profile
// into config.json. R3: saveConfig must serialize user-set fields
// only; backend files and resolved profiles are write-only to the
// loader, never round-tripped via the config writer.
func TestCustomBackendsNotInConfigSave(t *testing.T) {
	withTempBackends(t)
	withTempConfig(t)

	ensureCoderManager()
	coderManager.LoadFromDir(testCustomBackendsDir, nil)
	coderManager.Add(coders.Coder{
		ID:             "leaky-agent",
		Name:           "Leaky",
		Command:        "leak",
		SidebarVisible: true,
		InputMode:      "staged",
	})

	cfg := loadConfig()
	saveConfig(cfg)

	// Reload the config file directly to see what was actually written.
	data, err := osReadFile(testConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "leaky-agent") {
		t.Fatalf("saveConfig absorbed a custom backend into config.json: %s", data)
	}
	if strings.Contains(string(data), `"backends"`) {
		t.Fatalf("config.json contains a backends key after save: %s", data)
	}
}

func osReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}
