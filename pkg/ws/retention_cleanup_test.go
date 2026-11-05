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
// Closing a pane archives its RAM window: history stays replayable and
// the closure time is recorded for the expiry sweep. Nothing is written
// to disk.
func TestClosePaneRecordsClosureInManifest(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(64)
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
	closedAtNs := ph.closedAtUnixNano
	head := uint64(0)
	if ph.win != nil {
		head = ph.win.head
	}
	ph.mu.Unlock()
	if closedAtNs != closedAt.UnixNano() {
		t.Fatalf("closure time = %d, want %d", closedAtNs, closedAt.UnixNano())
	}
	page, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: 0, Latest: true})
	if err != nil || string(page.Data) != "seed" {
		t.Fatalf("archived replay = %q %v", page.Data, err)
	}
	if head != 4 {
		t.Fatalf("retained head = %d, want 4", head)
	}
	if _, err := os.Stat(filepath.Join(dir, "v3")); err != nil {
		t.Fatalf("recording namespace missing: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "v3"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "lease" {
			t.Fatalf("pane history wrote %q to disk", e.Name())
		}
	}
}
