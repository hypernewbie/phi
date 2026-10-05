//go:build unix

package ws

import (
	"os"
	"path/filepath"
	"testing"
)

// POSIX mode bits do not express Windows ACL privacy. Keep these assertions
// on Unix and add a separate ACL-specific contract if Windows coverage is
// required.
func TestAdversarialRecordingPermissionsOnExistingStorage(t *testing.T) {
	t.Run("existing directory", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Chmod(dir, 0777); err != nil {
			t.Fatal(err)
		}
		h := NewHub(8)
		err := h.SetRecordingDirectory(dir)
		if err == nil {
			info, err := os.Stat(dir)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm()&0077 != 0 {
				t.Fatal("private recordings accepted a world-accessible directory")
			}
		}
	})
	t.Run("existing file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "recording")
		r, err := openRecording(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = r.file.Close() })
		if err = r.append(1, []byte("private terminal secret")); err != nil {
			t.Fatal(err)
		}
		if err = os.Chmod(path, 0666); err != nil {
			t.Fatal(err)
		}
		reopened, err := openRecording(path)
		if err == nil {
			t.Cleanup(func() { _ = reopened.file.Close() })
			info, err := reopened.file.Stat()
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm()&0077 != 0 {
				t.Fatal("reopening retained secret output kept world-readable permissions")
			}
		}
	})
}
