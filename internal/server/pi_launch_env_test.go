package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/coders"
)

// piLaunchRequestRaw drives the handler and returns the raw recorder so a test
// can assert the message, not only the status.
func piLaunchRequestRaw(t *testing.T, method, body, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "/api/config/pi-launch", strings.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	testServer.handlePiLaunch(w, r)
	return w
}

// TestPiLaunchPsiFieldsRoundTrip stores a command, args, and env through the
// endpoint and proves they come back unchanged, including after a stale legacy
// config save that knows nothing about the new fields.
func TestPiLaunchPsiFieldsRoundTrip(t *testing.T) {
	withTempConfig(t)
	withFakePsi(t)

	fileArg := filepath.Join(t.TempDir(), "has space", "prompt.txt")
	if err := os.MkdirAll(filepath.Dir(fileArg), 0o755); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"revision": 0,
		"fields": map[string]any{
			"pi_default_mode": "psi",
			"psi_command":     "psi",
			"psi_args":        []string{"--model", "space value", fileArg},
			"psi_env":         map[string]string{"PSI_TRACE": "1", "PSI_HOME": "/tmp/psi home"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	state := piLaunchRequest(t, http.MethodPost, string(body), "application/json", http.StatusOK)
	if state.Revision != 1 || state.PiDefaultMode != "psi" {
		t.Fatalf("unexpected saved state: %+v", state)
	}
	if got := strings.Join(state.PsiArgs, "\x00"); got != strings.Join([]string{"--model", "space value", fileArg}, "\x00") {
		t.Fatalf("args not preserved: %q", state.PsiArgs)
	}
	if state.PsiEnv["PSI_TRACE"] != "1" || state.PsiEnv["PSI_HOME"] != "/tmp/psi home" {
		t.Fatalf("env not preserved: %+v", state.PsiEnv)
	}

	// An older client that saves the whole config still must not erase launch
	// settings it never heard of.
	testStore.SaveLegacy(config.Config{})
	reloaded := piLaunchRequest(t, http.MethodGet, "", "", http.StatusOK)
	if reloaded.Revision != 1 || reloaded.PsiCommand != "psi" ||
		len(reloaded.PsiArgs) != 3 || reloaded.PsiEnv["PSI_TRACE"] != "1" {
		t.Fatalf("legacy save erased launch settings: %+v", reloaded)
	}
}

// TestPiLaunchRejectsInvalidPsiFields keeps malformed launch fields out of the
// config file entirely.
func TestPiLaunchRejectsInvalidPsiFields(t *testing.T) {
	withTempConfig(t)
	withFakePsi(t)
	saved := piLaunchRequest(t, http.MethodPost, `{"revision":0,"fields":{"psi_command":"psi"}}`, "application/json", http.StatusOK)
	if saved.Revision != 1 {
		t.Fatalf("setup failed: %+v", saved)
	}

	for _, test := range []struct {
		name   string
		fields string
		want   string
	}{
		{name: "empty arg", fields: `{"psi_args":["--model",""]}`, want: "empty"},
		{name: "newline arg", fields: `{"psi_args":["a\nb"]}`, want: "NUL or line breaks"},
		{name: "nul arg", fields: `{"psi_args":["a\u0000b"]}`, want: "NUL or line breaks"},
		{name: "non-string arg", fields: `{"psi_args":[7]}`, want: "array of strings"},
		{name: "null arg", fields: `{"psi_args":[null]}`, want: "must be a string"},
		{name: "args object", fields: `{"psi_args":{"a":"b"}}`, want: "array of strings"},
		{name: "bad env key start", fields: `{"psi_env":{"1BAD":"x"}}`, want: "must match"},
		{name: "bad env key char", fields: `{"psi_env":{"BAD-KEY":"x"}}`, want: "must match"},
		{name: "reserved path", fields: `{"psi_env":{"PATH":"/tmp"}}`, want: "cannot be overridden"},
		{name: "reserved path case", fields: `{"psi_env":{"Path":"/tmp"}}`, want: "cannot be overridden"},
		{name: "reserved clipboard", fields: `{"psi_env":{"PHI_CLIPBOARD_FILE":"/tmp/x"}}`, want: "cannot be overridden"},
		{name: "reserved colorterm", fields: `{"psi_env":{"COLORTERM":"24bit"}}`, want: "cannot be overridden"},
		{name: "reserved bridge", fields: `{"psi_env":{"PHI_PI_BRIDGE_SESSION_ID":"x"}}`, want: "cannot be overridden"},
		{name: "reserved attachment root", fields: `{"psi_env":{"PHI_PI_ATTACHMENT_ROOT":"/tmp"}}`, want: "cannot be overridden"},
		{name: "duplicate env case", fields: `{"psi_env":{"FOO":"1","foo":"2"}}`, want: "case-insensitive"},
		{name: "non-string env value", fields: `{"psi_env":{"FOO":1}}`, want: "must be a string"},
		{name: "null env value", fields: `{"psi_env":{"FOO":null}}`, want: "must be a string"},
		{name: "env array", fields: `{"psi_env":["FOO=1"]}`, want: "object of strings"},
		{name: "env newline value", fields: `{"psi_env":{"FOO":"a\nb"}}`, want: "NUL or line breaks"},
		{name: "command newline", fields: `{"psi_command":"psi\nrm"}`, want: "NUL or line breaks"},
		{name: "changed relative path", fields: `{"psi_command":"bin/psi"}`, want: "absolute path"},
		{name: "changed dot relative", fields: `{"psi_command":"./psi"}`, want: "absolute path"},
		{name: "changed home relative", fields: `{"psi_command":"~/psi"}`, want: "absolute path"},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := piLaunchRequestRaw(t, http.MethodPost, `{"revision":1,"fields":`+test.fields+`}`, "application/json")
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status=%d want=400 body=%s", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), test.want) {
				t.Fatalf("body=%q does not mention %q", w.Body.String(), test.want)
			}
		})
	}

	if cfg := testServer.loadConfig(); cfg.PiLaunchRevision != 1 || len(cfg.PsiArgs) != 0 || len(cfg.PsiEnv) != 0 || cfg.PsiCommand != "psi" {
		t.Fatalf("a rejected save changed the config: %+v", cfg)
	}
}

// TestPiLaunchUnchangedRelativeCommandStillWorks keeps an existing relative
// command usable: the stricter form only applies to a changed value.
func TestPiLaunchUnchangedRelativeCommandStillWorks(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	relative := filepath.Join("tools", "psi")
	name := "psi"
	if runtime.GOOS == "windows" {
		name = "psi.exe"
		relative = filepath.Join("tools", name)
	}
	if err := os.MkdirAll(filepath.Join(dir, "tools"), 0o755); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, relative)
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The lookup resolves a relative command against the working directory, so
	// the test must own it for the duration.
	t.Chdir(dir)
	t.Setenv("PATH", dir)

	if _, err := testStore.Update(func(cfg *config.Config) error { cfg.PsiCommand = relative; return nil }); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{"revision": 0, "fields": map[string]string{"psi_command": relative}})
	if err != nil {
		t.Fatal(err)
	}
	state := piLaunchRequest(t, http.MethodPost, string(body), "application/json", http.StatusOK)
	if state.PsiCommand != relative {
		t.Fatalf("unchanged relative command was not kept: %+v", state)
	}

	// The same shape is refused once the user changes it.
	w := piLaunchRequestRaw(t, http.MethodPost, `{"revision":1,"fields":{"psi_command":"other/psi"}}`, "application/json")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "absolute path") {
		t.Fatalf("changed relative command accepted: %d %s", w.Code, w.Body.String())
	}
}

// TestPiLaunchFieldEditsRequirePsi rejects a Psi field edit that would leave a
// command nobody can run, while Pi recovery stays possible without Psi.
func TestPiLaunchFieldEditsRequirePsi(t *testing.T) {
	withTempConfig(t)
	withoutPsi(t)

	for _, fields := range []string{
		`{"psi_args":["--model","x"]}`,
		`{"psi_env":{"PSI_TRACE":"1"}}`,
		`{"psi_command":"/nonexistent/psi"}`,
	} {
		w := piLaunchRequestRaw(t, http.MethodPost, `{"revision":0,"fields":`+fields+`}`, "application/json")
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "is not available") {
			t.Fatalf("%s: status=%d body=%s", fields, w.Code, w.Body.String())
		}
	}
	if cfg := testServer.loadConfig(); cfg.PiLaunchRevision != 0 {
		t.Fatalf("a rejected save advanced the revision: %+v", cfg)
	}

	state := piLaunchRequest(t, http.MethodPost, `{"revision":0,"fields":{"pi_default_mode":"pi"}}`, "application/json", http.StatusOK)
	if state.PiDefaultMode != "pi" {
		t.Fatalf("Pi recovery blocked without Psi: %+v", state)
	}
}

// TestPiLaunchDetectsFieldDrift catches a launch field edited between the read
// and the commit, which would otherwise commit a lookup for another command.
func TestPiLaunchDetectsFieldDrift(t *testing.T) {
	withTempConfig(t)
	withFakePsi(t)

	if _, err := testStore.Update(func(cfg *config.Config) error { cfg.PiLaunchRevision = 3; return nil }); err != nil {
		t.Fatal(err)
	}
	racing := func(mutate func(*config.Config) error) (config.Config, error) {
		if _, err := testStore.Update(func(cfg *config.Config) error {
			cfg.PsiEnv = map[string]string{"PSI_TRACE": "hand"}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return testServer.configStore().Update(mutate)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/config/pi-launch", strings.NewReader(`{"revision":3,"fields":{"psi_args":["--model","x"]}}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	testServer.servePiLaunch(w, r, racing)
	if w.Code != http.StatusConflict {
		t.Fatalf("drift reported %d %s", w.Code, w.Body.String())
	}
	if cfg := testServer.loadConfig(); cfg.PsiEnv["PSI_TRACE"] != "hand" || len(cfg.PsiArgs) != 0 || cfg.PiLaunchRevision != 3 {
		t.Fatalf("drift was overwritten: %+v", cfg)
	}
}

// TestMergePsiEnv covers the platform difference in environment names and the
// no-removal rule.
func TestMergePsiEnv(t *testing.T) {
	base := map[string]string{"PATH": "/usr/bin", "Foo": "base", "KEEP": "1"}
	overrides := map[string]string{"FOO": "override", "ADDED": "2"}

	unix := mergeLaunchEnv(base, overrides, false)
	if unix["Foo"] != "base" || unix["FOO"] != "override" {
		t.Fatalf("unix merge must stay case-sensitive: %+v", unix)
	}

	windows := mergeLaunchEnv(base, overrides, true)
	if _, ok := windows["Foo"]; ok {
		t.Fatalf("windows merge kept a differently cased base key: %+v", windows)
	}
	if windows["FOO"] != "override" || windows["ADDED"] != "2" || windows["KEEP"] != "1" || windows["PATH"] != "/usr/bin" {
		t.Fatalf("windows merge lost inherited values: %+v", windows)
	}

	// The caller's maps are never mutated: the same coder is reused per launch.
	if base["Foo"] != "base" || len(base) != 3 {
		t.Fatalf("base map mutated: %+v", base)
	}
	if _, ok := overrides["ADDED"]; !ok || len(overrides) != 2 {
		t.Fatalf("override map mutated: %+v", overrides)
	}
}

// TestSelectPiLaunchAppliesArgsAndEnv proves the configured values reach the
// coder that will be executed, and only for a Psi launch.
func TestSelectPiLaunchAppliesArgsAndEnv(t *testing.T) {
	pi, _ := coders.NewManager().Get("pi")
	pi.Args = []string{"--offline"}
	pi.Env = map[string]string{"PSI_TRACE": "base", "KEEP": "1"}
	cfg := config.Config{
		PiDefaultMode: "psi",
		PsiCommand:    "psi",
		PsiArgs:       []string{"--model", "space value"},
		PsiEnv:        map[string]string{"PSI_TRACE": "override", "ADDED": "2"},
	}

	got, err := selectPiLaunch(pi, "", false, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got.Args, "\x00") != strings.Join([]string{"--offline", "--model", "space value"}, "\x00") {
		t.Fatalf("args=%q", got.Args)
	}
	if got.Env["PSI_TRACE"] != "override" || got.Env["ADDED"] != "2" || got.Env["KEEP"] != "1" {
		t.Fatalf("env=%+v", got.Env)
	}
	// The registry coder is a shared value: a launch must not write into it.
	if len(pi.Args) != 1 || pi.Env["PSI_TRACE"] != "base" || len(pi.Env) != 2 {
		t.Fatalf("launch mutated the source coder: args=%q env=%+v", pi.Args, pi.Env)
	}

	piAgain, _ := coders.NewManager().Get("pi")
	piDefault, err := selectPiLaunch(piAgain, "pi", false, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(piDefault.Args) != 0 || len(piDefault.Env) != 0 || piDefault.PiMode == "psi" {
		t.Fatalf("Psi launch fields leaked into a Pi launch: %+v", piDefault)
	}
}

// TestPiLaunchPiFieldsRoundTrip stores the Pi launch settings, proves they are
// stored beside the Psi settings rather than replacing them, and that saving
// one agent's fields leaves the other agent's fields untouched.
func TestPiLaunchPiFieldsRoundTrip(t *testing.T) {
	withTempConfig(t)
	withFakePsi(t)

	self := os.Args[0]
	body, err := json.Marshal(map[string]any{
		"revision": 0,
		"fields": map[string]any{
			"pi_command": self,
			"pi_args":    []string{"--model", "space value"},
			"pi_env":     map[string]string{"PI_LOG_LEVEL": "debug"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	state := piLaunchRequest(t, http.MethodPost, string(body), "application/json", http.StatusOK)
	if state.Revision != 1 || state.PiDefaultMode != "pi" {
		t.Fatalf("unexpected saved state: %+v", state)
	}
	if state.PiCommand != self || strings.Join(state.PiArgs, "\x00") != "--model\x00space value" {
		t.Fatalf("pi fields not preserved: %+v", state)
	}
	if state.PiEnv["PI_LOG_LEVEL"] != "debug" {
		t.Fatalf("pi env not preserved: %+v", state.PiEnv)
	}
	if state.PsiCommand != "" || len(state.PsiArgs) != 0 || len(state.PsiEnv) != 0 {
		t.Fatalf("pi save wrote psi fields: %+v", state)
	}

	// Saving Psi fields later must not disturb the Pi fields.
	state = piLaunchRequest(t, http.MethodPost, `{"revision":1,"fields":{"psi_command":"psi"}}`, "application/json", http.StatusOK)
	if state.Revision != 2 || state.PsiCommand != "psi" {
		t.Fatalf("psi save failed: %+v", state)
	}
	if state.PiCommand != self || len(state.PiArgs) != 2 || state.PiEnv["PI_LOG_LEVEL"] != "debug" {
		t.Fatalf("psi save overwrote pi fields: %+v", state)
	}
	// A stale legacy save must not erase either set.
	testStore.SaveLegacy(config.Config{})
	reloaded := piLaunchRequest(t, http.MethodGet, "", "", http.StatusOK)
	if reloaded.PiCommand != self || reloaded.PsiCommand != "psi" || len(reloaded.PiArgs) != 2 {
		t.Fatalf("legacy save erased per-agent settings: %+v", reloaded)
	}
}

// TestPiLaunchRejectsInvalidPiFields applies the same syntax rules to the Pi
// settings and never reports an environment value.
func TestPiLaunchRejectsInvalidPiFields(t *testing.T) {
	withTempConfig(t)

	for _, test := range []struct {
		name   string
		fields string
		want   string
	}{
		{name: "reserved env", fields: `{"pi_env":{"PATH":"/tmp"}}`, want: "cannot be overridden"},
		{name: "reserved bridge env", fields: `{"pi_env":{"PHI_PI_BRIDGE_MODE":"x"}}`, want: "cannot be overridden"},
		{name: "duplicate env", fields: `{"pi_env":{"Foo":"a","FOO":"b"}}`, want: "case-insensitive"},
		{name: "empty arg", fields: `{"pi_args":["--model",""]}`, want: "empty"},
		{name: "relative command", fields: `{"pi_command":"other/pi"}`, want: "absolute path"},
		{name: "missing command", fields: `{"pi_command":"/nonexistent/pi"}`, want: "is not available"},
	} {
		w := piLaunchRequestRaw(t, http.MethodPost, `{"revision":0,"fields":`+test.fields+`}`, "application/json")
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), test.want) {
			t.Fatalf("%s: status=%d body=%s", test.name, w.Code, w.Body.String())
		}
	}
	if cfg := testServer.loadConfig(); cfg.PiLaunchRevision != 0 || cfg.PiCommand != "" {
		t.Fatalf("a rejected Pi save wrote config: %+v", cfg)
	}
}

// TestSelectPiLaunchAppliesPiSettings proves each agent receives only its own
// stored executable, arguments, and environment.
func TestSelectPiLaunchAppliesPiSettings(t *testing.T) {
	pi, _ := coders.NewManager().Get("pi")
	cfg := config.Config{
		PiDefaultMode: "pi",
		PiCommand:     "/opt/pi",
		PiArgs:        []string{"--model", "space value"},
		PiEnv:         map[string]string{"PI_LOG_LEVEL": "debug"},
		PsiCommand:    "/opt/psi",
		PsiArgs:       []string{"--psi-only"},
		PsiEnv:        map[string]string{"PSI_ONLY": "1"},
	}

	got, err := selectPiLaunch(pi, "pi", false, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got.Command != "/opt/pi" {
		t.Fatalf("command=%q", got.Command)
	}
	if strings.Join(got.Args, "\x00") != "--model\x00space value" {
		t.Fatalf("args=%q", got.Args)
	}
	if got.Env["PI_LOG_LEVEL"] != "debug" {
		t.Fatalf("env=%+v", got.Env)
	}
	if _, leaked := got.Env["PSI_ONLY"]; leaked {
		t.Fatalf("psi env leaked into a Pi launch: %+v", got.Env)
	}

	// An empty Pi command keeps the registry executable instead of blanking it;
	// an empty Psi command still falls back to PATH lookup.
	piDefault, err := selectPiLaunch(pi, "pi", false, config.Config{PiDefaultMode: "pi"})
	if err != nil {
		t.Fatal(err)
	}
	if piDefault.Command != "pi" {
		t.Fatalf("empty pi command replaced the registry value: %q", piDefault.Command)
	}
	psi, err := selectPiLaunch(pi, "psi", false, config.Config{PiDefaultMode: "pi", PsiCommand: "/opt/psi"})
	if err != nil {
		t.Fatal(err)
	}
	if psi.Command != "/opt/psi" {
		t.Fatalf("psi command=%q", psi.Command)
	}
	if len(pi.Args) != 0 || len(pi.Env) != 0 {
		t.Fatalf("launch mutated the source coder: args=%q env=%+v", pi.Args, pi.Env)
	}
}
