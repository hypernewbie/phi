package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws"
)

func init() {
	if os.Getenv("PHI_TEST_RESTORE_CHILD") != "1" {
		return
	}
	data, _ := json.Marshal(os.Args[1:])
	_ = os.WriteFile(os.Getenv("PHI_TEST_RESTORE_ARGS"), data, 0600)
	if os.Getenv("PHI_TEST_RESTORE_REJECT_RESUME") == "1" {
		for _, arg := range os.Args[1:] {
			if arg == "resume" {
				os.Exit(2)
			}
		}
	}
	fmt.Println("ready")
	for {
		time.Sleep(time.Second)
	}
}

func restoreHarness(t *testing.T) string {
	t.Helper()
	withTempConfig(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	oldManager, oldCoders, oldHub, oldCwd, oldTitleService := testServer.pty, testServer.coders, testServer.hub, testServer.activeCWD, testServer.titles
	testServer.pty = pty.NewManager()
	testServer.coders = coders.NewManager()
	testServer.hub = ws.NewHub(64 * 1024)
	testServer.activeCWD = home
	testServer.titles = nil
	t.Cleanup(func() {
		if testServer.titles != nil {
			testServer.titles.Close()
		}
		for _, inst := range testServer.pty.ListActive() {
			_ = testServer.pty.Kill(inst.ID)
		}
		_ = testServer.pty.FlushSaveState()
		testServer.pty, testServer.coders, testServer.hub, testServer.activeCWD, testServer.titles = oldManager, oldCoders, oldHub, oldCwd, oldTitleService
	})
	return home
}

func TestRestoreBackendSlotsKeepIdentityMetadataAndExactResumeArgs(t *testing.T) {
	home := restoreHarness(t)
	for _, id := range []string{"claude", "pi", "agy", "codex", "bash", "pwsh"} {
		c := testServer.coders.MustGet(id)
		c.Command = os.Args[0]
		c.Args = nil
		c.SessionSource = "none"
		path := filepath.Join(home, id+".args")
		c.Env = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": path}
		testServer.coders.Add(c)
		tab := pty.SavedTab{PTYInstanceSnapshot: pty.PTYInstanceSnapshot{ID: "pane-" + id, Coder: id, SessionID: "exact-native-id", Cwd: home, Title: "Keep title", Workspace: "workspace", Pinned: true, Marked: true}}
		testServer.restoreSavedTab(tab)
		inst, ok := testServer.pty.Get(tab.ID)
		if !ok || inst.IsPtyDead() {
			t.Fatalf("%s restored as a ghost", id)
		}
		snapshot := inst.Snapshot()
		if snapshot.Title != tab.Title || snapshot.Cwd != home || snapshot.Workspace != tab.Workspace || !snapshot.Pinned || !snapshot.Marked {
			t.Fatalf("lost metadata: %+v", snapshot)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var args []string
		if err := json.Unmarshal(data, &args); err != nil {
			t.Fatal(err)
		}
		if c.IsShell {
			if len(args) != 0 || snapshot.SessionID != "" {
				t.Fatalf("shell given agent resume args: %+v", args)
			}
		} else if len(args) != 2 || args[1] != "exact-native-id" {
			t.Fatalf("%s resumed wrong conversation: %+v", id, args)
		}
	}
}

func TestSpawnedPiPaneRegistersThroughSharedLaunchPath(t *testing.T) {
	home := restoreHarness(t)
	coder := testServer.coders.MustGet("pi")
	coder.Command = os.Args[0]
	coder.Args = nil
	coder.SessionSource = "none"
	coder.Env = map[string]string{"PHI_TEST_RESTORE_CHILD": "1"}
	testServer.coders.Add(coder)
	service := NewPiTerminalTitleService(testServer.pty, testServer.hub)
	testServer.titles = service

	tab := pty.SavedTab{PTYInstanceSnapshot: pty.PTYInstanceSnapshot{
		ID: "registered-pi-pane", Coder: "pi", Cwd: home, SessionID: "native-id", Title: "Saved title",
	}}
	testServer.restoreSavedTab(tab)
	instance, ok := testServer.pty.Get(tab.ID)
	if !ok || instance.IsPtyDead() {
		t.Fatal("Pi pane did not launch through the shared terminal path")
	}
	service.mu.Lock()
	track := service.panes[tab.ID]
	service.mu.Unlock()
	if track == nil || track.instance != instance || track.sessionID != "native-id" || track.cwd != home {
		t.Fatalf("spawned Pi pane was not registered with exact identity: %+v", track)
	}
}

func TestRestoreInvalidNativeResumeFallsBackWithoutAbortingOtherTabs(t *testing.T) {
	home := restoreHarness(t)
	c := testServer.coders.MustGet("codex")
	c.Command = os.Args[0]
	c.Args = nil
	c.SessionSource = "none"
	path := filepath.Join(home, "fallback.args")
	c.Env = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": path, "PHI_TEST_RESTORE_REJECT_RESUME": "1"}
	testServer.coders.Add(c)
	testServer.restoreSavedTab(pty.SavedTab{PTYInstanceSnapshot: pty.PTYInstanceSnapshot{ID: "bad-resume", Coder: "codex", SessionID: "stale", Cwd: home, Title: "Keep tab"}})
	inst, ok := testServer.pty.Get("bad-resume")
	if !ok || inst.IsPtyDead() || inst.Snapshot().SessionID != "" {
		t.Fatal("failed resume did not become a fresh live tab")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "[]" && string(data) != "null" {
		t.Fatalf("fresh fallback kept resume args: %s", data)
	}
}

func TestRestoreCorruptFileNeverAbortsStartup(t *testing.T) {
	home := restoreHarness(t)
	_ = os.MkdirAll(filepath.Join(home, ".phi"), 0700)
	_ = os.WriteFile(filepath.Join(home, ".phi", "tabs.json"), []byte("invalid"), 0600)
	testServer.restoreSavedTabs()
	if len(testServer.pty.ListActive()) != 0 {
		t.Fatal("corrupt state published ghost tabs")
	}
}

func TestRestoreKeepsSavedPiAgentUnderOppositeDefault(t *testing.T) {
	for _, test := range []struct {
		name     string
		saved    string
		def      string
		noInject bool
		want     string
	}{
		{"legacy pi pane under psi default", "", "psi", false, "pi"},
		{"explicit pi pane under psi default", "pi", "psi", false, "pi"},
		{"psi pane under pi default", "psi", "pi", false, "psi"},
		{"psi pane under psi default", "psi", "psi", false, "psi"},
		// The wrong mode must not be a fallback for an unavailable bridge: with
		// injection disabled and no bridge attached, a saved Psi pane is still
		// Psi.
		{"psi pane with bridge injection disabled", "psi", "pi", true, "psi"},
		{"psi pane under psi default with injection disabled", "psi", "psi", true, "psi"},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := restoreHarness(t)
			// The configured default only picks agents for new panes; a saved
			// pane keeps the agent it was created with.
			if _, err := testStore.Update(func(cfg *config.Config) error {
				cfg.PiDefaultMode = test.def
				cfg.PsiCommand = os.Args[0]
				cfg.PiBridgeNoInject = test.noInject
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			pi := testServer.coders.MustGet("pi")
			pi.Command = os.Args[0]
			pi.Args = nil
			argsPath := filepath.Join(home, "restored.args")
			pi.Env = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": argsPath}
			testServer.coders.Add(pi)

			tab := pty.SavedTab{PTYInstanceSnapshot: pty.PTYInstanceSnapshot{
				ID: "restored-pi", Coder: "pi", PiMode: test.saved, Cwd: home, Title: "Saved title",
			}}
			testServer.restoreSavedTab(tab)
			inst, ok := testServer.pty.Get(tab.ID)
			if !ok || inst.IsPtyDead() {
				t.Fatalf("restored pane is not live: ok=%v", ok)
			}
			// The child writes this file only when it really ran, so the mode
			// assertion cannot pass on a pane whose process never started.
			if _, err := os.Stat(argsPath); err != nil {
				t.Fatalf("configured command did not run: %v", err)
			}
			if got := inst.Snapshot().PiMode; got != test.want {
				t.Fatalf("saved mode %q under default %q restored as %q", test.saved, test.def, got)
			}
		})
	}
}

func TestPiBridgeInjectsExtensionOnlyForForeignCoders(t *testing.T) {
	cases := []struct {
		name   string
		coder  coders.Coder
		inject bool
	}{
		{"psi", coders.Coder{ID: "pi", PiMode: "psi"}, false},
		{"pi", coders.Coder{ID: "pi"}, true},
		{"pi-explicit", coders.Coder{ID: "pi", PiMode: "pi"}, true},
	}
	for _, tc := range cases {
		if got := piBridgeInjectsExtension(tc.coder); got != tc.inject {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.inject)
		}
	}
}
