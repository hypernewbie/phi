package main

import (
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
)

// Calls the real buildCoderArgs that handleCreateTerminal uses, rather than
// re-implementing it -- a mirrored copy would keep passing while the handler
// itself was broken.
func buildSpawnArgs(coder, sessionID string, extra []string, piOffline, claudeSkipPerms bool) []string {
	return buildCoderArgs(coder, coders.Registry[coder], sessionID, extra, piOffline, claudeSkipPerms)
}

func contains(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}

func TestPiOfflineFlag(t *testing.T) {
	t.Run("off by default", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		if cfg.PiOffline {
			t.Fatal("PiOffline should default to false so existing configs are unaffected")
		}
		if contains(buildSpawnArgs("pi", "", nil, cfg.PiOffline, false), "--offline") {
			t.Fatal("spawned pi with --offline while the setting was off")
		}
	})

	t.Run("adds the flag when enabled", func(t *testing.T) {
		if !contains(buildSpawnArgs("pi", "", nil, true, false), "--offline") {
			t.Fatal("expected --offline when the setting is on")
		}
	})

	t.Run("scoped to pi", func(t *testing.T) {
		// The flag is pi's own; other coders would reject it.
		for _, coder := range []string{"opencode", "claude", "bash"} {
			if contains(buildSpawnArgs(coder, "", nil, true, false), "--offline") {
				t.Fatalf("%s must not receive pi's --offline", coder)
			}
		}
	})

	t.Run("coexists with session resume", func(t *testing.T) {
		args := buildSpawnArgs("pi", "sess-1", nil, true, false)
		if !contains(args, "--offline") || !contains(args, "--session") || !contains(args, "sess-1") {
			t.Fatalf("resume and offline should both apply, got %v", args)
		}
		// --offline must not land between --session and its value.
		for i, a := range args {
			if a == "--session" {
				if i+1 >= len(args) || args[i+1] != "sess-1" {
					t.Fatalf("--session lost its value: %v", args)
				}
			}
		}
	})

	t.Run("persists across a save/load round trip", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.PiOffline = true
		saveConfig(cfg)
		if !loadConfig().PiOffline {
			t.Fatal("PiOffline did not survive save/load")
		}
	})

	t.Run("does not mutate the shared coder registry", func(t *testing.T) {
		// Registry is process-wide. Appending onto c.Args instead of a copy
		// could leak flags into later spawns of the same coder.
		before := len(coders.Registry["pi"].Args)
		buildSpawnArgs("pi", "sess-1", []string{"--extra"}, true, false)
		buildSpawnArgs("pi", "sess-2", nil, true, false)
		if got := len(coders.Registry["pi"].Args); got != before {
			t.Fatalf("registry Args grew from %d to %d", before, got)
		}
		if contains(buildSpawnArgs("pi", "", nil, false, false), "--offline") {
			t.Fatal("a previous spawn leaked --offline into the registry")
		}
	})
}
