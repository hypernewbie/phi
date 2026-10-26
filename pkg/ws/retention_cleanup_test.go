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

func TestFailedRetentionOpenPreservesCommittedManifest(t *testing.T) {
	for _, missing := range []int{0, 1} {
		t.Run(fmt.Sprintf("segment-%d", missing), func(t *testing.T) {
			dir := t.TempDir()
			g, err := openRetentionGroup(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer g.close()
			for i := 0; i < int(retentionSegNominal/(64<<10))+2; i++ {
				if _, err := g.appendPayload(bytes.Repeat([]byte("x"), 64<<10), nil); err != nil {
					t.Fatal(err)
				}
			}
			if err := g.close(); err != nil {
				t.Fatal(err)
			}
			if len(g.segs) != 2 {
				t.Fatalf("got %d segments, want 2", len(g.segs))
			}
			manifest := filepath.Join(dir, "MANIFEST")
			before, err := os.ReadFile(manifest)
			if err != nil {
				t.Fatal(err)
			}
			raw := filepath.Join(dir, retentionSegBase(g.segs[missing].gen)+".raw")
			if err := os.Rename(raw, raw+".held"); err != nil {
				t.Fatal(err)
			}
			failed, openErr := openRetentionGroup(dir)
			if failed != nil {
				_ = failed.close()
			}
			if err := os.Rename(raw+".held", raw); err != nil {
				t.Fatal(err)
			}
			if openErr == nil {
				t.Fatal("opened a group with a missing committed dependency")
			}
			after, err := os.ReadFile(manifest)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Fatal("failed open rewrote the committed manifest")
			}
			reopened, err := openRetentionGroup(dir)
			if err != nil {
				t.Fatalf("reopen after restoring dependency: %v", err)
			}
			defer reopened.close()
			data, _, err := reopened.read(reopened.floor(), reopened.head)
			if err != nil || !bytes.Equal(data, bytes.Repeat([]byte("x"), int(retentionHistoryCap))) {
				t.Fatalf("restored history differs: bytes=%d err=%v", len(data), err)
			}
		})
	}
}

// A closure that lands while a transaction is pending must still reach the
// manifest. The pending manifest is already on disk, so the closure
// finishes that transaction instead of being dropped.
func TestClosePaneCompletesPendingRecordingBeforeArchiving(t *testing.T) {
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
	closedAt := time.Now()
	h.clock = func() time.Time { return closedAt }
	h.ClosePane("p")
	if ph.total != g.head {
		t.Fatalf("archive head = %d, want completed recording head %d", ph.total, g.head)
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
	if m.closedAtNs != closedAt.UnixNano() {
		t.Fatalf("manifest closedAtNs = %d, want %d", m.closedAtNs, closedAt.UnixNano())
	}
	// The manifest names the bytes the group holds: the closure did not
	// drop the staged payload.
	if m.head != g.head {
		t.Fatalf("manifest head = %d, want %d", m.head, g.head)
	}
	recorded, ok := h.Recording("p", 0, g.head)
	if !ok {
		t.Fatal("archived recording unavailable")
	}
	if !bytes.Equal(recorded.Data, append([]byte("seed"), payload...)) {
		t.Fatal("the recorded bytes lost the staged payload")
	}
}
