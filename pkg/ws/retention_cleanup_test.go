package ws

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

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

// A closure records itself in the journal manifest without dropping
// committed bytes: the archived pane still replays everything.
func TestClosePaneRecordsClosureInManifest(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("seed")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	epoch := ph.EpochOf()
	closedAt := time.Now()
	h.clock = func() time.Time { return closedAt }
	h.ClosePane("p")
	ph.mu.Lock()
	flags, closedAtNs, head := ph.journal.flags, ph.journal.closedAtNs, ph.journal.head
	ph.mu.Unlock()
	if flags&rawFlagClosed == 0 {
		t.Fatal("the closure did not reach the manifest")
	}
	if closedAtNs != closedAt.UnixNano() {
		t.Fatalf("manifest closedAtNs = %d, want %d", closedAtNs, closedAt.UnixNano())
	}
	page, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: 0, Latest: true})
	if err != nil || string(page.Data) != "seed" {
		t.Fatalf("archived replay = %q %v", page.Data, err)
	}
	if head != 4 {
		t.Fatalf("manifest head = %d, want 4", head)
	}
}
