package server

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
	oldStore, oldManager := testServer.attachmentStore, testServer.pty
	store, err := attachments.OpenAttachmentStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	testServer.attachmentStore = store
	testServer.pty = pty.NewManager()
	testServer.attachmentAPI.Store = store
	t.Cleanup(func() {
		testServer.attachmentStore, testServer.pty = oldStore, oldManager
		testServer.attachmentAPI.Store = oldStore
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
