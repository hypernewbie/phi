package main

import (
	"testing"

	"github.com/hypernewbie/phi/pkg/coders"
)

// buildSpawnArgs shim that calls the real ResolveLaunch the handler
// uses. Tests that previously re-implemented buildCoderArgs now drive
// the production entry point, so a refactor that broke the handler
// without breaking this shim would still be caught (api_claude_skip_permissions_test.go
// and api_pi_offline_test.go used to mirror buildCoderArgs directly;
// the resolver version is shorter but exercises the same code path).
func buildSpawnArgs(coderID, sessionID string, extra []string, piOffline, claudeSkipPerms bool) (coders.LaunchPlan, error) {
	mgr := coders.NewManager()
	c, ok := mgr.Get(coderID)
	if !ok {
		return coders.LaunchPlan{}, nil
	}
	return coders.ResolveLaunch(c, coders.SpawnRequest{
		Coder:     coderID,
		SessionID: sessionID,
		ExtraArgs: extra,
	}, coders.LaunchOptions{
		Config: coders.ConfigView{
			PiOffline:                        piOffline,
			ClaudeDangerouslySkipPermissions: claudeSkipPerms,
		},
	})
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
		plan, err := buildSpawnArgs("pi", "", nil, cfg.PiOffline, false)
		if err != nil {
			t.Fatal(err)
		}
		if contains(plan.Args, "--offline") {
			t.Fatal("spawned pi with --offline while the setting was off")
		}
	})

	t.Run("adds the flag when enabled", func(t *testing.T) {
		plan, err := buildSpawnArgs("pi", "", nil, true, false)
		if err != nil {
			t.Fatal(err)
		}
		if !contains(plan.Args, "--offline") {
			t.Fatal("expected --offline when the setting is on")
		}
	})

	t.Run("scoped to pi", func(t *testing.T) {
		// The flag is pi's own; other coders would reject it.
		for _, coder := range []string{"opencode", "claude", "bash"} {
			plan, err := buildSpawnArgs(coder, "", nil, true, false)
			if err != nil {
				t.Fatal(err)
			}
			if contains(plan.Args, "--offline") {
				t.Fatalf("%s must not receive pi's --offline", coder)
			}
		}
	})

	t.Run("coexists with session resume", func(t *testing.T) {
		plan, err := buildSpawnArgs("pi", "sess-1", nil, true, false)
		if err != nil {
			t.Fatal(err)
		}
		if !contains(plan.Args, "--offline") || !contains(plan.Args, "--session") || !contains(plan.Args, "sess-1") {
			t.Fatalf("resume and offline should both apply, got %v", plan.Args)
		}
		// --offline must not land between --session and its value.
		for i, a := range plan.Args {
			if a == "--session" {
				if i+1 >= len(plan.Args) || plan.Args[i+1] != "sess-1" {
					t.Fatalf("--session lost its value: %v", plan.Args)
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
		mgr := coders.NewManager()
		before, _ := mgr.Get("pi")
		beforeLen := len(before.Args)
		_, _ = buildSpawnArgs("pi", "sess-1", []string{"--extra"}, true, false)
		_, _ = buildSpawnArgs("pi", "sess-2", nil, true, false)
		after, _ := mgr.Get("pi")
		if got := len(after.Args); got != beforeLen {
			t.Fatalf("registry Args grew from %d to %d", beforeLen, got)
		}
		plan, err := buildSpawnArgs("pi", "", nil, false, false)
		if err != nil {
			t.Fatal(err)
		}
		if contains(plan.Args, "--offline") {
			t.Fatal("a previous spawn leaked --offline into the registry")
		}
	})
}
