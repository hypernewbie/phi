package main

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/BurntSushi/toml"
)

func TestConfigConcurrentAccess(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "phi-config-test")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Direct tests to the temp config file path
	testConfigPath = filepath.Join(tmpDir, "config.toml")
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
// user's live ~/.phi/config.toml. The guard in configFilePath() now
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
	testConfigPath = filepath.Join(dir, "config.toml")
	t.Cleanup(func() { testConfigPath = saved })

	cfg := loadConfig()
	cfg.ThemeColor = "gold"
	saveConfig(cfg)

	b, err := os.ReadFile(testConfigPath)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	var got Config
	if err := toml.Unmarshal(b, &got); err != nil {
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
	if err := os.WriteFile(cfgPath, []byte("compression_enabled = false\n"), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if loadConfig().CompressionEnabled {
		t.Fatal("explicit false must win over the seeded default")
	}
}

func TestConfigTOMLRoundTrip(t *testing.T) {
	path := withTempConfig(t)
	cfg := Config{Workspaces: []string{"/tmp/work"}, ThemeColor: "amber", ExpandedWorktrees: map[string]bool{"/tmp/work": true}, ActiveWorktrees: map[string]string{"/tmp/work": "branch"}, ModelPresets: ModelPresetsMap{"pi": {"model-a"}}, ThinkingPresets: []string{"low"}, QuickCommands: []QuickCommand{{Name: "status", Command: "git status"}}, Peers: []PeerConfig{{Name: "peer", URL: "http://localhost"}}, UIFontSize: 0, SessionListPageSize: 0}
	if err := writeConfigLocked(cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got Config
	if err := toml.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.ThemeColor != cfg.ThemeColor || !reflect.DeepEqual(got.ExpandedWorktrees, cfg.ExpandedWorktrees) || !reflect.DeepEqual(got.QuickCommands, cfg.QuickCommands) || !reflect.DeepEqual(got.Peers, cfg.Peers) {
		t.Fatalf("round trip mismatch: %#v", got)
	}
}

func TestConfigChangeDetectionNoOp(t *testing.T) {
	path := withTempConfig(t)
	cfg := applyConfigDefaults(Config{CompressionEnabled: true})
	if err := writeConfigLocked(cfg); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(before, []byte("\n# sentinel\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.ThemeColor = "purple"
	if err := writeConfigLocked(cfg); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after, append(before, []byte("\n# sentinel\n")...)) {
		t.Fatal("no-op write changed TOML bytes")
	}
}

func TestConfigCompressionDefaultsBeforeDecode(t *testing.T) {
	path := withTempConfig(t)
	if err := os.WriteFile(path, []byte("theme_color = 'amber'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !loadConfig().CompressionEnabled {
		t.Fatal("missing key must default true")
	}
	if err := os.WriteFile(path, []byte("compression_enabled = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if loadConfig().CompressionEnabled {
		t.Fatal("explicit false must remain false")
	}
}

func TestConfigLegacyFallbackAndMigration(t *testing.T) {
	primary := withTempConfig(t)
	legacy := withTempLegacyConfig(t)
	if err := os.Remove(primary); err != nil {
		t.Fatal(err)
	}
	legacyBytes := []byte(`{"theme_color":"amber","model_presets":["legacy-model"]}`)
	if err := os.WriteFile(legacy, legacyBytes, 0o640); err != nil {
		t.Fatal(err)
	}
	cfg, err := readConfigLocked()
	if err != nil || cfg.ThemeColor != "amber" || !reflect.DeepEqual(cfg.ModelPresets["pi"], []string{"legacy-model"}) {
		t.Fatalf("legacy fallback: cfg=%+v err=%v", cfg, err)
	}
	migrateLegacyConfig()
	if _, err := os.Stat(primary); err != nil {
		t.Fatalf("migration did not create TOML: %v", err)
	}
	after, err := os.ReadFile(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after, legacyBytes) {
		t.Fatal("migration modified legacy JSON")
	}
	if got := loadConfig(); got.ThemeColor != "amber" {
		t.Fatalf("migrated theme = %q", got.ThemeColor)
	}
	if err := os.WriteFile(primary, append(mustRead(t, primary), []byte("# migration sentinel\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	migrateLegacyConfig()
	if !strings.Contains(string(mustRead(t, primary)), "# migration sentinel") {
		t.Fatal("second migration rewrote existing TOML")
	}
}

func TestConfigFilteringRemovesPoisonAlreadyOnDisk(t *testing.T) {
	path := withTempConfig(t)
	if err := os.WriteFile(path, []byte("workspaces = [\"/tmp/phi-test-poison\"]\ntheme_color = \"purple\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := loadConfig()
	saveConfig(cfg)
	if strings.Contains(string(mustRead(t, path)), "phi-test-poison") {
		t.Fatal("poisoned workspace survived filtered save")
	}
}

func TestConfigTOMLFileAndNewDirectoryPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode bits are not meaningful on Windows")
	}
	path := filepath.Join(t.TempDir(), "private", "config.toml")
	original := testConfigPath
	testConfigPath = path
	t.Cleanup(func() { testConfigPath = original })
	if err := writeConfigLocked(Config{ThemeColor: "purple", CompressionEnabled: true}); err != nil {
		t.Fatal(err)
	}
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if fileInfo.Mode().Perm() != 0o600 || dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("permissions file=%o dir=%o", fileInfo.Mode().Perm(), dirInfo.Mode().Perm())
	}
	if err := os.Chmod(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := writeConfigLocked(Config{ThemeColor: "amber", CompressionEnabled: true}); err != nil {
		t.Fatal(err)
	}
	dirInfo, err = os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o750 {
		t.Fatalf("existing directory mode loosened to %o", dirInfo.Mode().Perm())
	}
}

func TestConfigTOMLPrecedenceAndNoFallbackWhenPresent(t *testing.T) {
	primary := withTempConfig(t)
	legacy := withTempLegacyConfig(t)
	if err := os.WriteFile(legacy, []byte(`{"theme_color":"legacy"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"", "  \n  ", "# comment only\n"} {
		if err := os.WriteFile(primary, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		cfg, err := readConfigLocked()
		if err != nil || cfg.ThemeColor != "" {
			t.Fatalf("primary %q: cfg=%+v err=%v", content, cfg, err)
		}
	}
	if err := os.WriteFile(primary, []byte("broken = [\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readConfigLocked(); err == nil {
		t.Fatal("malformed primary unexpectedly used legacy fallback")
	}
}

func TestConfigNoOpSavePreservesCommentAndChangedValueRewrites(t *testing.T) {
	path := withTempConfig(t)
	cfg := applyConfigDefaults(Config{CompressionEnabled: true, ThemeColor: "purple", ThinkingPresets: []string{"low"}})
	if err := writeConfigLocked(cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(mustRead(t, path), []byte("# preserved\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	saveConfig(cfg)
	if w := thinkingPresetsRequest(t, "PUT", `{"thinking_presets":["low"]}`); w.Code != 200 {
		t.Fatalf("thinking presets status %d", w.Code)
	}
	if !strings.Contains(string(mustRead(t, path)), "# preserved") {
		t.Fatal("no-op writer removed comment")
	}
	cfg.ThemeColor = "amber"
	saveConfig(cfg)
	if strings.Contains(string(mustRead(t, path)), "# preserved") || loadConfig().ThemeColor != "amber" {
		t.Fatal("changed value did not rewrite and reload")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestConfigTOMLBOMAndCRLF(t *testing.T) {
	path := withTempConfig(t)
	for _, content := range [][]byte{[]byte("theme_color = 'amber'\r\n"), append([]byte{0xef, 0xbb, 0xbf}, []byte("theme_color = 'amber'\n")...)} {
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
		var cfg Config
		if err := toml.Unmarshal(content, &cfg); err != nil {
			t.Fatalf("pinned TOML decoder rejected input %q: %v", content, err)
		}
	}
}

func TestConfigTOMLUsesAbsoluteMapKeys(t *testing.T) {
	path := withTempConfig(t)
	cfg := Config{ExpandedWorktrees: map[string]bool{filepath.Join(string(os.PathSeparator), "tmp", "repo"): true}, CompressionEnabled: true}
	if err := writeConfigLocked(cfg); err != nil {
		t.Fatal(err)
	}
	var got Config
	b, _ := os.ReadFile(path)
	if err := toml.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.ExpandedWorktrees) != 1 {
		t.Fatalf("map key lost: %v", got.ExpandedWorktrees)
	}
}

func TestConfigStartupLoadRejectsInvalidOrUnreadableConfig(t *testing.T) {
	for _, tc := range []struct {
		name, content string
	}{
		{"invalid type after verifier", "access_password_hash = \"" + testAccessHash() + "\"\nui_font_size = 'not-an-integer'\n"},
		{"invalid type before verifier", "ui_font_size = 'not-an-integer'\naccess_password_hash = \"" + testAccessHash() + "\"\n"},
		{"malformed TOML", "theme_color = [\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			primary := withTempConfig(t)
			legacy := withTempLegacyConfig(t)
			if err := os.WriteFile(primary, []byte(tc.content), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(legacy, []byte(`{"theme_color":"stale-legacy"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadConfigWithError(); err == nil {
				t.Fatal("startup accepted an invalid config and can disable access protection")
			}
			if got := mustRead(t, primary); string(got) != tc.content {
				t.Fatal("startup load modified the invalid primary")
			}
		})
	}
	t.Run("unreadable primary", func(t *testing.T) {
		primary := withTempConfig(t)
		if err := os.Remove(primary); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(primary, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := loadConfigWithError(); err == nil {
			t.Fatal("startup accepted a directory as config")
		}
	})
}

func TestConfigStartupLoadDefaultsAndLegacyFallback(t *testing.T) {
	primary := withTempConfig(t)
	legacy := withTempLegacyConfig(t)
	if err := os.Remove(primary); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfigWithError()
	if err != nil || cfg.ThemeColor != "purple" || !cfg.CompressionEnabled {
		t.Fatalf("fresh config defaults: cfg=%+v err=%v", cfg, err)
	}
	if err := os.WriteFile(legacy, []byte(`{"access_password_hash":"`+testAccessHash()+`","compression_enabled":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err = loadConfigWithError()
	if err != nil || cfg.AccessPasswordHash != testAccessHash() || cfg.CompressionEnabled {
		t.Fatalf("valid legacy startup config: cfg=%+v err=%v", cfg, err)
	}
	if err := os.WriteFile(legacy, []byte(`{"access_password_hash":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfigWithError(); err == nil {
		t.Fatal("startup accepted malformed legacy JSON")
	}
	if err := os.WriteFile(primary, []byte("# deliberately empty primary\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err = loadConfigWithError()
	if err != nil || cfg.ThemeColor != "purple" || cfg.AccessPasswordHash != "" {
		t.Fatalf("blank primary must win over malformed legacy: cfg=%+v err=%v", cfg, err)
	}
}

func TestConfigMalformedPrimaryIsNotOverwrittenBySave(t *testing.T) {
	path := withTempConfig(t)
	before := []byte("theme_color = [\n")
	if err := os.WriteFile(path, before, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{ThemeColor: "amber", CompressionEnabled: true}
	if err := writeConfigLocked(cfg); err == nil {
		t.Fatal("writeConfigLocked accepted malformed primary TOML")
	}
	saveConfig(cfg)
	if got := mustRead(t, path); !reflect.DeepEqual(got, before) {
		t.Fatalf("malformed primary changed: got %q want %q", got, before)
	}
}

func TestConfigMalformedLegacyDoesNotCreatePrimary(t *testing.T) {
	primary := withTempConfig(t)
	legacy := withTempLegacyConfig(t)
	if err := os.Remove(primary); err != nil {
		t.Fatal(err)
	}
	legacyBytes := []byte(`{"theme_color":`)
	if err := os.WriteFile(legacy, legacyBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	migrateLegacyConfig()
	if _, err := os.Lstat(primary); !os.IsNotExist(err) {
		t.Fatalf("malformed legacy JSON created primary: stat error=%v", err)
	}
	if got := mustRead(t, legacy); !reflect.DeepEqual(got, legacyBytes) {
		t.Fatalf("legacy JSON changed: got %q want %q", got, legacyBytes)
	}
}

func TestConfigDanglingPrimarySymlinkBlocksLegacyFallbackAndMigration(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require elevated privileges on Windows")
	}
	primary := withTempConfig(t)
	legacy := withTempLegacyConfig(t)
	if err := os.Remove(primary); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(filepath.Dir(primary), "missing-config.toml"), primary); err != nil {
		t.Fatalf("create dangling primary symlink: %v", err)
	}
	legacyBytes := []byte(`{"theme_color":"stale-legacy"}`)
	if err := os.WriteFile(legacy, legacyBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if cfg, err := readConfigLocked(); err == nil || cfg.ThemeColor == "stale-legacy" {
		t.Fatalf("dangling primary used legacy fallback: cfg=%+v err=%v", cfg, err)
	}
	migrateLegacyConfig()
	info, err := os.Lstat(primary)
	if err != nil {
		t.Fatalf("migration removed dangling symlink: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("migration replaced dangling primary symlink")
	}
	if got := mustRead(t, legacy); !reflect.DeepEqual(got, legacyBytes) {
		t.Fatalf("legacy JSON changed: got %q want %q", got, legacyBytes)
	}
}

func TestConfigMigrationWriteFailurePreservesLegacy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permission semantics differ on Windows")
	}
	dir := filepath.Join(t.TempDir(), "config-dir")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	primary := filepath.Join(dir, "config.toml")
	originalPath := testConfigPath
	testConfigPath = primary
	t.Cleanup(func() { testConfigPath = originalPath })
	legacy := withTempLegacyConfig(t)
	legacyBytes := []byte(`{"theme_color":"amber"}`)
	if err := os.WriteFile(legacy, legacyBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	probe := filepath.Join(dir, "write-probe")
	if err := os.WriteFile(probe, []byte("probe"), 0o600); err == nil {
		_ = os.Remove(probe)
		_ = os.Chmod(dir, 0o700)
		t.Skip("filesystem permits writes despite restrictive directory mode")
	} else if !os.IsPermission(err) {
		t.Fatalf("write probe failed for unexpected reason: %v", err)
	}

	migrateLegacyConfig()
	if _, err := os.Lstat(primary); !os.IsNotExist(err) {
		t.Fatalf("failed migration created primary: stat error=%v", err)
	}
	if got := mustRead(t, legacy); !reflect.DeepEqual(got, legacyBytes) {
		t.Fatalf("legacy JSON changed: got %q want %q", got, legacyBytes)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
}
