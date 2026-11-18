package phiprofiles

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseValidDocument(t *testing.T) {
	d, err := Parse([]byte(`{"profiles":[
		{"id":"a","name":"Work","origin":"http://10.0.0.1:7070","lastUsed":"2024-01-02T03:04:05Z"},
		{"id":"b","origin":"http://10.0.0.2:7070"}
	],"closeToTray":true}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	profiles := d.Profiles()
	if len(profiles) != 2 {
		t.Fatalf("want 2 profiles, got %d", len(profiles))
	}
	if profiles[0].Name != "Work" || profiles[0].LastUsed != "2024-01-02T03:04:05Z" {
		t.Fatalf("row 0 mismatch: %+v", profiles[0])
	}
	// A missing name falls back to the origin.
	if profiles[1].Name != "http://10.0.0.2:7070" {
		t.Fatalf("row 1 name fallback: %+v", profiles[1])
	}
}

func TestParseSkipsInvalidAndDuplicateRows(t *testing.T) {
	d, err := Parse([]byte(`{"profiles":[
		{"id":"a","origin":"http://a"},
		{"origin":"http://no-id"},
		{"id":"","origin":"http://empty-id"},
		{"id":"a","origin":"http://duplicate"},
		"not-an-object",
		{"id":"c","origin":"http://c"}
	]}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	profiles := d.Profiles()
	if len(profiles) != 2 {
		t.Fatalf("want 2 surviving profiles, got %d: %+v", len(profiles), profiles)
	}
	if profiles[0].ID != "a" || profiles[0].Origin != "http://a" {
		t.Fatalf("duplicate id kept the wrong row: %+v", profiles[0])
	}
	if profiles[1].ID != "c" {
		t.Fatalf("second survivor: %+v", profiles[1])
	}
}

func TestParseRejectsMalformedDocuments(t *testing.T) {
	cases := map[string]string{
		"not json":         `profiles=[]`,
		"not an object":    `[]`,
		"no profiles":      `{"settings":true}`,
		"profiles not arr": `{"profiles":{}}`,
	}
	for name, data := range cases {
		if _, err := Parse([]byte(data)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestEmptyIsAParsableDocument(t *testing.T) {
	d := Empty()
	if len(d.Profiles()) != 0 {
		t.Fatalf("empty document has profiles: %+v", d.Profiles())
	}
	if d.Fields()["closeToTray"] == nil {
		t.Fatal("empty document lost desktop settings")
	}
}

func TestFieldsPreservesUnknownDesktopSettings(t *testing.T) {
	d, err := Parse([]byte(`{"profiles":[{"id":"a","origin":"http://a"}],"petEnabled":true,"unknownFutureField":{"nested":1}}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	fields := d.Fields()
	if string(fields["petEnabled"]) != "true" {
		t.Fatalf("petEnabled not preserved: %s", fields["petEnabled"])
	}
	if fields["unknownFutureField"] == nil {
		t.Fatal("unknown field dropped")
	}
}

func TestPathsOrder(t *testing.T) {
	paths := Paths("/cfg")
	want := []string{
		"/cfg/phi-client/profiles.json",
		"/cfg/phi-desktop-electron/profiles.json",
		"/cfg/Phi/profiles.json",
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("path %d: got %s want %s", i, paths[i], want[i])
		}
	}
}

func TestDefaultPathOverrideWins(t *testing.T) {
	p, err := DefaultPath("/explicit/path.json")
	if err != nil || p != "/explicit/path.json" {
		t.Fatalf("override: got %q err %v", p, err)
	}
}

func TestDefaultPathFallsBackToBak(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	legacy := filepath.Join(dir, "config", "phi-client")
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "profiles.json.bak"), []byte(`{"profiles":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := DefaultPath("")
	if err != nil {
		t.Fatal(err)
	}
	if p != filepath.Join(legacy, "profiles.json") {
		t.Fatalf("bak fallback: got %q", p)
	}
}

func TestDefaultPathNoDocumentAnywhere(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	p, err := DefaultPath("")
	if err != nil {
		t.Fatal(err)
	}
	if p != filepath.Join(dir, "config", "phi-client", "profiles.json") {
		t.Fatalf("fresh-host default: got %q", p)
	}
}
