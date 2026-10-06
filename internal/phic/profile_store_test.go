package phic

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedStoreFailedBackupDoesNotReplacePrimary(t *testing.T) {
	store := &desktopStore{path: filepath.Join(t.TempDir(), "profiles.json")}
	if _, err := store.add("http://original.example/"); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(store.path)
	if err := os.Mkdir(store.path+".bak", 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.add("http://unsaved.example/"); err == nil {
		t.Fatal("failed persistence reported success")
	}
	after, _ := os.ReadFile(store.path)
	if !bytes.Equal(before, after) {
		t.Fatal("failed backup replaced primary")
	}
	pending, _ := filepath.Glob(filepath.Join(filepath.Dir(store.path), "profiles.json.tmp-*"))
	if len(pending) != 0 {
		t.Fatal("temporary file leaked")
	}
}

func TestSharedStoreDoesNotResurrectDesktopRemovalOrOverwriteLatestPrefs(t *testing.T) {
	store := &desktopStore{path: filepath.Join(t.TempDir(), "profiles.json")}
	p, err := store.add("http://one.example/")
	if err != nil {
		t.Fatal(err)
	}
	// A long-lived Go store does not hold an authoritative snapshot.
	latest := []byte(`{"profiles":[],"petEnabled":true,"contentZoomPercent":175,"unknown":{"keep":true}}`)
	if err := os.WriteFile(store.path, latest, 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.setLastUsed(p.ID); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(store.path)
	if !bytes.Equal(after, latest) {
		t.Fatal("lastUsed resurrected removed profile")
	}
	if _, err := store.add("https://two.example/"); err != nil {
		t.Fatal(err)
	}
	after, _ = os.ReadFile(store.path)
	var doc map[string]any
	if json.Unmarshal(after, &doc) != nil || doc["petEnabled"] != true || doc["contentZoomPercent"] != float64(175) || doc["unknown"] == nil {
		t.Fatal("latest desktop preferences discarded")
	}
	profiles, err := readDesktopProfiles(store.path)
	if err != nil || len(profiles) != 1 || profiles[0].Origin != "https://two.example/" {
		t.Fatal("deleted desktop row reappeared")
	}
}
