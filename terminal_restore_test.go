package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

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
	oldManager, oldCoders, oldHub, oldCwd := ptyManager, coderManager, wsHub, activeCWD
	ptyManager = pty.NewManager()
	coderManager = coders.NewManager()
	wsHub = ws.NewHub(64 * 1024)
	activeCWD = home
	t.Cleanup(func() {
		for _, inst := range ptyManager.ListActive() {
			_ = ptyManager.Kill(inst.ID)
		}
		_ = ptyManager.FlushSaveState()
		ptyManager, coderManager, wsHub, activeCWD = oldManager, oldCoders, oldHub, oldCwd
	})
	return home
}

func TestRestoreBackendSlotsKeepIdentityMetadataAndExactResumeArgs(t *testing.T) {
	home := restoreHarness(t)
	for _, id := range []string{"claude", "pi", "agy", "codex", "bash", "pwsh"} {
		c := coderManager.MustGet(id)
		c.Command = os.Args[0]
		c.Args = nil
		c.SessionSource = "none"
		path := filepath.Join(home, id+".args")
		c.Env = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": path}
		coderManager.Add(c)
		tab := pty.SavedTab{PTYInstanceSnapshot: pty.PTYInstanceSnapshot{ID: "pane-" + id, Coder: id, SessionID: "exact-native-id", Cwd: home, Title: "Keep title", Workspace: "workspace", Pinned: true, Marked: true}}
		restoreSavedTab(tab)
		inst, ok := ptyManager.Get(tab.ID)
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

func TestRestoreInvalidNativeResumeFallsBackWithoutAbortingOtherTabs(t *testing.T) {
	home := restoreHarness(t)
	c := coderManager.MustGet("codex")
	c.Command = os.Args[0]
	c.Args = nil
	c.SessionSource = "none"
	path := filepath.Join(home, "fallback.args")
	c.Env = map[string]string{"PHI_TEST_RESTORE_CHILD": "1", "PHI_TEST_RESTORE_ARGS": path, "PHI_TEST_RESTORE_REJECT_RESUME": "1"}
	coderManager.Add(c)
	restoreSavedTab(pty.SavedTab{PTYInstanceSnapshot: pty.PTYInstanceSnapshot{ID: "bad-resume", Coder: "codex", SessionID: "stale", Cwd: home, Title: "Keep tab"}})
	inst, ok := ptyManager.Get("bad-resume")
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
	restoreSavedTabs()
	if len(ptyManager.ListActive()) != 0 {
		t.Fatal("corrupt state published ghost tabs")
	}
}
