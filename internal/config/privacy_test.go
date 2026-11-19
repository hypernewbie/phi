package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

func TestSyncTopicPeerSecretsStayOutOfJSON(t *testing.T) {
	cfg := Config{
		SyncTopicsPeerID:       "peer-visible-id",
		SyncTopicsPeerSecret:   strings.Repeat("a", 64),
		SyncTopicsAllowedPeers: map[string]string{"peer-visible-id": strings.Repeat("c", 64)},
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "sync_topics") || strings.Contains(text, cfg.SyncTopicsPeerSecret) ||
		strings.Contains(text, cfg.SyncTopicsPeerID) || strings.Contains(text, "peer-visible-id") {
		t.Fatalf("private peer settings leaked through JSON: %s", text)
	}
}

func TestSyncTopicAllowedPeersParseAsATable(t *testing.T) {
	var cfg Config
	if _, err := toml.Decode(`
sync_topics_peer_id = "f1"
sync_topics_peer_secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
[sync_topics_allowed_peers]
"f1" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
"f2" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
`, &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.SyncTopicsAllowedPeers) != 2 || cfg.SyncTopicsAllowedPeers["f2"] != strings.Repeat("b", 64) {
		t.Fatalf("allowed peers = %+v", cfg.SyncTopicsAllowedPeers)
	}
}

func TestSyncTopicPeerSettingsCloneAndSurvivePublicSaves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(Paths{Primary: path}, nil)
	secret := strings.Repeat("a", 64)
	if _, err := store.Update(func(cfg *Config) error {
		cfg.SyncTopicsPeerID = "f1"
		cfg.SyncTopicsPeerSecret = secret
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	first, err := store.LoadWithError()
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.LoadWithError()
	if err != nil {
		t.Fatal(err)
	}
	first.SyncTopicsAllowedPeers["f1"] = "mutated"
	if second.SyncTopicsAllowedPeers["f1"] != secret {
		t.Fatal("cached config loads alias the private allowlist")
	}
	stale, err := store.LoadWithError()
	if err != nil {
		t.Fatal(err)
	}
	store.SaveLegacy(Config{ThemeColor: "#111"})
	got, err := store.LoadWithError()
	if err != nil {
		t.Fatal(err)
	}
	if got.ThemeColor != "#111" || got.SyncTopicsPeerID != "f1" ||
		got.SyncTopicsPeerSecret != secret || got.SyncTopicsAllowedPeers["f1"] != secret {
		t.Fatalf("public save lost private peer settings: %+v", got)
	}
	if _, err := store.Update(func(cfg *Config) error {
		cfg.SyncTopicsAllowedPeers = map[string]string{}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	store.SaveLegacy(stale)
	got, err = store.LoadWithError()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.SyncTopicsAllowedPeers) != 0 {
		t.Fatalf("stale public save rolled back a peer revocation: %+v", got.SyncTopicsAllowedPeers)
	}
}
