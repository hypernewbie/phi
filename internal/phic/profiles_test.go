package phic

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDesktopProfilesRailOrderMRUAndSharedBackup(t *testing.T) {
	file := filepath.Join(t.TempDir(), "profiles.json")
	data := []byte(`{"profiles":[{"id":"a","name":"A","origin":"http://a:7070/","lastUsed":"2026-09-01T00:00:00Z"},{"id":"invalid","origin":"http://user:secret@b/"},{"id":"a","origin":"http://duplicate/"},{"id":"b","name":"B","origin":"https://b/","lastUsed":"2026-10-01T00:00:00Z"},{"id":"c","origin":"https://b/"}],"closeToTray":true,"syncAlerts":false,"petEnabled":true}`)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	cfg := config{Profiles: file, Server: "http://127.0.0.1:7070"}
	profiles, index, err := loadServerProfiles(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 4 || profiles[0].ID != "a" || profiles[2].ID != "b" || profiles[3].ID != "c" || index != 2 {
		t.Fatalf("desktop rail/MRU mismatch: %+v %d", profiles, index)
	}
	cfg.ServerExplicit = true
	cfg.Server = "http://a:7070"
	profiles, index, err = loadServerProfiles(cfg)
	if err != nil || len(profiles) != 4 || index != 0 {
		t.Fatalf("explicit matching origin duplicated: %+v %d %v", profiles, index, err)
	}
	original, _ := os.ReadFile(file)
	if !bytes.Equal(original, data) {
		t.Fatal("client modified desktop preferences")
	}
	if err := os.WriteFile(file+".bak", data, 0600); err != nil {
		t.Fatal(err)
	}
	corrupt := []byte("partial write")
	_ = os.WriteFile(file, corrupt, 0600)
	cfg.ServerExplicit = false
	profiles, index, err = loadServerProfiles(cfg)
	if err != nil || len(profiles) != 4 || index != 2 {
		t.Fatalf("shared backup recovery failed: %+v %d %v", profiles, index, err)
	}
	original, _ = os.ReadFile(file)
	if !json.Valid(original) {
		t.Fatal("recovered file not readable by desktop")
	}
	aside, _ := filepath.Glob(file + ".corrupt-*")
	if len(aside) != 1 {
		t.Fatal("corrupt input not preserved")
	}
}

func TestExplicitServerSharesDesktopConfigurationAndFlagBindsProfiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	cfg, err := parseFlags([]string{"--server", "https://example:7443", "--profiles", "some/file.json", "."})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ServerExplicit || cfg.Profiles != "some/file.json" {
		t.Fatalf("flags did not bind: %+v", cfg)
	}
	cfg.Profiles = ""
	profiles, index, err := loadServerProfiles(cfg)
	if err != nil || len(profiles) != 1 || index != 0 || profiles[0].Origin != cfg.Server+"/" {
		t.Fatalf("explicit origin not persisted: %+v %d %v", profiles, index, err)
	}
	store, err := desktopStoreFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := readDesktopProfiles(store.path)
	if err != nil || len(saved) != 1 || saved[0].ID != profiles[0].ID {
		t.Fatal("explicit connection not saved for desktop")
	}
	paths := desktopProfilePaths("/config")
	if paths[0] != filepath.Join("/config", "phi-client", "profiles.json") || paths[1] != filepath.Join("/config", "phi-desktop-electron", "profiles.json") {
		t.Fatalf("unexpected desktop paths: %q", paths)
	}
}

func TestRememberedPaneDoesNotAliasControllerVariable(t *testing.T) {
	var a, b serverState
	current := SelectResult{PaneID: "a", Existing: &TerminalView{Dir: "/one"}}
	a.remember(current)
	current = SelectResult{PaneID: "b", Existing: &TerminalView{Dir: "/two"}}
	b.remember(current)
	current = SelectResult{PaneID: "c"}
	if a.selection.PaneID != "a" || a.selection.Existing.Dir != "/one" || b.selection.PaneID != "b" {
		t.Fatal("pane selection leaked between servers")
	}
}

func TestAbsoluteServerPathsDoNotRequireClientFilesystem(t *testing.T) {
	for _, origin := range []string{"http://127.0.0.1:7070", "https://remote.invalid"} {
		api, err := newAPIClient(origin)
		if err != nil {
			t.Fatal(err)
		}
		c := client{api: api}
		for _, dir := range []string{"/phic-nonexistent-server/project", `C:\server\project`} {
			got, err := c.directory(t.Context(), dir)
			if err != nil || got != dir {
				t.Fatalf("server directory changed: %s %q %v", origin, got, err)
			}
		}
	}
}

func TestThemeOracleInput(t *testing.T) {
	data, _ := json.Marshal(phiAccents)
	t.Log("PHIC_PALETTE " + string(data))
}

func TestThemeNeverEmitsUntrustedControls(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "xterm-256color")
	output := themeText("\x1b]52;c;attack\a", "SAFE", false)
	if output != "\x1b[38;2;124;106;247mSAFE\x1b[0m" {
		t.Fatalf("untrusted theme changed rendering: %q", output)
	}
	t.Setenv("NO_COLOR", "1")
	if themeText("blue", "SAFE", true) != "SAFE" {
		t.Fatal("NO_COLOR not respected")
	}
}
