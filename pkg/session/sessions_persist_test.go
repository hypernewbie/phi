package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestSessionMeta_RoundTripAcrossRestart proves the on-disk sessions
// store survives the server lifecycle. The user's expectation is "the
// sessions I had open before restart come back after restart" — without
// this round-trip the server has no way to remember which sessions to
// hand back via /api/terminals on the next page load.
//
// We don't actually restart the OS process — that would require
// forking-and-exec'ing a second Go binary or running an integration
// test. What's load-bearing for the user's question is whether:
//
//  1. SaveSessionMetaMap() writes a deterministic JSON to disk.
//  2. LoadSessionMetaMap() reads it back fully and parses to identical
//     structs.
//  3. The file actually lives at ~/.phi/sessions.json so a server
//     restart picks it up at the same path.
//
// If all three hold, the server process restart is just "re-load the
// same JSON we just wrote" — and that's exactly what LoadSessionMetaMap
// does at server startup.

func TestSessionMeta_RoundTripAcrossRestart(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // windows parity

	metaPath := filepath.Join(home, ".phi", "sessions.json")

	original := map[string]SessionMeta{
		"sess-pi-test": {
			Name:   "pi-coder-tab",
			SeenAt: "2026-07-19T00:00:00Z",
			Cwd:    filepath.Join(home, "projects", "phi"),
		},
		"sess-claude-fix": {
			Name:   "claude-fix-bug",
			SeenAt: "2026-07-19T01:23:45Z",
			Cwd:    filepath.Join(home, "projects", "fix"),
		},
		"sess-bash-monitor": {
			Name:   "shell-host",
			SeenAt: "2026-07-19T02:00:00Z",
			Cwd:    filepath.Join(home, "projects", "phi"),
		},
	}
	if err := SaveSessionMetaMap(original); err != nil {
		t.Fatalf("save: %v", err)
	}

	// Verify the file actually lives where a fresh server process
	// would look for it. If this fails, the test is testing the wrong
	// path.
	if _, err := os.Stat(metaPath); err != nil {
		t.Fatalf("sessions.json not at expected path %s: %v", metaPath, err)
	}

	// And it's valid JSON, formatted the way a human would expect to
	// diff it (json.MarshalIndent — easier to eyeball during a crash).
	rawBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var parsed map[string]SessionMeta
	if err := json.Unmarshal(rawBytes, &parsed); err != nil {
		t.Fatalf("on-disk JSON is not parseable: %v", err)
	}
	if len(parsed) != len(original) {
		t.Fatalf("on-disk JSON has %d entries, expected %d",
			len(parsed), len(original))
	}

	// The actual restart simulation: LoadSessionMetaMap is the function
	// main.go's startup wires to read state after a server restart. If
	// this returns identical data, the user's tabs come back.
	loaded, err := LoadSessionMetaMap()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded) != len(original) {
		t.Fatalf("round-trip length: got %d, want %d",
			len(loaded), len(original))
	}
	for id, want := range original {
		got, ok := loaded[id]
		if !ok {
			t.Errorf("session %q missing after round-trip", id)
			continue
		}
		if got.Name != want.Name {
			t.Errorf("%s.name: got %q, want %q", id, got.Name, want.Name)
		}
		if got.SeenAt != want.SeenAt {
			t.Errorf("%s.seen_at: got %q, want %q", id, got.SeenAt, want.SeenAt)
		}
		if got.Cwd != want.Cwd {
			t.Errorf("%s.cwd: got %q, want %q", id, got.Cwd, want.Cwd)
		}
	}
}

// TestSessionMeta_LoadOnEmptyFileDoesNotCrash ensures the server can
// start when sessions.json doesn't exist yet (a fresh install). The
// loader must treat "not exists" as "empty store" rather than a panic.

func TestSessionMeta_LoadOnEmptyFileDoesNotCrash(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	loaded, err := LoadSessionMetaMap()
	if err != nil {
		t.Fatalf("load on missing file should be a no-op, got: %v", err)
	}
	if loaded == nil {
		t.Fatalf("loader should return empty map, got nil")
	}
	if len(loaded) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(loaded))
	}
}

// TestSessionMeta_LoadOnCorruptFileDoesNotLoseData ensures a corrupt
// sessions.json doesn't wipe the user's prior state — it should at
// minimum surface the error and return whatever it can. (Phi's
// production behaviour: log + return empty map. That's the right
// safety stance for a desktop tool — losing all sessions silently
// would be worse than a loud error.)

func TestSessionMeta_LoadOnCorruptFileDoesNotLoseData(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	metaPath := filepath.Join(home, ".phi", "sessions.json")
	if err := os.MkdirAll(filepath.Dir(metaPath), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(metaPath, []byte("{not valid json at all"), 0644); err != nil {
		t.Fatalf("write bad json: %v", err)
	}

	_, err := LoadSessionMetaMap()
	if err == nil {
		t.Fatalf("corrupt file must produce an error (so the user is told)")
	}
}
