package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/pty"
)

func setupMockOpenCode(t *testing.T, serviceStatus string) {
	t.Helper()
	withTempConfig(t)
	oldCoders, oldPTY := coderManager, ptyManager
	t.Cleanup(func() {
		coderManager = oldCoders
		ptyManager = oldPTY
		invalidateOpenCodeServiceCache()
	})
	coderManager = coders.NewManager()
	ptyManager = pty.NewManager()
	c, _ := coderManager.Get("opencode")
	c.Command = os.Args[0]
	c.Env = map[string]string{"PHI_TEST_ROOT_OC_SERVICE": serviceStatus}
	coderManager.Add(c)
	invalidateOpenCodeServiceCache()
}

func TestOpenCodeServiceStatusRunning(t *testing.T) {
	setupMockOpenCode(t, "http://127.0.0.1:49374")

	w := httptest.NewRecorder()
	handleOpenCodeService(w, httptest.NewRequest(http.MethodGet, "/api/opencode/service", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var res map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["supported"] != true {
		t.Fatalf("expected supported: true, got %v", res["supported"])
	}
	if res["running"] != true {
		t.Fatalf("expected running: true, got %v", res["running"])
	}
	if res["tabs"] != float64(0) {
		t.Fatalf("expected 0 tabs, got %v", res["tabs"])
	}
}

func TestOpenCodeServiceStatusStopped(t *testing.T) {
	setupMockOpenCode(t, "stopped")

	w := httptest.NewRecorder()
	handleOpenCodeService(w, httptest.NewRequest(http.MethodGet, "/api/opencode/service", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var res map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["supported"] != true {
		t.Fatalf("expected supported: true, got %v", res["supported"])
	}
	if res["running"] != false {
		t.Fatalf("expected running: false, got %v", res["running"])
	}
}

func TestOpenCodeServiceStopConflictWhenTabsActive(t *testing.T) {
	setupMockOpenCode(t, "http://127.0.0.1:49374")

	// Inject a simulated active OpenCode instance into ptyManager
	ptyManager.AddInstanceForTesting(&pty.PTYInstance{
		ID:        "test-pane-1",
		Coder:     "opencode",
		SessionID: "sess-1",
		Pty:       &pty.Pty{},
	})

	w := httptest.NewRecorder()
	handleOpenCodeServiceStop(w, httptest.NewRequest(http.MethodPost, "/api/opencode/service/stop", strings.NewReader(`{}`)))
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d: %s", w.Code, w.Body.String())
	}
	var res map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["error"] != "open_tabs" {
		t.Fatalf("expected error: open_tabs, got %v", res["error"])
	}
	if res["tabs"] != float64(1) {
		t.Fatalf("expected tabs: 1, got %v", res["tabs"])
	}

	// Now with force: true, it should succeed
	wForce := httptest.NewRecorder()
	handleOpenCodeServiceStop(wForce, httptest.NewRequest(http.MethodPost, "/api/opencode/service/stop", strings.NewReader(`{"force":true}`)))
	if wForce.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on force, got %d: %s", wForce.Code, wForce.Body.String())
	}
	var resForce map[string]interface{}
	if err := json.Unmarshal(wForce.Body.Bytes(), &resForce); err != nil {
		t.Fatal(err)
	}
	if resForce["stopped"] != true {
		t.Fatalf("expected stopped: true, got %v", resForce["stopped"])
	}
}

func TestOpenCodeServiceStopWhenNoTabs(t *testing.T) {
	setupMockOpenCode(t, "http://127.0.0.1:49374")

	w := httptest.NewRecorder()
	handleOpenCodeServiceStop(w, httptest.NewRequest(http.MethodPost, "/api/opencode/service/stop", strings.NewReader(`{}`)))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", w.Code, w.Body.String())
	}
	var res map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["stopped"] != true {
		t.Fatalf("expected stopped: true, got %v", res["stopped"])
	}
}

func TestOpenCodeServiceUnsupportedOnLegacy(t *testing.T) {
	withTempConfig(t)
	oldCoders := coderManager
	t.Cleanup(func() {
		coderManager = oldCoders
		invalidateOpenCodeServiceCache()
	})
	coderManager = coders.NewManagerWithOptions(coders.BuiltinOptions{OpenCodeLegacy: true})
	invalidateOpenCodeServiceCache()

	w := httptest.NewRecorder()
	handleOpenCodeService(w, httptest.NewRequest(http.MethodGet, "/api/opencode/service", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var res map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["supported"] != false {
		t.Fatalf("expected supported: false, got %v", res["supported"])
	}
}

func TestOpenCodeServiceMethodNotAllowed(t *testing.T) {
	setupMockOpenCode(t, "stopped")

	wGet := httptest.NewRecorder()
	handleOpenCodeServiceStop(wGet, httptest.NewRequest(http.MethodGet, "/api/opencode/service/stop", nil))
	if wGet.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", wGet.Code)
	}

	wPost := httptest.NewRecorder()
	handleOpenCodeService(wPost, httptest.NewRequest(http.MethodPost, "/api/opencode/service", nil))
	if wPost.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", wPost.Code)
	}
}
