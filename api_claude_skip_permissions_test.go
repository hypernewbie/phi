package main

import (
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
)

// Mirrors api_pi_offline_test.go shape: buildCoderArgs is the real entry
// point handleCreateTerminal calls, so these tests exercise the actual
// flag-placement code rather than a test-local copy. Same scope discipline
// as pi -- the flag is claude's own, and other coders would reject it.
func TestClaudeDangerouslySkipPermissionsFlag(t *testing.T) {
	t.Run("off by default", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		if cfg.ClaudeDangerouslySkipPermissions {
			t.Fatal("ClaudeDangerouslySkipPermissions should default to false so existing configs are unaffected")
		}
		if contains(buildSpawnArgs("claude", "", nil, false, cfg.ClaudeDangerouslySkipPermissions), "--dangerously-skip-permissions") {
			t.Fatal("spawned claude with --dangerously-skip-permissions while the setting was off")
		}
	})

	t.Run("adds the flag when enabled", func(t *testing.T) {
		if !contains(buildSpawnArgs("claude", "", nil, false, true), "--dangerously-skip-permissions") {
			t.Fatal("expected --dangerously-skip-permissions when the setting is on")
		}
	})

	t.Run("scoped to claude", func(t *testing.T) {
		// The flag is claude's own; other coders would reject it.
		for _, coder := range []string{"opencode", "pi", "bash"} {
			if contains(buildSpawnArgs(coder, "", nil, false, true), "--dangerously-skip-permissions") {
				t.Fatalf("%s must not receive claude's --dangerously-skip-permissions", coder)
			}
		}
	})

	t.Run("coexists with session resume", func(t *testing.T) {
		args := buildSpawnArgs("claude", "sess-1", nil, false, true)
		if !contains(args, "--dangerously-skip-permissions") || !contains(args, "--resume") || !contains(args, "sess-1") {
			t.Fatalf("resume and skip-permissions should both apply, got %v", args)
		}
		// --resume must not lose its value: the flag we add must not
		// land between --resume and its session id.
		for i, a := range args {
			if a == "--resume" {
				if i+1 >= len(args) || args[i+1] != "sess-1" {
					t.Fatalf("--resume lost its value: %v", args)
				}
			}
		}
	})

	t.Run("persists across a save/load round trip", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.ClaudeDangerouslySkipPermissions = true
		saveConfig(cfg)
		if !loadConfig().ClaudeDangerouslySkipPermissions {
			t.Fatal("ClaudeDangerouslySkipPermissions did not survive save/load")
		}
	})

	t.Run("does not mutate the shared coder registry", func(t *testing.T) {
		// Same defense as pi: Registry is process-wide. Appending onto
		// c.Args instead of a copy could leak flags into later spawns.
		before := len(coders.Registry["claude"].Args)
		buildSpawnArgs("claude", "sess-1", []string{"--extra"}, false, true)
		buildSpawnArgs("claude", "sess-2", nil, false, true)
		if got := len(coders.Registry["claude"].Args); got != before {
			t.Fatalf("registry Args grew from %d to %d", before, got)
		}
		if contains(buildSpawnArgs("claude", "", nil, false, false), "--dangerously-skip-permissions") {
			t.Fatal("a previous spawn leaked --dangerously-skip-permissions into the registry")
		}
	})

	t.Run("pi --offline and claude --dangerously-skip-permissions are independent", func(t *testing.T) {
		// Turning the claude flag on must not leak --offline onto a
		// claude spawn, and turning the pi flag on must not leak the
		// claude flag onto a pi spawn.
		claudeArgs := buildSpawnArgs("claude", "", nil, false, true)
		if contains(claudeArgs, "--offline") {
			t.Fatalf("claude spawned with pi's --offline: %v", claudeArgs)
		}
		piArgs := buildSpawnArgs("pi", "", nil, true, false)
		if contains(piArgs, "--dangerously-skip-permissions") {
			t.Fatalf("pi spawned with claude's --dangerously-skip-permissions: %v", piArgs)
		}
	})
}

// codersGetArgs shim removed -- the test now uses coders.Registry
// directly, mirroring api_pi_offline_test.go's pattern.
