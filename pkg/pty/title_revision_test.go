package pty

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func livePiTitleTestPty() *Pty {
	return &Pty{Closed: make(chan struct{})}
}

func TestSetDerivedPiTitleRevisionAndNoOp(t *testing.T) {
	testTabsPath = filepath.Join(t.TempDir(), "tabs.json")
	t.Cleanup(func() { testTabsPath = "" })

	manager := NewManager()
	inst := &PTYInstance{ID: "pi-pane", Pty: livePiTitleTestPty(), Coder: "pi", SessionID: "native-id", Cwd: "/original", Title: "Saved title"}
	manager.AddInstanceForTesting(inst)

	revision, changed := manager.SetDerivedPiTitle(inst, "native-id", "/original", "Native title")
	if !changed || revision != 1 {
		t.Fatalf("first derived title revision=%d changed=%v", revision, changed)
	}
	if snapshot := inst.Snapshot(); snapshot.Title != "Native title" || snapshot.TitleRevision != 1 {
		t.Fatalf("derived snapshot=%+v", snapshot)
	}

	revision, changed = manager.SetDerivedPiTitle(inst, "native-id", "/original", "Native title")
	if changed || revision != 1 {
		t.Fatalf("equal title should be a no-op: revision=%d changed=%v", revision, changed)
	}
	revision, changed = manager.SetDerivedPiTitle(inst, "native-id", "/original", "Renamed natively")
	if !changed || revision != 2 || inst.Snapshot().TitleRevision != 2 {
		t.Fatalf("second derived title revision=%d changed=%v snapshot=%+v", revision, changed, inst.Snapshot())
	}

	if err := manager.SetTitle(inst.ID, "ordinary rename"); err != nil {
		t.Fatal(err)
	}
	if got := inst.Snapshot().TitleRevision; got != 2 {
		t.Fatalf("ordinary SetTitle changed derived revision to %d", got)
	}
	inst.mu.Lock()
	inst.titleRevision = maxPiTitleRevision
	inst.Title = "At safe limit"
	inst.mu.Unlock()
	revision, changed = manager.SetDerivedPiTitle(inst, "native-id", "/original", "Must not wrap")
	if changed || revision != maxPiTitleRevision {
		t.Fatalf("safe-integer limit accepted a wrapped revision: revision=%d changed=%v", revision, changed)
	}
	if snapshot := inst.Snapshot(); snapshot.Title != "At safe limit" || snapshot.TitleRevision != maxPiTitleRevision {
		t.Fatalf("safe-integer limit mutated title/revision: %+v", snapshot)
	}
	if err := manager.FlushSaveState(); err != nil {
		t.Fatal(err)
	}
}

func TestSetDerivedPiTitleRejectsStaleOrChangedIdentity(t *testing.T) {
	manager := NewManager()
	original := &PTYInstance{ID: "pi-pane", Pty: livePiTitleTestPty(), Coder: "pi", SessionID: "native-id", Cwd: "/original", Title: "Keep"}
	manager.AddInstanceForTesting(original)

	replacement := &PTYInstance{ID: original.ID, Pty: livePiTitleTestPty(), Coder: "pi", SessionID: "native-id", Cwd: "/original", Title: "Replacement"}
	manager.AddInstanceForTesting(replacement)
	if revision, changed := manager.SetDerivedPiTitle(original, "native-id", "/original", "Stale"); changed || revision != 0 {
		t.Fatalf("removed instance accepted title revision=%d changed=%v", revision, changed)
	}
	if got := replacement.Snapshot().Title; got != "Replacement" {
		t.Fatalf("stale pointer changed replacement title to %q", got)
	}

	for _, test := range []struct {
		name      string
		coder     string
		sessionID string
		cwd       string
	}{
		{name: "coder", coder: "bash", sessionID: "native-id", cwd: "/original"},
		{name: "native ID", coder: "pi", sessionID: "other-id", cwd: "/original"},
		{name: "original CWD", coder: "pi", sessionID: "native-id", cwd: "/moved"},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := NewManager()
			inst := &PTYInstance{ID: "pi-pane", Pty: livePiTitleTestPty(), Coder: test.coder, SessionID: test.sessionID, Cwd: test.cwd, Title: "Keep"}
			manager.AddInstanceForTesting(inst)
			if revision, changed := manager.SetDerivedPiTitle(inst, "native-id", "/original", "Must not apply"); changed || revision != 0 {
				t.Fatalf("changed identity accepted title revision=%d changed=%v", revision, changed)
			}
			if got := inst.Snapshot().Title; got != "Keep" {
				t.Fatalf("changed identity title=%q", got)
			}
		})
	}

	manager.mu.Lock()
	delete(manager.instances, replacement.ID)
	manager.mu.Unlock()
	if revision, changed := manager.SetDerivedPiTitle(replacement, "native-id", "/original", "Removed"); changed || revision != 0 {
		t.Fatalf("unregistered instance accepted title revision=%d changed=%v", revision, changed)
	}
}

func TestSetDerivedPiTitleRejectsMissingAndDeadPTY(t *testing.T) {
	manager := NewManager()
	missing := &PTYInstance{ID: "missing-pty", Coder: "pi", SessionID: "native-id", Cwd: "/original", Title: "Keep"}
	manager.AddInstanceForTesting(missing)
	if revision, changed := manager.SetDerivedPiTitle(missing, "native-id", "/original", "Must not apply"); changed || revision != 0 || missing.Snapshot().Title != "Keep" {
		t.Fatalf("missing PTY accepted a derived title: revision=%d changed=%v snapshot=%+v", revision, changed, missing.Snapshot())
	}

	deadPty := livePiTitleTestPty()
	close(deadPty.Closed)
	dead := &PTYInstance{ID: "dead-pty", Pty: deadPty, Coder: "pi", SessionID: "native-id", Cwd: "/original", Title: "Keep", titleRevision: 5}
	manager.AddInstanceForTesting(dead)
	if revision, changed := manager.SetDerivedPiTitle(dead, "native-id", "/original", "Must not apply"); changed || revision != 5 || dead.Snapshot().Title != "Keep" {
		t.Fatalf("dead PTY accepted a derived title: revision=%d changed=%v snapshot=%+v", revision, changed, dead.Snapshot())
	}
}

func TestTitleRevisionIsOmittedWhenZeroAndNotRestored(t *testing.T) {
	instance := &PTYInstance{ID: "pane", Coder: "bash", Title: "Shell"}
	encoded, err := json.Marshal(instance.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "title_revision") {
		t.Fatalf("zero title revision changed the non-Pi snapshot shape: %s", encoded)
	}

	testTabsPath = filepath.Join(t.TempDir(), "tabs.json")
	t.Cleanup(func() { testTabsPath = "" })
	persisted := []byte(`[{"id":"pi-pane","coder":"pi","session_id":"native-id","cwd":"/original","title":"Persisted","title_revision":91}]`)
	if err := os.WriteFile(testTabsPath, persisted, 0600); err != nil {
		t.Fatal(err)
	}
	manager := NewManager()
	if err := manager.LoadState(); err != nil {
		t.Fatal(err)
	}
	loaded, ok := manager.Get("pi-pane")
	if !ok {
		t.Fatal("saved Pi pane did not load")
	}
	if snapshot := loaded.Snapshot(); snapshot.Title != "Persisted" || snapshot.TitleRevision != 0 {
		t.Fatalf("restored revision became runtime authority: %+v", snapshot)
	}
}
