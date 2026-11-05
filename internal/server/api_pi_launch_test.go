package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/pty"
)

// withFakePsi puts an executable named psi on PATH and returns its path.
// The fake is never executed: the availability check only looks it up.
func withFakePsi(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	name := "psi"
	if runtime.GOOS == "windows" {
		name = "psi.exe"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return path
}

// withoutPsi removes psi from PATH by pointing PATH at an empty directory.
func withoutPsi(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
}

// setStoredPiDefault writes the launch field the way the feature endpoint
// does. SaveLegacy deliberately preserves it, so a test cannot use it here.
func setStoredPiDefault(t *testing.T, mode string) {
	t.Helper()
	if _, err := testStore.Update(func(cfg *config.Config) error { cfg.PiDefaultMode = mode; return nil }); err != nil {
		t.Fatal(err)
	}
}

// piLaunchRequest drives the real handler and returns the decoded state.
func piLaunchRequest(t *testing.T, method, body, contentType string, want int) PiLaunchState {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, "/api/config/pi-launch", reader)
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	testServer.handlePiLaunch(w, r)
	if w.Code != want {
		t.Fatalf("%s %s: status=%d want=%d body=%s", method, body, w.Code, want, w.Body.String())
	}
	if want != http.StatusOK && want != http.StatusConflict {
		return PiLaunchState{}
	}
	var state PiLaunchState
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatalf("decode state: %v body=%s", err, w.Body.String())
	}
	return state
}

// TestPiLaunchModeResolution pins the launch-time precedence: explicit mode,
// then the legacy boolean, then the saved default, then Pi.
func TestPiLaunchModeResolution(t *testing.T) {
	pi, _ := coders.NewManager().Get("pi")
	for _, test := range []struct {
		name     string
		explicit string
		legacy   bool
		saved    string
		command  string
		want     string
		wantCmd  string
		wantErr  bool
	}{
		{name: "empty config", want: "pi", wantCmd: "pi"},
		{name: "saved psi", saved: "psi", want: "psi", wantCmd: "psi"},
		{name: "saved psi with command", saved: "psi", command: "/opt/psi", want: "psi", wantCmd: "/opt/psi"},
		{name: "legacy flag beats pi default", legacy: true, want: "psi", wantCmd: "psi"},
		{name: "explicit pi under psi default", explicit: "pi", saved: "psi", want: "pi", wantCmd: "pi"},
		{name: "explicit psi under pi default", explicit: "psi", want: "psi", wantCmd: "psi"},
		{name: "empty explicit keeps saved default", explicit: "", saved: "psi", want: "psi", wantCmd: "psi"},
		{name: "explicit pi ignores invalid saved default", explicit: "pi", saved: "bogus", want: "pi", wantCmd: "pi"},
		{name: "invalid explicit", explicit: "bogus", wantErr: true},
		{name: "invalid saved default with no override", saved: "bogus", wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := selectPiLaunch(pi, test.explicit, test.legacy, config.Config{PiDefaultMode: test.saved, PsiCommand: test.command})
			if test.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode := effectivePiMode(got); mode != test.want {
				t.Fatalf("mode=%q want=%q", mode, test.want)
			}
			if got.Command != test.wantCmd {
				t.Fatalf("command=%q want=%q", got.Command, test.wantCmd)
			}
		})
	}
	// A cleared Psi command must fall back to PATH lookup rather than the
	// registry's startup value.
	withCommand, _ := coders.NewManagerWithOptions(coders.BuiltinOptions{PsiCommand: "/startup/psi"}).Get("pi")
	cleared, err := selectPiLaunch(withCommand, "psi", false, config.Config{PsiCommand: ""})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Command != "psi" {
		t.Fatalf("cleared command kept %q", cleared.Command)
	}
	// Non-Pi profiles pass through untouched.
	if got, err := selectPiLaunch(coders.Coder{ID: "bash"}, "psi", false, config.Config{}); err != nil || got.ID != "bash" {
		t.Fatalf("non-pi coder changed: %+v err=%v", got, err)
	}
}

// TestPiLaunchSettingsEndpoint covers the persisted default, revision
// conflicts, validation, and the Psi availability gate.
func TestPiLaunchSettingsEndpoint(t *testing.T) {
	withTempConfig(t)
	state := piLaunchRequest(t, http.MethodGet, "", "", http.StatusOK)
	if state.Revision != 0 || state.PiDefaultMode != "pi" || state.PsiCommand != "" {
		t.Fatalf("unexpected default state: %+v", state)
	}

	// A missing Psi installation rejects the Psi default without mutating it,
	// and must not block recovery to Pi.
	withoutPsi(t)
	piLaunchRequest(t, http.MethodPost, `{"revision":0,"fields":{"pi_default_mode":"psi"}}`, "application/json", http.StatusBadRequest)
	if cfg := testServer.loadConfig(); cfg.PiDefaultMode != "" || cfg.PiLaunchRevision != 0 {
		t.Fatalf("rejected save mutated config: %+v", cfg)
	}
	state = piLaunchRequest(t, http.MethodPost, `{"revision":0,"fields":{"pi_default_mode":"pi"}}`, "application/json; charset=utf-8", http.StatusOK)
	if state.Revision != 1 || state.PiDefaultMode != "pi" {
		t.Fatalf("pi recovery failed: %+v", state)
	}

	withFakePsi(t)
	state = piLaunchRequest(t, http.MethodPost, `{"revision":1,"fields":{"pi_default_mode":"psi"}}`, "application/json", http.StatusOK)
	if state.Revision != 2 || state.PiDefaultMode != "psi" {
		t.Fatalf("psi default not saved: %+v", state)
	}

	// A stale revision reports current state and changes nothing.
	state = piLaunchRequest(t, http.MethodPost, `{"revision":1,"fields":{"pi_default_mode":"pi"}}`, "application/json", http.StatusConflict)
	if state.Revision != 2 || state.PiDefaultMode != "psi" {
		t.Fatalf("conflict lost current state: %+v", state)
	}
	if cfg := testServer.loadConfig(); cfg.PiDefaultMode != "psi" || cfg.PiLaunchRevision != 2 {
		t.Fatalf("conflict wrote config: %+v", cfg)
	}

	// Every rejected body leaves the stored state alone.
	for _, body := range []string{
		`{}`,
		`{"revision":2}`,
		`{"fields":{"pi_default_mode":"pi"}}`,
		`{"revision":2,"fields":{}}`,
		`{"revision":2,"fields":{"pi_default_mode":null}}`,
		`{"revision":2,"fields":{"pi_default_mode":true}}`,
		`{"revision":2,"fields":{"pi_default_mode":"bogus"}}`,
		`{"revision":2,"fields":{"nope":"x"}}`,
		`{"revision":2,"fields":{"pi_default_mode":"pi"}} {}`,
		`{"revision":9007199254740992,"fields":{"pi_default_mode":"pi"}}`,
		`{"revision":-1,"fields":{"pi_default_mode":"pi"}}`,
		`null`,
	} {
		piLaunchRequest(t, http.MethodPost, body, "application/json", http.StatusBadRequest)
	}
	piLaunchRequest(t, http.MethodPost, `{"revision":2,"fields":{"pi_default_mode":"pi"}}`, "text/plain", http.StatusUnsupportedMediaType)
	piLaunchRequest(t, http.MethodPost, `{"revision":2,"fields":{"pi_default_mode":"pi"}}`, "", http.StatusUnsupportedMediaType)
	big := `{"revision":2,"fields":{"pi_default_mode":"` + strings.Repeat("p", piLaunchBodyLimit) + `"}}`
	piLaunchRequest(t, http.MethodPost, big, "application/json", http.StatusRequestEntityTooLarge)
	if cfg := testServer.loadConfig(); cfg.PiDefaultMode != "psi" || cfg.PiLaunchRevision != 2 {
		t.Fatalf("rejected bodies wrote config: %+v", cfg)
	}

	// An earlier full-config snapshot must not erase the launch settings.
	stale := testServer.loadConfig()
	stale.ThemeColor = "ocean"
	testServer.saveConfig(stale)
	cfg := testServer.loadConfig()
	if cfg.PiDefaultMode != "psi" || cfg.PiLaunchRevision != 2 || cfg.PsiCommand != "" {
		t.Fatalf("legacy save erased launch settings: %+v", cfg)
	}
	if cfg.ThemeColor != "ocean" {
		t.Fatalf("legacy save lost its own field: %+v", cfg)
	}

	// A launch field edited between the read and the commit must produce a
	// conflict, not a commit against a snapshot that no longer exists.
	racing := func(mutate func(*config.Config) error) (config.Config, error) {
		if _, err := testStore.Update(func(cfg *config.Config) error {
			cfg.PsiCommand = "/changed/during/request"
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return testServer.configStore().Update(mutate)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/config/pi-launch", strings.NewReader(`{"revision":2,"fields":{"pi_default_mode":"pi"}}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	testServer.servePiLaunch(w, r, racing)
	if w.Code != http.StatusConflict {
		t.Fatalf("drift reported %d %s", w.Code, w.Body.String())
	}
	if cfg := testServer.loadConfig(); cfg.PiDefaultMode != "psi" || cfg.PiLaunchRevision != 2 || cfg.PsiCommand != "/changed/during/request" {
		t.Fatalf("drifted field was overwritten: %+v", cfg)
	}
}

// TestPiLaunchSettingsFailures pins the 500 paths: an unreadable config is
// never reported as a Pi default, and a failed write is never reported Saved.
func TestPiLaunchSettingsFailures(t *testing.T) {
	path := withTempConfig(t)
	if err := os.WriteFile(path, []byte("not = [valid toml"), 0o600); err != nil {
		t.Fatal(err)
	}
	testStore.ResetCache()
	piLaunchRequest(t, http.MethodGet, "", "", http.StatusInternalServerError)
	piLaunchRequest(t, http.MethodPost, `{"revision":0,"fields":{"pi_default_mode":"pi"}}`, "application/json", http.StatusInternalServerError)

	withTempConfig(t)
	failing := func(func(*config.Config) error) (config.Config, error) {
		return config.Config{}, errors.New("disk on fire")
	}
	r := httptest.NewRequest(http.MethodPost, "/api/config/pi-launch", strings.NewReader(`{"revision":0,"fields":{"pi_default_mode":"pi"}}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	testServer.servePiLaunch(w, r, failing)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("write failure reported %d %s", w.Code, w.Body.String())
	}
	if cfg := testServer.loadConfig(); cfg.PiLaunchRevision != 0 {
		t.Fatalf("failed write advanced revision: %+v", cfg)
	}
}

// TestPiLaunchReattachIsModeIsolated drives the real spawn handler against
// loaded panes: a request must never attach to the other agent's pane.
func TestPiLaunchReattachIsModeIsolated(t *testing.T) {
	for _, test := range []struct {
		name      string
		saved     string
		body      string
		wantPane  string
		wantReply string
	}{
		{name: "explicit pi skips psi pane", saved: "psi", body: `{"coder":"pi","session_id":"same","pi_mode":"pi"}`, wantPane: "pi-pane", wantReply: "pi"},
		{name: "explicit psi skips pi pane", saved: "pi", body: `{"coder":"pi","session_id":"same","pi_mode":"psi"}`, wantPane: "psi-pane", wantReply: "psi"},
		{name: "default psi picks psi pane", saved: "psi", body: `{"coder":"pi","session_id":"same"}`, wantPane: "psi-pane", wantReply: "psi"},
		{name: "default pi picks legacy pi pane", saved: "pi", body: `{"coder":"pi","session_id":"same"}`, wantPane: "pi-pane", wantReply: "pi"},
		{name: "legacy flag picks psi pane", saved: "pi", body: `{"coder":"pi","session_id":"same","pi_psi":true}`, wantPane: "psi-pane", wantReply: "psi"},
	} {
		t.Run(test.name, func(t *testing.T) {
			withTempConfig(t)
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("USERPROFILE", home)
			if err := os.MkdirAll(filepath.Join(home, ".phi"), 0o755); err != nil {
				t.Fatal(err)
			}
			tabs := `[{"id":"pi-pane","coder":"pi","session_id":"same"},{"id":"psi-pane","coder":"pi","session_id":"same","pi_mode":"psi"}]`
			if err := os.WriteFile(filepath.Join(home, ".phi", "tabs.json"), []byte(tabs), 0o600); err != nil {
				t.Fatal(err)
			}
			oldCoders, oldPTY := testServer.coders, testServer.pty
			t.Cleanup(func() { testServer.coders = oldCoders; testServer.pty = oldPTY })
			testServer.coders = coders.NewManager()
			testServer.pty = pty.NewManager()
			if err := testServer.pty.LoadState(); err != nil {
				t.Fatal(err)
			}

			setStoredPiDefault(t, test.saved)

			w := httptest.NewRecorder()
			testServer.handleSpawnTerminal(w, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(test.body)))
			var reply map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil {
				t.Fatalf("decode reply: %v body=%s", err, w.Body.String())
			}
			if w.Code != http.StatusOK || reply["pane_id"] != test.wantPane || reply["pi_mode"] != test.wantReply || reply["new_pane"] != false {
				t.Fatalf("wrong reattach: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

// TestPiLaunchRejectsModeForOtherCoders keeps pi_mode scoped to the Pi profile.
func TestPiLaunchRejectsModeForOtherCoders(t *testing.T) {
	withTempConfig(t)
	before := testServer.coders
	t.Cleanup(func() { testServer.coders = before })
	testServer.coders = coders.NewManager()
	for _, body := range []string{
		`{"coder":"bash","pi_mode":"psi"}`,
		`{"coder":"opencode","pi_mode":"pi"}`,
		`{"coder":"pi","pi_mode":"bogus"}`,
	} {
		w := httptest.NewRecorder()
		testServer.handleSpawnTerminal(w, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(body)))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d body=%s", body, w.Code, w.Body.String())
		}
	}
}
