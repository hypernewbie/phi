package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// resetConfigCache empties the config read cache for the test and restores
// the empty state afterwards, so entries never leak across tests.
func resetConfigCache(t *testing.T) {
	t.Helper()
	currentStore().mu.Lock()
	currentStore().cache = nil
	currentStore().mu.Unlock()
	t.Cleanup(func() {
		currentStore().mu.Lock()
		currentStore().cache = nil
		currentStore().mu.Unlock()
	})
}

// cachedLoad exercises the cached read path exactly as loadConfigWithError
// does, counting real primary reads through counter.
func cachedLoad(counter *int) (Config, error) {
	currentStore().mu.Lock()
	defer currentStore().mu.Unlock()
	cfg, err := readConfigCachedLocked(func() (Config, bool, error) {
		*counter++
		return readPrimaryConfig()
	})
	if err != nil {
		return Config{}, err
	}
	return applyDefaults(cfg), nil
}

// cachedRaw returns a copy of the raw cached Config, if any.
func cachedRaw() (Config, bool) {
	currentStore().mu.Lock()
	defer currentStore().mu.Unlock()
	if currentStore().cache == nil {
		return Config{}, false
	}
	return cloneConfig(currentStore().cache.cfg), true
}

func writePrimary(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestConfigCacheReuseAndReload(t *testing.T) {
	path := withTempConfig(t)
	resetConfigCache(t)
	writePrimary(t, path, "theme_color = \"amber\"\n")
	var n int
	for i := 0; i < 3; i++ {
		cfg, err := cachedLoad(&n)
		if err != nil || cfg.ThemeColor != "amber" {
			t.Fatalf("load %d: cfg=%+v err=%v", i, cfg, err)
		}
	}
	if n != 1 {
		t.Fatalf("unchanged file read %d times, want 1", n)
	}
	writePrimary(t, path, "theme_color = \"cyan\"\n")
	cfg, err := cachedLoad(&n)
	if err != nil || cfg.ThemeColor != "cyan" {
		t.Fatalf("changed file: cfg=%+v err=%v", cfg, err)
	}
	if n != 2 {
		t.Fatalf("changed file read total %d, want 2", n)
	}
	if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "cyan" || n != 2 {
		t.Fatalf("reload did not cache: cfg=%+v err=%v reads=%d", cfg, err, n)
	}
}

func TestConfigCacheAtomicReplaceSameMetadata(t *testing.T) {
	for _, kind := range []string{"regular file", "symlink target"} {
		t.Run(kind, func(t *testing.T) {
			if kind == "symlink target" && runtime.GOOS == "windows" {
				t.Skip("symlink creation may require elevated privileges on Windows")
			}
			path := withTempConfig(t)
			resetConfigCache(t)
			target := path
			if kind == "symlink target" {
				target = path + ".target"
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			}
			writePrimary(t, target, "theme_color = \"aaaa\"\n")
			var n int
			for range 2 {
				if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "aaaa" {
					t.Fatalf("seed: cfg=%+v err=%v", cfg, err)
				}
			}
			if n != 1 {
				t.Fatalf("unchanged %s was not cached: reads=%d", kind, n)
			}
			orig, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			// Restore size/mtime/mode after replacement: only the target's
			// inode changes. For a symlink the link itself stays untouched.
			tmp := target + ".new"
			if err := os.WriteFile(tmp, []byte("theme_color = \"bbbb\"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(tmp, target); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(target, orig.ModTime(), orig.ModTime()); err != nil {
				t.Fatal(err)
			}
			replaced, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if replaced.Size() != orig.Size() || !replaced.ModTime().Equal(orig.ModTime()) || replaced.Mode() != orig.Mode() {
				t.Fatalf("fixture must preserve size/mtime/mode: before=%v after=%v", orig, replaced)
			}
			if os.SameFile(orig, replaced) {
				t.Fatal("fixture must replace the inode")
			}
			cfg, err := cachedLoad(&n)
			if err != nil || cfg.ThemeColor != "bbbb" || n != 2 {
				t.Fatalf("replacement not reloaded: cfg=%+v err=%v reads=%d", cfg, err, n)
			}
		})
	}
}

func TestConfigCacheMutationIsolation(t *testing.T) {
	path := withTempConfig(t)
	resetConfigCache(t)
	writePrimary(t, path, `theme_color = "amber"
workspaces = ["/repo/a", "/repo/b"]
thinking_presets = ["low", "high"]
markdown_dirs = ["docs"]
replay_buffer_bytes = 123
mobile_ui_font_family = "MUI"
mobile_ui_font_size = 21
mobile_terminal_font_family = "MTF"
mobile_terminal_font_size = 22
mobile_appearance_revision = 7
auth_origins = ["https://one.test", "https://two.test"]
[access_auth_migration]
state = "pending"
id = "AAAAAAAAAAAAAAAAAAAAAA"
[[quick_commands]]
name = "q"
command = "echo q"
[[terminal_commands]]
name = "t"
command = "echo t"
[[peers]]
name = "p"
url = "http://p.test"
[expanded_worktrees]
"/repo/a" = true
[active_worktrees]
"/repo/a" = "w1"
[model_presets]
pi = ["m1", "m2"]
`)
	var n int
	first, err := cachedLoad(&n)
	if err != nil {
		t.Fatal(err)
	}
	// Check both the initial miss and a subsequent hit: neither may expose
	// mutable cache storage to its caller.
	for range 2 {
		// Mutate every mutable field class of the returned value.
		first.ThemeColor = "MUT"
		first.Workspaces[0] = "MUT"
		first.Workspaces = append(first.Workspaces, "MUT")
		first.ThinkingPresets[0] = "MUT"
		first.MarkdownDirs[0] = "MUT"
		first.QuickCommands[0].Name = "MUT"
		first.TerminalCommands[0].Command = "MUT"
		first.Peers[0].URL = "MUT"
		first.ExpandedWorktrees["MUT"] = true
		delete(first.ExpandedWorktrees, "/repo/a")
		first.ActiveWorktrees["/repo/a"] = "MUT"
		first.ModelPresets["pi"][0] = "MUT"
		first.ModelPresets["MUT"] = []string{"x"}
		*first.MobileUIFontFamily = "MUT"
		*first.MobileUIFontSize = 99
		*first.MobileTerminalFontFamily = "MUT"
		*first.MobileTerminalFontSize = 99
		*first.ReplayBufferBytes = 999
		first.AuthOrigins[0] = "MUT"
		first.AccessAuthMigration.State = "MUT"

		second, err := cachedLoad(&n)
		if err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("pristine reread cost a real read: total %d", n)
		}
		if second.ThemeColor != "amber" || second.Workspaces[0] != "/repo/a" || len(second.Workspaces) != 2 ||
			second.ThinkingPresets[0] != "low" || second.MarkdownDirs[0] != "docs" ||
			second.QuickCommands[0].Name != "q" || second.TerminalCommands[0].Command != "echo t" ||
			second.Peers[0].URL != "http://p.test" || !second.ExpandedWorktrees["/repo/a"] ||
			len(second.ExpandedWorktrees) != 1 || second.ActiveWorktrees["/repo/a"] != "w1" ||
			second.ModelPresets["pi"][0] != "m1" || len(second.ModelPresets["pi"]) != 2 ||
			len(second.ModelPresets) != 4 || // pi plus opencode/claude/agy defaults
			*second.MobileUIFontFamily != "MUI" || *second.MobileUIFontSize != 21 ||
			*second.MobileTerminalFontFamily != "MTF" || *second.MobileTerminalFontSize != 22 ||
			second.MobileAppearanceRevision != 7 || *second.ReplayBufferBytes != 123 ||
			second.AuthOrigins[0] != "https://one.test" || len(second.AuthOrigins) != 2 ||
			second.AccessAuthMigration.State != "pending" {
			t.Fatalf("caller mutation leaked into cache: %+v", second)
		}
		first = second
	}

	// A minimal file proves defaults land on the returned copy, not the raw entry.
	writePrimary(t, path, "theme_color = \"amber\"\n")
	minimal, err := cachedLoad(&n)
	if err != nil {
		t.Fatal(err)
	}
	if minimal.Workspaces == nil || minimal.ExpandedWorktrees == nil || minimal.ModelPresets == nil {
		t.Fatalf("defaults missing from returned value: %+v", minimal)
	}
	raw, ok := cachedRaw()
	if !ok {
		t.Fatal("minimal read did not populate the cache")
	}
	if raw.Workspaces != nil || raw.ExpandedWorktrees != nil || raw.ActiveWorktrees != nil ||
		raw.ModelPresets != nil || raw.ThinkingPresets != nil || raw.QuickCommands != nil ||
		raw.TerminalCommands != nil || raw.MarkdownDirs != nil || raw.Peers != nil ||
		raw.MobileUIFontFamily != nil || raw.MobileUIFontSize != nil ||
		raw.MobileTerminalFontFamily != nil || raw.MobileTerminalFontSize != nil ||
		raw.ReplayBufferBytes != nil || raw.AuthOrigins != nil || raw.AccessAuthMigration != nil {
		t.Fatalf("defaults leaked into raw cache entry: %+v", raw)
	}
}

func TestConfigCachePathSwitch(t *testing.T) {
	pathA := withTempConfig(t)
	resetConfigCache(t)
	writePrimary(t, pathA, "theme_color = \"aaa\"\n")
	var n int
	if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "aaa" {
		t.Fatalf("first path: cfg=%+v err=%v", cfg, err)
	}
	pathB := withTempConfig(t)
	writePrimary(t, pathB, "theme_color = \"bbb\"\n")
	cfg, err := cachedLoad(&n)
	if err != nil || cfg.ThemeColor != "bbb" {
		t.Fatalf("second path served first path's value: cfg=%+v err=%v", cfg, err)
	}
	if n != 2 {
		t.Fatalf("path switch read total %d, want 2", n)
	}
}

func TestConfigCacheErrorsAndPrecedence(t *testing.T) {
	resetConfigCache(t)

	t.Run("malformed after warm hit", func(t *testing.T) {
		path := withTempConfig(t)
		writePrimary(t, path, "theme_color = \"amber\"\n")
		var n int
		if _, err := cachedLoad(&n); err != nil {
			t.Fatal(err)
		}
		writePrimary(t, path, "theme_color = [\n")
		if cfg, err := cachedLoad(&n); err == nil {
			t.Fatalf("malformed primary served stale value: %+v", cfg)
		}
		if n != 2 {
			t.Fatalf("malformed read total %d, want 2", n)
		}
		writePrimary(t, path, "theme_color = \"recovered\"\n")
		cfg, err := cachedLoad(&n)
		if err != nil || cfg.ThemeColor != "recovered" {
			t.Fatalf("repair did not recover: cfg=%+v err=%v", cfg, err)
		}
	})

	t.Run("directory as primary", func(t *testing.T) {
		path := withTempConfig(t)
		writePrimary(t, path, "theme_color = \"amber\"\n")
		var n int
		if _, err := cachedLoad(&n); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if cfg, err := cachedLoad(&n); err == nil {
			t.Fatalf("directory primary served stale value: %+v", cfg)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		writePrimary(t, path, "theme_color = \"amber\"\n")
		if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "amber" {
			t.Fatalf("repair did not recover: cfg=%+v err=%v", cfg, err)
		}
	})

	t.Run("dangling symlink", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlink creation may require elevated privileges on Windows")
		}
		path := withTempConfig(t)
		writePrimary(t, path, "theme_color = \"amber\"\n")
		var n int
		if _, err := cachedLoad(&n); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(filepath.Dir(path), "missing-config.toml"), path); err != nil {
			t.Fatal(err)
		}
		if cfg, err := cachedLoad(&n); err == nil {
			t.Fatalf("dangling symlink served stale value: %+v", cfg)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		writePrimary(t, path, "theme_color = \"amber\"\n")
		if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "amber" {
			t.Fatalf("repair did not recover: cfg=%+v err=%v", cfg, err)
		}
	})

	t.Run("deletion falls back to legacy and restore recovers", func(t *testing.T) {
		path := withTempConfig(t)
		legacy := withTempLegacyConfig(t)
		if err := os.WriteFile(legacy, []byte(`{"theme_color":"legacy-val"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		writePrimary(t, path, "theme_color = \"primary-val\"\n")
		var n int
		if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "primary-val" {
			t.Fatalf("seed: cfg=%+v err=%v", cfg, err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		cfg, err := cachedLoad(&n)
		if err != nil || cfg.ThemeColor != "legacy-val" {
			t.Fatalf("deleted primary did not use legacy: cfg=%+v err=%v", cfg, err)
		}
		writePrimary(t, path, "theme_color = \"primary-val\"\n")
		if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "primary-val" {
			t.Fatalf("restored primary did not win: cfg=%+v err=%v", cfg, err)
		}
		if n != 3 {
			t.Fatalf("primary read total %d, want 3", n)
		}
	})

	t.Run("empty primary wins and caches", func(t *testing.T) {
		path := withTempConfig(t)
		legacy := withTempLegacyConfig(t)
		if err := os.WriteFile(legacy, []byte(`{"theme_color":"legacy-val"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		writePrimary(t, path, "  \n  ")
		var n int
		cfg, err := cachedLoad(&n)
		if err != nil || cfg.ThemeColor != "purple" {
			t.Fatalf("blank primary did not win over legacy: cfg=%+v err=%v", cfg, err)
		}
		if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "purple" || n != 1 {
			t.Fatalf("blank primary did not cache: cfg=%+v err=%v reads=%d", cfg, err, n)
		}
	})
}

func TestConfigCacheWriteInvalidation(t *testing.T) {
	t.Run("successful write", func(t *testing.T) {
		withTempConfig(t)
		resetConfigCache(t)
		var n int
		first, err := cachedLoad(&n)
		if err != nil {
			t.Fatal(err)
		}
		first.ThemeColor = "written"
		currentStore().mu.Lock()
		werr := writeConfigLocked(first)
		currentStore().mu.Unlock()
		if werr != nil {
			t.Fatal(werr)
		}
		cfg, err := cachedLoad(&n)
		if err != nil || cfg.ThemeColor != "written" {
			t.Fatalf("write not visible: cfg=%+v err=%v", cfg, err)
		}
		if n != 2 {
			t.Fatalf("read total after write %d, want 2", n)
		}
	})

	t.Run("no-op write rereads", func(t *testing.T) {
		withTempConfig(t)
		resetConfigCache(t)
		var n int
		loaded, err := cachedLoad(&n)
		if err != nil {
			t.Fatal(err)
		}
		currentStore().mu.Lock()
		werr := writeConfigLocked(loaded)
		currentStore().mu.Unlock()
		if werr != nil {
			t.Fatal(werr)
		}
		cfg, err := cachedLoad(&n)
		if err != nil || cfg.ThemeColor != loaded.ThemeColor {
			t.Fatalf("no-op write changed values: cfg=%+v err=%v", cfg, err)
		}
		if n != 2 {
			t.Fatalf("read total after no-op write %d, want 2", n)
		}
	})

	t.Run("failed write publishes nothing", func(t *testing.T) {
		path := withTempConfig(t)
		resetConfigCache(t)
		writePrimary(t, path, "theme_color = \"amber\"\n")
		var n int
		if _, err := cachedLoad(&n); err != nil {
			t.Fatal(err)
		}
		writePrimary(t, path, "theme_color = [\n")
		currentStore().mu.Lock()
		werr := writeConfigLocked(Config{ThemeColor: "bogus", CompressionEnabled: true})
		currentStore().mu.Unlock()
		if werr == nil {
			t.Fatal("writeConfigLocked accepted malformed primary TOML")
		}
		if cfg, err := cachedLoad(&n); err == nil {
			t.Fatalf("failed write left a servable value: %+v", cfg)
		}
		writePrimary(t, path, "theme_color = \"amber\"\n")
		cfg, err := cachedLoad(&n)
		if err != nil || cfg.ThemeColor != "amber" {
			t.Fatalf("repair did not recover: cfg=%+v err=%v", cfg, err)
		}
		if n != 3 {
			t.Fatalf("read total %d, want 3", n)
		}
	})
}

func TestConfigCacheUnstableReadNotPublished(t *testing.T) {
	path := withTempConfig(t)
	resetConfigCache(t)
	writePrimary(t, path, "theme_color = \"stable\"\n")
	var n int
	if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "stable" {
		t.Fatalf("seed: cfg=%+v err=%v", cfg, err)
	}
	// A different-length rewrite forces the next read to miss the cache, so
	// the swapping callback below actually runs.
	writePrimary(t, path, "theme_color = \"mid-read-base\"\n")
	var swapErr error
	currentStore().mu.Lock()
	cfg, err := readConfigCachedLocked(func() (Config, bool, error) {
		c, p, e := readPrimaryConfig()
		if e == nil && p {
			// Replace the file after the content read but before the
			// helper's post-read identity check.
			swapErr = os.WriteFile(configFilePath(), []byte("theme_color = \"swapped-in-content\"\n"), 0o600)
		}
		return c, p, e
	})
	currentStore().mu.Unlock()
	if swapErr != nil {
		t.Fatal(swapErr)
	}
	if err != nil || cfg.ThemeColor != "mid-read-base" {
		t.Fatalf("unstable read did not return its own result: cfg=%+v err=%v", cfg, err)
	}
	if _, ok := cachedRaw(); ok {
		t.Fatal("read across a mid-read replacement was published")
	}
	if cfg, err := cachedLoad(&n); err != nil || cfg.ThemeColor != "swapped-in-content" {
		t.Fatalf("follow-up did not reload: cfg=%+v err=%v", cfg, err)
	}
	if n != 2 {
		t.Fatalf("read total %d, want 2", n)
	}
}
