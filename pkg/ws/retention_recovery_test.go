package ws

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestReadRetentionManifestIsBoundedAndRegular(t *testing.T) {
	dir := t.TempDir()
	if _, err := readRetentionManifest(filepath.Join(dir, "MANIFEST")); !os.IsNotExist(err) {
		t.Fatalf("missing manifest err = %v, want IsNotExist (fresh-group path)", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "grp"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := readRetentionManifest(filepath.Join(dir, "grp")); err == nil {
		t.Fatal("directory manifest should reject")
	}
	atCap := bytes.Repeat([]byte("m"), retentionManifestMax)
	if err := os.WriteFile(filepath.Join(dir, "MANIFEST"), atCap, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRetentionManifest(filepath.Join(dir, "MANIFEST")); err != nil {
		t.Fatalf("64KiB manifest read err = %v, want nil", err)
	}
	over := bytes.Repeat([]byte("m"), retentionManifestMax+1)
	if err := os.WriteFile(filepath.Join(dir, "MANIFEST"), over, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRetentionManifest(filepath.Join(dir, "MANIFEST")); err == nil {
		t.Fatal("oversized manifest should reject before decode")
	}
	if _, err := openRetentionGroup(dir); err == nil {
		t.Fatal("open with oversized manifest should fail")
	}
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privilege on windows")
	}
	if err := os.Symlink("MANIFEST", filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := readRetentionManifest(filepath.Join(dir, "link")); err == nil {
		t.Fatal("symlink manifest should reject")
	}
}
