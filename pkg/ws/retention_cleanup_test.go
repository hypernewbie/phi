package ws

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// An ephemeral group has no crash-recovery path: nothing reads its
// manifest, so writing one per flush is pure overhead.
func TestEphemeralGroupWritesNoManifest(t *testing.T) {
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	// No recording directory: the group lands in a temporary one.
	if err := h.Ingest("p", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	g := ph.recording
	if !g.ephemeral {
		t.Fatal("the group is not ephemeral")
	}
	if _, err := os.Stat(filepath.Join(g.dir, "MANIFEST")); !os.IsNotExist(err) {
		t.Fatalf("the ephemeral group wrote a manifest: %v", err)
	}
	// The bytes are still there: only the manifest is skipped.
	data, _, err := g.read(0, 5)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, []byte("hello")) {
		t.Fatalf("recorded bytes = %q, want %q", data, "hello")
	}
}

// A closure that lands while a transaction is pending must still reach the
// manifest. The pending manifest is already on disk, so the closure
// finishes that transaction instead of being dropped.
func TestMarkClosedReachesTheManifestAfterAPendingTransaction(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("seed")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	g := ph.recording
	// A directory sync failure leaves the manifest on disk without its
	// directory entry, so the commit stays pending. The payload has to
	// reach the flush threshold for the commit to sync the directory.
	payload := bytes.Repeat([]byte("x"), 512*1024)
	g.faults.dirSync = fmt.Errorf("injected dirSync failure")
	if err := h.Ingest("p", payload); err == nil {
		t.Fatal("the dirSync fault admitted bytes")
	}
	if g.pending == nil {
		t.Fatal("the failed commit left no pending transaction")
	}
	closedAt := time.Now().UnixNano()
	if err := g.markClosed(closedAt); err != nil {
		t.Fatalf("markClosed err = %v", err)
	}
	if g.pending != nil {
		t.Fatal("the pending transaction outlived the closure")
	}
	raw, err := readRetentionManifest(filepath.Join(g.dir, "MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := decodeRetentionManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if m.flags&retentionFlagClosed == 0 {
		t.Fatal("the closure did not reach the manifest")
	}
	if m.closedAtNs != closedAt {
		t.Fatalf("manifest closedAtNs = %d, want %d", m.closedAtNs, closedAt)
	}
	// The manifest names the bytes the group holds: the closure did not
	// drop the staged payload.
	if m.head != g.head {
		t.Fatalf("manifest head = %d, want %d", m.head, g.head)
	}
	data, _, err := g.read(0, g.head)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, append([]byte("seed"), payload...)) {
		t.Fatal("the recorded bytes lost the staged payload")
	}
}
