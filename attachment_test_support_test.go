package main

import (
	"runtime"
	"testing"

	"github.com/hypernewbie/phi/internal/attachments"
	"github.com/hypernewbie/phi/pkg/pty"
)

// withAttachmentTestGlobals installs an isolated attachment store and pane
// registry for the bridge attachment routes.
func withAttachmentTestGlobals(t *testing.T) {
	t.Helper()
	oldStore, oldManager := attachments.Default, ptyManager
	store, err := attachments.OpenAttachmentStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	attachments.Default = store
	ptyManager = pty.NewManager()
	attachments.SetPaneManager(func() *pty.Manager { return ptyManager })
	t.Cleanup(func() {
		attachments.Default, ptyManager = oldStore, oldManager
		attachments.SetPaneManager(nil)
		_ = store.Close()
	})
}

// withTempHome points the home-directory lookups at a fresh temp dir.
func withTempHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	homeKey := "HOME"
	if runtime.GOOS == "windows" {
		homeKey = "USERPROFILE"
	}
	t.Setenv(homeKey, tmp)
	t.Setenv("HOME", tmp)
	return tmp
}
