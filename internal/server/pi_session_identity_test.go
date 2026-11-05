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
// writes it after exec, so poll instead of racing it.
func waitForSpawnArgs(t *testing.T, path string) []string {
	t.Helper()
	var data []byte
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		var err error
		if data, err = os.ReadFile(path); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(data) == 0 {
		t.Fatal("configured command did not run")
	}
	var args []string
	if err := json.Unmarshal(data, &args); err != nil {
		t.Fatalf("decode args: %v", err)
	}
	return args
}

// A fresh Pi pane that receives the bridge extension lets Pi choose its own
// session ID and learns it from Hello. Every other path still forces one,
// because without the bridge nothing reports it back.
func TestPiFreshLaunchIdentityFollowsBridge(t *testing.T) {
	for _, test := range []struct {
		name          string
		bridge        bool
		noInject      bool
		wantSessionID bool
		wantExtension bool
	}{
		{"bridge reports identity", true, false, false, true},
		{"injection disabled", true, true, true, false},
		{"bridge unavailable", false, false, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := restoreHarness(t)
			if test.bridge {
				bridge := piapp.StartBridge(testServer.hub, func() ([]byte, error) {
					return []byte("// phi bridge test runtime\n"), nil
				}, "0.0.0-test", nil)
				if bridge == nil {
					t.Skip("bridge listener unavailable")
				}
				testServer.bridge = bridge
				t.Cleanup(func() {
					testServer.bridge = nil
					bridge.Stop()
				})
			}
			argsPath := filepath.Join(home, "spawn.args")
			if _, err := testStore.Update(func(cfg *config.Config) error {
				cfg.PiDefaultMode = "pi"
				cfg.PiBridgeNoInject = test.noInject
				cfg.PiCommand = os.Args[0]
				cfg.PiEnv = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": argsPath}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			body := fmt.Sprintf(`{"coder":"pi","pi_mode":"pi","cwd":%q}`, home)
			reply := httptest.NewRecorder()
			testServer.handleSpawnTerminal(reply, httptest.NewRequest(http.MethodPost, "/api/terminals", strings.NewReader(body)))
			if reply.Code != http.StatusOK {
				t.Fatalf("spawn: %d %s", reply.Code, reply.Body.String())
			}
			args := waitForSpawnArgs(t, argsPath)
			if got := contains(args, "--session-id"); got != test.wantSessionID {
				t.Fatalf("--session-id present=%t, want %t (args=%q)", got, test.wantSessionID, args)
			}
			if got := contains(args, "--extension"); got != test.wantExtension {
				t.Fatalf("--extension present=%t, want %t (args=%q)", got, test.wantExtension, args)
			}
		})
	}
}
