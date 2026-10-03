package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/pty"
)

func init() {
	if version := os.Getenv("PHI_TEST_ROOT_OC_VERSION"); version != "" {
		fmt.Println(version)
		os.Exit(0)
	}
}

func TestOpenCodeConfigDefaultsAndLegacyRoundTrip(t *testing.T) {
	withTempConfig(t)
	cfg := loadConfig()
	if cfg.OpenCodeLegacy {
		t.Fatal("default must be v2")
	}
	cfg.OpenCodeLegacy = true
	cfg.OpenCodeCommand = "/private/v2 binary"
	cfg.OpenCodeLegacyCommand = "/private/v1 binary"
	saveConfig(cfg)
	read := loadConfig()
	if !read.OpenCodeLegacy || read.OpenCodeCommand != cfg.OpenCodeCommand || read.OpenCodeLegacyCommand != cfg.OpenCodeLegacyCommand {
		t.Fatalf("config lost options: %+v", read)
	}
	before := coderManager
	t.Cleanup(func() { coderManager = before })
	coderManager = coders.NewManagerWithOptions(coders.BuiltinOptions{OpenCodeLegacy: read.OpenCodeLegacy, OpenCodeCommand: read.OpenCodeCommand, OpenCodeLegacyCommand: read.OpenCodeLegacyCommand})
	w := httptest.NewRecorder()
	handleGetCoders(w, httptest.NewRequest(http.MethodGet, "/api/coders", nil))
	var desc map[string]coders.CoderDescriptor
	if err := json.Unmarshal(w.Body.Bytes(), &desc); err != nil {
		t.Fatal(err)
	}
	if desc["opencode"].OpenCodeMode != "legacy" {
		t.Fatalf("wrong mode: %+v", desc["opencode"])
	}
	if strings.Contains(w.Body.String(), "/private/") {
		t.Fatal("private executable path leaked in descriptors")
	}
	w = httptest.NewRecorder()
	handleConfig(w, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if strings.Contains(w.Body.String(), "/private/") {
		t.Fatal("private executable path leaked in config API")
	}
}

func TestOpenCodeMixedPresentationsReattachAndListActualMode(t *testing.T) {
	withTempConfig(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if err := os.MkdirAll(filepath.Join(home, ".phi"), 0755); err != nil {
		t.Fatal(err)
	}
	data := `[{"id":"full","coder":"opencode","session_id":"same","opencode_mode":"tui"},{"id":"small","coder":"opencode","session_id":"same","opencode_mode":"mini"}]`
	if err := os.WriteFile(filepath.Join(home, ".phi", "tabs.json"), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	oldCoders, oldPTY := coderManager, ptyManager
	t.Cleanup(func() { coderManager = oldCoders; ptyManager = oldPTY })
	coderManager = coders.NewManager()
	ptyManager = pty.NewManager()
	if err := ptyManager.LoadState(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ body, id, mode string }{
		{`{"coder":"opencode","session_id":"same"}`, "full", "tui"},
		{`{"coder":"opencode","session_id":"same","opencode_mini":true}`, "small", "mini"},
	} {
		w := httptest.NewRecorder()
		handleSpawnTerminal(w, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(test.body)))
		var reply map[string]string
		json.Unmarshal(w.Body.Bytes(), &reply)
		if w.Code != http.StatusOK || reply["pane_id"] != test.id || reply["opencode_mode"] != test.mode {
			t.Fatalf("wrong reattach: %d %s", w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	handleSpawnTerminal(w, httptest.NewRequest(http.MethodGet, "/api/terminals", nil))
	var running []map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &running)
	modes := map[string]interface{}{}
	for _, pane := range running {
		modes[pane["id"].(string)] = pane["opencode_mode"]
	}
	if modes["full"] != "tui" || modes["small"] != "mini" {
		t.Fatalf("actual modes lost: %v", modes)
	}
	if coderManager.MustGet("opencode").OpenCodeMode != "tui" {
		t.Fatal("Mini changed default")
	}
}

func TestOpenCodeV2RejectsInstalledV1BeforePTYSpawn(t *testing.T) {
	withTempConfig(t)
	before := coderManager
	t.Cleanup(func() { coderManager = before })
	coderManager = coders.NewManager()
	c, _ := coderManager.Get("opencode")
	c.Command = os.Args[0]
	c.Env = map[string]string{"PHI_TEST_ROOT_OC_VERSION": "1.18.34"}
	coderManager.Add(c)
	for _, body := range []string{
		`{"coder":"opencode"}`,
		`{"coder":"opencode","opencode_mini":true}`,
	} {
		w := httptest.NewRecorder()
		handleSpawnTerminal(w, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(body)))
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "requires a v2 binary") {
			t.Fatalf("request %s: wrong result: %d %s", body, w.Code, w.Body.String())
		}
	}
}
