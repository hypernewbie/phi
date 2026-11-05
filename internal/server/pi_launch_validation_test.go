package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/internal/config"
)

// A hand-edited config is subject to the same syntax rules as an API patch.
// Check both the save and process boundary; neither may expose an env value.
func TestPiLaunchRejectsInvalidStoredPsiFields(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*config.Config)
	}{
		{"reserved env", func(c *config.Config) { c.PsiEnv = map[string]string{"pAtH": "synthetic-private-value"} }},
		{"duplicate env", func(c *config.Config) { c.PsiEnv = map[string]string{"Foo": "a", "FOO": "b"} }},
		{"nul env", func(c *config.Config) { c.PsiEnv = map[string]string{"FOO": "synthetic-private-value\x00"} }},
		{"newline arg", func(c *config.Config) { c.PsiArgs = []string{"bad\narg"} }},
		{"newline command", func(c *config.Config) { c.PsiCommand = "psi\n" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := restoreHarness(t)
			if _, err := testStore.Update(func(c *config.Config) error {
				c.PsiCommand = os.Args[0]
				test.mutate(c)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			saved := piLaunchRequestRaw(t, http.MethodPost, `{"revision":0,"fields":{"pi_default_mode":"psi"}}`, "application/json")
			launched := httptest.NewRecorder()
			testServer.handleSpawnTerminal(launched, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(`{"coder":"pi","pi_mode":"psi"}`)))
			for name, reply := range map[string]*httptest.ResponseRecorder{"save": saved, "launch": launched} {
				if reply.Code != http.StatusBadRequest {
					t.Fatalf("%s: %d %s", name, reply.Code, reply.Body.String())
				}
				if strings.Contains(reply.Body.String(), "synthetic-private-value") {
					t.Fatalf("%s leaked an env value", name)
				}
			}
			if len(testServer.pty.ListActive()) != 0 {
				t.Fatal("invalid Psi settings started a process")
			}
			if cfg := testServer.loadConfig(); cfg.PiLaunchRevision != 0 {
				t.Fatal("invalid settings were saved")
			}
			// Recovery is independent of broken Psi syntax, at save and launch.
			piLaunchRequest(t, http.MethodPost, `{"revision":0,"fields":{"pi_default_mode":"pi"}}`, "application/json", http.StatusOK)
			pi := testServer.coders.MustGet("pi")
			pi.Command = os.Args[0]
			pi.Env = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": filepath.Join(home, "pi.args")}
			testServer.coders.Add(pi)
			reply := httptest.NewRecorder()
			testServer.handleSpawnTerminal(reply, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(`{"coder":"pi","pi_mode":"pi"}`)))
			if reply.Code != http.StatusOK {
				t.Fatalf("Pi recovery: %d %s", reply.Code, reply.Body.String())
			}
		})
	}
}

// A hand-edited Pi setting is checked at the process boundary too, and a broken
// Pi setting never blocks switching back to Psi.
func TestPiLaunchRejectsInvalidStoredPiFields(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*config.Config)
	}{
		{"reserved env", func(c *config.Config) { c.PiEnv = map[string]string{"cOlOrTeRm": "synthetic-private-value"} }},
		{"duplicate env", func(c *config.Config) { c.PiEnv = map[string]string{"Foo": "a", "FOO": "b"} }},
		{"newline arg", func(c *config.Config) { c.PiArgs = []string{"bad\narg"} }},
		{"newline command", func(c *config.Config) { c.PiCommand = "pi\n" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := restoreHarness(t)
			if _, err := testStore.Update(func(c *config.Config) error {
				c.PiCommand = os.Args[0]
				test.mutate(c)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			reply := httptest.NewRecorder()
			testServer.handleSpawnTerminal(reply, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(`{"coder":"pi","pi_mode":"pi"}`)))
			if reply.Code != http.StatusBadRequest {
				t.Fatalf("launch: %d %s", reply.Code, reply.Body.String())
			}
			if strings.Contains(reply.Body.String(), "synthetic-private-value") {
				t.Fatal("launch leaked an env value")
			}
			if len(testServer.pty.ListActive()) != 0 {
				t.Fatal("invalid Pi settings started a process")
			}
			// Psi recovery stays possible while the Pi settings are broken.
			withFakePsi(t)
			state := piLaunchRequest(t, http.MethodPost, `{"revision":0,"fields":{"pi_default_mode":"psi"}}`, "application/json", http.StatusOK)
			if state.PiDefaultMode != "psi" {
				t.Fatalf("Psi recovery blocked by broken Pi settings: %+v", state)
			}
			pi := testServer.coders.MustGet("pi")
			pi.PsiCommand = os.Args[0]
			pi.Env = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": filepath.Join(home, "psi.args")}
			testServer.coders.Add(pi)
			psi := httptest.NewRecorder()
			testServer.handleSpawnTerminal(psi, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(`{"coder":"pi","pi_mode":"psi"}`)))
			if psi.Code != http.StatusOK {
				t.Fatalf("Psi recovery launch: %d %s", psi.Code, psi.Body.String())
			}
		})
	}
}
