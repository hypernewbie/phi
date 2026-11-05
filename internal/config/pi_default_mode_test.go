package config

import (
	"os"
	"strings"
	"testing"
)

// TestPiDefaultModeMigration proves the invariant the launch code relies on:
// the default agent is explicit everywhere. Startup migration persists "pi"
// for older configs; reads report the explicit value without touching disk.
// An explicit choice is never rewritten.
func TestPiDefaultModeMigration(t *testing.T) {
	t.Run("legacy file gains an explicit pi default at startup", func(t *testing.T) {
		path := withTempConfig(t)
		if err := os.WriteFile(path, []byte("theme_color = \"blue\"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := currentStore().MigratePiDefault(); err != nil {
			t.Fatal(err)
		}
		cfg, err := loadConfigWithError()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.PiDefaultMode != "pi" {
			t.Fatalf("in-memory default = %q, want pi", cfg.PiDefaultMode)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `pi_default_mode = "pi"`) {
			t.Fatalf("migration was not persisted: %s", data)
		}
		if !strings.Contains(string(data), `theme_color = "blue"`) {
			t.Fatalf("migration dropped existing settings: %s", data)
		}
	})

	t.Run("hand-removed default is migrated again on the next startup", func(t *testing.T) {
		path := withTempConfig(t)
		if err := currentStore().MigratePiDefault(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("theme_color = \"blue\"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		currentStore().ResetCache()
		if err := currentStore().MigratePiDefault(); err != nil {
			t.Fatal(err)
		}
		cfg, err := loadConfigWithError()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.PiDefaultMode != "pi" {
			t.Fatalf("default after hand edit = %q, want pi", cfg.PiDefaultMode)
		}
		data, _ := os.ReadFile(path)
		if !strings.Contains(string(data), `pi_default_mode = "pi"`) {
			t.Fatalf("second migration was not persisted: %s", data)
		}
	})

	t.Run("an explicit psi choice survives load and unrelated writes", func(t *testing.T) {
		path := withTempConfig(t)
		if err := os.WriteFile(path, []byte("pi_default_mode = \"psi\"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := currentStore().MigratePiDefault(); err != nil {
			t.Fatal(err)
		}
		cfg, err := loadConfigWithError()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.PiDefaultMode != "psi" {
			t.Fatalf("explicit choice rewritten to %q", cfg.PiDefaultMode)
		}
		if _, err := currentStore().Update(func(c *Config) error { c.ThemeColor = "red"; return nil }); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(path)
		if !strings.Contains(string(data), `pi_default_mode = "psi"`) {
			t.Fatalf("unrelated write changed the explicit choice: %s", data)
		}
	})

	t.Run("reads report pi without rewriting the file", func(t *testing.T) {
		path := withTempConfig(t)
		content := []byte("theme_color = \"blue\"\n")
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
		cfg, err := loadConfigWithError()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.PiDefaultMode != "pi" {
			t.Fatalf("in-memory default = %q, want pi", cfg.PiDefaultMode)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != string(content) {
			t.Fatalf("a read rewrote the config: %s", data)
		}
	})
}
