package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/piapp"
)

// waitForSpawnArgs reads the argv the re-executed child recorded. The child
// writes it after exec, and the file appears before its bytes land, so poll
// until the document decodes instead of trusting the first readable file.
func waitForSpawnArgs(t *testing.T, path string) []string {
	t.Helper()
	var lastErr error
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		data, err := os.ReadFile(path)
		if err != nil {
			lastErr = err
			time.Sleep(20 * time.Millisecond)
			continue
		}
		var args []string
		if err := json.Unmarshal(data, &args); err != nil {
			lastErr = err
			time.Sleep(20 * time.Millisecond)
			continue
		}
		return args
	}
	t.Fatalf("configured command did not record readable argv: %v", lastErr)
	return nil
}

// A fresh Pi pane that receives the bridge extension lets Pi choose its own
// session ID and learns it from Hello. Psi always chooses its own ID and
// reports it through its built-in bridge, so its launch never adds one, whether
// or not provisioning succeeds. Every other path still forces an ID, because
// without a reporting bridge nothing would carry it back.
func TestPiFreshLaunchIdentityFollowsBridge(t *testing.T) {
	for _, test := range []struct {
		name          string
		mode          string
		bridge        bool
		noInject      bool
		provisionFail bool
		resumeID      string
		wantSessionID bool
		wantExtension bool
	}{
		{"native Pi, extension reports identity", "pi", true, false, false, "", false, true},
		{"native Pi, injection disabled forces an ID", "pi", true, true, false, "", true, false},
		{"native Pi, bridge unavailable forces an ID", "pi", false, false, false, "", true, false},
		{"fresh Psi, bridge available", "psi", true, false, false, "", false, false},
		{"fresh Psi, injection disabled", "psi", true, true, false, "", false, false},
		{"fresh Psi, bridge unavailable", "psi", false, false, false, "", false, false},
		{"fresh Psi, provisioning fails", "psi", true, false, true, "", false, false},
		{"Psi resume, bridge available", "psi", true, false, false, "01a1b56a-2baf-7428-9cad-1560ccc1790b", false, false},
		{"Psi resume, bridge unavailable", "psi", false, false, false, "01a1b56a-2baf-7428-9cad-1560ccc1790b", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := restoreHarness(t)
			var bridge *piapp.Bridge
			if test.bridge {
				runtime := func() ([]byte, error) { return []byte("// phi bridge test runtime\n"), nil }
				if test.provisionFail {
					// The endpoint stays up, but the runtime never materializes,
					// so Provision cannot hand out a lease.
					runtime = func() ([]byte, error) { return nil, fmt.Errorf("fixture runtime failure") }
				}
				bridge = piapp.StartBridge(testServer.hub, runtime, "0.0.0-test", nil)
				if bridge == nil {
					t.Fatal("bridge listener unavailable")
				}
				testServer.bridge = bridge
				t.Cleanup(func() {
					testServer.bridge = nil
					bridge.Stop()
				})
			}
			argsPath := filepath.Join(home, "spawn.args")
			if _, err := testStore.Update(func(cfg *config.Config) error {
				cfg.PiDefaultMode = test.mode
				cfg.PiBridgeNoInject = test.noInject
				if test.mode == "psi" {
					cfg.PsiCommand = os.Args[0]
					cfg.PsiEnv = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": argsPath}
					return nil
				}
				cfg.PiCommand = os.Args[0]
				cfg.PiEnv = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": argsPath}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			payload := map[string]string{"coder": "pi", "pi_mode": test.mode, "cwd": home}
			if test.resumeID != "" {
				payload["session_id"] = test.resumeID
			}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			reply := httptest.NewRecorder()
			testServer.handleSpawnTerminal(reply, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(string(body))))
			if reply.Code != http.StatusOK {
				t.Fatalf("spawn: %d %s", reply.Code, reply.Body.String())
			}
			var spawn struct {
				PaneID string `json:"pane_id"`
			}
			if err := json.Unmarshal(reply.Body.Bytes(), &spawn); err != nil {
				t.Fatalf("decode spawn reply: %v", err)
			}
			inst, ok := testServer.pty.Get(spawn.PaneID)
			if !ok || inst.IsPtyDead() {
				t.Fatalf("pane %q is not live", spawn.PaneID)
			}
			if got := inst.Snapshot().PiMode; got != test.mode {
				t.Fatalf("pane ran mode %q, want %q", got, test.mode)
			}
			args := waitForSpawnArgs(t, argsPath)
			if got := contains(args, "--session-id"); got != test.wantSessionID {
				t.Fatalf("--session-id present=%t, want %t (args=%q)", got, test.wantSessionID, args)
			}
			if got := contains(args, "--extension"); got != test.wantExtension {
				t.Fatalf("--extension present=%t, want %t (args=%q)", got, test.wantExtension, args)
			}
			// A resume carries the requested ID exactly once, and the fresh
			// Psi launch carries no identity at all.
			if test.resumeID != "" {
				if len(args) != 2 || args[0] != "--session" || args[1] != test.resumeID {
					t.Fatalf("Psi resume argv must be exactly --session <requested ID>: %q", args)
				}
				if got := inst.Snapshot().SessionID; got != test.resumeID {
					t.Fatalf("resumed pane stored %q, want %q", got, test.resumeID)
				}
				return
			}
			if contains(args, "--session") {
				t.Fatalf("fresh launch must not add --session: %q", args)
			}
			if test.mode == "psi" {
				// No Hello reaches this stub, so an invented ID would show here.
				if got := inst.Snapshot().SessionID; got != "" {
					t.Fatalf("fresh Psi pane invented session ID %q", got)
				}
			}
			if test.provisionFail {
				if got := bridge.PaneSnapshot(spawn.PaneID).State; got != "unavailable" {
					t.Fatalf("pane state %q, want the failed-provision state", got)
				}
			}
		})
	}
}
