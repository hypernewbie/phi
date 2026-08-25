package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestConfigConcurrentAccess(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "phi-config-test")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Direct tests to the temp config file path
	testConfigPath = filepath.Join(tmpDir, "config.json")
	defer func() {
		testConfigPath = ""
	}()

	// Save initial config
	cfg := loadConfig()
	cfg.ThemeColor = "purple"
	saveConfig(cfg)

	// Stress concurrent reads and writes
	var wg sync.WaitGroup
	numRoutines := 50
	operationsPerRoutine := 100

	for i := 0; i < numRoutines; i++ {
		wg.Add(2)

		// Reader routine
		go func() {
			defer wg.Done()
			for j := 0; j < operationsPerRoutine; j++ {
				_ = loadConfig()
			}
		}()

		// Writer routine
		go func(id int) {
			defer wg.Done()
			for j := 0; j < operationsPerRoutine; j++ {
				c := loadConfig()
				if id%2 == 0 {
					c.ThemeColor = "gold"
				} else {
					c.ThemeColor = "cyan"
				}
				saveConfig(c)
			}
		}(i)
	}

	wg.Wait()

	// Final verification
	finalCfg := loadConfig()
	if finalCfg.ThemeColor != "gold" && finalCfg.ThemeColor != "cyan" {
		t.Errorf("Unexpected final theme color: %s", finalCfg.ThemeColor)
	}
}

// Regression test for the 2026-07-14 poisoning incident: a test that
// forgot withTempConfig silently wrote three fake workspaces into the
// user's live ~/.phi/config.json. The guard in configFilePath() now
// panics if a test calls it without setting testConfigPath. This test
// pins the panic behavior so the guard is never accidentally weakened.
func TestConfigFilePathPanicsUnderTestWithoutOverride(t *testing.T) {
	// Save and clear testConfigPath for the duration of this sub-test.
	saved := testConfigPath
	testConfigPath = ""
	defer func() { testConfigPath = saved }()

	defer func() {
		if r := recover(); r != nil {
			msg, ok := r.(string)
			if !ok {
				t.Fatalf("configFilePath() panicked with non-string: %v", r)
			}
			if !strings.Contains(msg, "testConfigPath") {
				t.Fatalf("panic message should mention testConfigPath, got: %s", msg)
			}
			// OK — guard fired as expected.
			return
		}
		t.Fatal("configFilePath() did not panic under test without testConfigPath; " +
			"the live-config guard has been silently weakened.")
	}()

	_ = configFilePath()
}

// Regression test for the sanitize-on-save defense: even if a test
// somehow reaches saveConfig with test paths in the workspace list,
// those paths never reach disk. Pin the rule so a future refactor
// can't accidentally let them through.
func TestSaveConfigNeverPersistsTestScratchPaths(t *testing.T) {
	withTempConfig(t)

	// Reload to get the defaults, then poison the list with test
	// artifacts and call saveConfig. After save, reload and verify
	// none of the poison survived.
	cfg := loadConfig()
	poisoned := []string{
		`C:/Users/tester/AppData/Local/Temp/phi-test-alpha`,
		`C:/Users/tester/AppData/Local/Temp/phi-test-beta`,
		`C:/Users/tester/AppData/Local/Temp/phi-test-gamma`,
		`/tmp/phi-test-delta`,
		`/var/folders/ab/T/phi-test-eps/working`,
		`C:/code/github/phi`, // legitimate, must survive
	}
	cfg.Workspaces = poisoned
	saveConfig(cfg)

	reloaded := loadConfig()
	for _, bad := range poisoned[:len(poisoned)-1] {
		for _, ws := range reloaded.Workspaces {
			if ws == bad {
				t.Errorf("test scratch path persisted to disk: %s", bad)
			}
		}
	}
	// The legitimate path must survive the filter.
	found := false
	for _, ws := range reloaded.Workspaces {
		if ws == `C:/code/github/phi` {
			found = true
			break
		}
	}
	if !found {
		t.Error("legitimate workspace path was filtered out by the test-artifact guard")
	}
}

// Unit test for the artifact detector heuristic. The rule: the
// basename must start with `phi-test-` or `phi-shims-`. Real user
// workspaces never do, so the false-positive rate is zero.
func TestLooksLikeTestArtifact(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		// Legitimate user workspaces — always false.
		{`C:/code/github/phi`, false},
		{`C:\code\ae`, false},
		{`/home/user/projects/myapp`, false},
		{`H:\ASSET\astra_reality\lore_obsidian_vault`, false},
		{`/tmp/real-project`, false}, // /tmp/ but no phi-test prefix
		{``, false},

		// Test scratch paths created by MkdirTemp / CreateTemp.
		{`C:/Users/HyperNewbie/AppData/Local/Temp/phi-test-alpha`, true},
		{`/tmp/phi-test-alpha`, true},
		{`/var/folders/ab/T/phi-test-xyz/working`, true},
		{`/tmp/phi-shims-1234/clipboard`, true},
	}
	for _, c := range cases {
		got := looksLikeTestArtifact(c.path)
		if got != c.want {
			t.Errorf("looksLikeTestArtifact(%q): got %v, want %v", c.path, got, c.want)
		}
	}
}

// Sanity: confirm withTempConfig sets testConfigPath to a real file.
// (The restore-on-cleanup behavior is provided by t.Cleanup itself and
// doesn't need a separate pin test.)
func TestWithTempConfigSets(t *testing.T) {
	savedBefore := testConfigPath
	defer func() { testConfigPath = savedBefore }()

	path := withTempConfig(t)
	if path == "" {
		t.Fatal("withTempConfig returned empty path")
	}
	if testConfigPath != path {
		t.Errorf("withTempConfig did not set testConfigPath; got %q want %q", testConfigPath, path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("withTempConfig path not created: %v", err)
	}
}

// Ensure that even tests pinning testConfigPath via the raw variable
// (not the helper) can round-trip a config write without touching the
// live file. This is the documented escape hatch for the guard panic.
func TestTestConfigPathOverrideBypassesGuard(t *testing.T) {
	dir := t.TempDir()
	saved := testConfigPath
	testConfigPath = filepath.Join(dir, "config.json")
	t.Cleanup(func() { testConfigPath = saved })

	cfg := loadConfig()
	cfg.ThemeColor = "gold"
	saveConfig(cfg)

	b, err := os.ReadFile(testConfigPath)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	var got Config
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("parse back: %v", err)
	}
	if got.ThemeColor != "gold" {
		t.Errorf("override did not persist: got %s, want gold", got.ThemeColor)
	}
}

func TestCompressionEnabledDefaultsTrue(t *testing.T) {
	withTempConfig(t)
	if !loadConfig().CompressionEnabled {
		t.Fatal("CompressionEnabled must default to true with an empty config")
	}
}

func TestCompressionEnabledExplicitFalse(t *testing.T) {
	cfgPath := withTempConfig(t)
	if err := os.WriteFile(cfgPath, []byte(`{"compression_enabled":false}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if loadConfig().CompressionEnabled {
		t.Fatal("explicit false must win over the seeded default")
	}
}

func TestAttachmentConfigDefaultsAndNormalization(t *testing.T) {
	cfgPath := withTempConfig(t)
	cfg := loadConfig()
	if cfg.AttachmentRetentionAgeSeconds != defaultAttachmentRetentionAgeSeconds ||
		cfg.AttachmentUnleasedFileCap != defaultAttachmentUnleasedFileCap ||
		cfg.AttachmentJanitorIntervalSeconds != defaultAttachmentJanitorIntervalSeconds {
		t.Fatalf("attachment defaults=%+v", cfg)
	}
	if err := os.WriteFile(cfgPath, []byte(`{"attachment_retention_age_seconds":-1,"attachment_unleased_file_cap":-1,"attachment_janitor_interval_seconds":0}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg = loadConfig()
	if cfg.AttachmentRetentionAgeSeconds != defaultAttachmentRetentionAgeSeconds || cfg.AttachmentUnleasedFileCap != 0 || cfg.AttachmentJanitorIntervalSeconds != minimumAttachmentJanitorIntervalSeconds {
		t.Fatalf("normalized attachment settings=%+v", cfg)
	}
	cfg.AttachmentRetentionAgeSeconds = 0
	cfg.AttachmentUnleasedFileCap = 12
	cfg.AttachmentJanitorIntervalSeconds = 90
	saveConfig(cfg)
	reloaded := loadConfig()
	if reloaded.AttachmentRetentionAgeSeconds != 0 || reloaded.AttachmentUnleasedFileCap != 12 || reloaded.AttachmentJanitorIntervalSeconds != 90 {
		t.Fatalf("attachment settings did not persist=%+v", reloaded)
	}
}
