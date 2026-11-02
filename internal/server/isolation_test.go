package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/internal/config"
)

// Exercise the public boundary of two independent apps. Registering routes,
// changing config, saving history, and draining one must not alter the other.
func TestHandlersKeepApplicationStateIndependent(t *testing.T) {
	var apps []*Server
	for range 2 {
		root := t.TempDir()
		store := config.NewStore(config.Paths{Primary: filepath.Join(root, "config.toml")}, nil)
		app := New(Options{Config: store, CWD: root})
		app.Handler()
		entries, err := os.ReadDir(root)
		if err != nil || len(entries) != 0 {
			t.Fatalf("New/Handler wrote state: %v, %v", entries, err)
		}
		if err := app.accessManager.Configure(""); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(app.accessManager.Close)
		// Flush before TempDir cleanup; a debounced write belongs to this app.
		t.Cleanup(func() {
			if err := app.flushSyncStore(); err != nil {
				t.Error(err)
			}
		})
		apps = append(apps, app)
	}
	call := func(app *Server, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		return w
	}
	for i, app := range apps {
		theme := []string{"blue", "gold"}[i]
		call(app, http.MethodPost, "/api/config/theme", `{"color":"`+theme+`"}`)
		call(app, http.MethodPost, "/api/sync/messages", `{"key":"shared-key","value":"`+theme+`"}`)
		call(app, http.MethodPost, "/api/prompt-history/append", `{"text":"`+theme+`","cwd":"/fixture"}`)
	}
	for i, app := range apps {
		want := []string{"blue", "gold"}[i]
		var cfg struct {
			Theme string `json:"theme_color"`
		}
		if err := json.Unmarshal(call(app, http.MethodGet, "/api/config", "").Body.Bytes(), &cfg); err != nil {
			t.Fatal(err)
		}
		if cfg.Theme != want {
			t.Fatalf("app %d config = %q, want %q", i, cfg.Theme, want)
		}
		var msg SyncMessage
		if err := json.Unmarshal(call(app, http.MethodGet, "/api/sync/messages/shared-key", "").Body.Bytes(), &msg); err != nil {
			t.Fatal(err)
		}
		if msg.Value != want {
			t.Fatalf("app %d sync = %q, want %q", i, msg.Value, want)
		}
		history := call(app, http.MethodGet, "/api/prompt-history/recent?cwd=/fixture", "").Body.String()
		if !strings.Contains(history, want) || strings.Contains(history, []string{"gold", "blue"}[i]) {
			t.Fatalf("app %d history = %s", i, history)
		}
		if err := app.flushSyncStore(); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{app.SyncFilePath(), app.PromptHistoryPath()} {
			if filepath.Dir(path) != app.stateDir() {
				t.Fatalf("state path escaped app %d: %s", i, path)
			}
			data, err := os.ReadFile(path)
			if err != nil || !strings.Contains(string(data), want) {
				t.Fatalf("app %d persisted %s = %q, %v", i, path, data, err)
			}
		}
	}
	apps[0].shuttingDown.Store(true)
	for i, app := range apps {
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		want := []int{http.StatusServiceUnavailable, http.StatusOK}[i]
		if w.Code != want {
			t.Fatalf("app %d readiness = %d, want %d", i, w.Code, want)
		}
	}
}
