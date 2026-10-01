package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
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

func TestOpenCodeMiniRejectsInstalledV1BeforePTYSpawn(t *testing.T) {
	withTempConfig(t)
	before := coderManager
	t.Cleanup(func() { coderManager = before })
	coderManager = coders.NewManager()
	c, _ := coderManager.Get("opencode")
	c.Command = os.Args[0]
	c.Env = map[string]string{"PHI_TEST_ROOT_OC_VERSION": "1.18.34"}
	coderManager.Add(c)
	w := httptest.NewRecorder()
	handleSpawnTerminal(w, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(`{"coder":"opencode"}`)))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "requires a v2 binary") {
		t.Fatalf("wrong result: %d %s", w.Code, w.Body.String())
	}
}
