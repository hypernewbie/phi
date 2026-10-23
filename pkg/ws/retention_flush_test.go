package ws

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// manifestHead reads the committed head from the group's manifest. A group
// that never flushed has no manifest yet, which is head zero.
func manifestHead(t *testing.T, dir string) uint64 {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "v2", manifestDirFor(t, dir), "MANIFEST"))
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	m, err := decodeRetentionManifest(raw)
	if err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	return m.head
}

// manifestDirFor returns the single group directory under the recording root.
func manifestDirFor(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "v2"))
	if err != nil {
		t.Fatalf("read groups: %v", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			return e.Name()
		}
	}
	t.Fatal("no retention group")
	return ""
}

// A commit that stays under the flush threshold must not rewrite the
// manifest: the manifest rewrite (create, write, sync, rename, directory
// sync) cost 8 ms per chunk and throttled the pane to a fraction of the
// speed the terminal produced output.
func TestRetentionCommitsDoNotRewriteTheManifestPerChunk(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("x"), 32*1024)
	// Well under the flush threshold: the manifest must not move.
	for i := 0; i < 4; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	if got := manifestHead(t, dir); got != 0 {
		t.Fatalf("manifest head moved to %d before the flush threshold", got)
	}
	// The bytes are readable even though they are not durable yet: the
	// client reads the live file, not the manifest.
	rec, ok := h.Recording("p", 0, 4*32*1024)
	if !ok || len(rec.Data) != 4*32*1024 {
		t.Fatalf("unflushed bytes are not readable: ok=%t len=%d", ok, len(rec.Data))
	}
	// Crossing the threshold makes the group durable.
	for i := 0; i < 8; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	if got := manifestHead(t, dir); got == 0 {
		t.Fatal("the manifest did not advance past the flush threshold")
	}
}

// The manifest names the last durable point. A crash therefore loses the
// tail since that point, and the group must reopen at the manifest's head,
// not at the longer file.
func TestRetentionReopenTruncatesToTheDurableHead(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("y"), 32*1024)
	for i := 0; i < 4; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	// Reopen the group the way a restart does, without the first hub
	// closing it: the tail stays in the page cache, exactly like a crash.
	group, err := openRetentionGroup(filepath.Join(dir, "v2", manifestDirFor(t, dir)))
	if err != nil {
		t.Fatalf("reopen group: %v", err)
	}
	t.Cleanup(func() { _ = group.close() })
	if group.head != 0 {
		t.Fatalf("the group reopened at head %d, past the durable head", group.head)
	}
	data, _, err := group.read(0, 4*32*1024)
	if err == nil && len(data) != 0 {
		t.Fatalf("the group reopened with %d bytes past the durable head", len(data))
	}
}

// A clean close makes the admitted tail durable, so a restart keeps the
// history a reader can page.
func TestRetentionCloseMakesTheTailDurable(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("z"), 32*1024)
	for i := 0; i < 4; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	second := NewHub(0)
	t.Cleanup(func() { _ = second.Close() })
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	rec, ok := second.Recording("p", 0, 4*32*1024)
	if !ok || len(rec.Data) != 4*32*1024 {
		t.Fatalf("the tail was not durable after a clean close: ok=%t len=%d", ok, len(rec.Data))
	}
}

func TestRetentionCloseReportsFlushFailureAndReleasesFiles(t *testing.T) {
	for _, stage := range []struct {
		name string
		set  func(*retentionFaults, error)
	}{
		{"raw", func(f *retentionFaults, err error) { f.rawSync = err }},
		{"resize", func(f *retentionFaults, err error) { f.rszSync = err }},
		{"manifest", func(f *retentionFaults, err error) { f.manifestSync = err }},
		{"rename", func(f *retentionFaults, err error) { f.rename = err }},
		{"directory", func(f *retentionFaults, err error) { f.dirSync = err }},
	} {
		t.Run(stage.name, func(t *testing.T) {
			dir := t.TempDir()
			h := NewHub(0)
			defer h.Close()
			if err := h.SetRecordingDirectory(dir); err != nil {
				t.Fatal(err)
			}
			if err := h.Ingest("p", []byte("tail below the flush threshold\r\n")); err != nil {
				t.Fatal(err)
			}
			h.RecordResize("p", 80, 24)
			ph, _ := h.LookupPane("p")
			g := ph.recording
			want := errors.New("injected final flush failure")
			stage.set(&g.faults, want)
			if err := h.Close(); !errors.Is(err, want) {
				t.Fatalf("close error = %v, want %v", err, want)
			}
			if !g.closed || h.leaseFile != nil {
				t.Fatal("failed flush retained group ownership")
			}
			for _, s := range g.segs {
				if s.raw != nil || s.rsz != nil {
					t.Fatal("failed flush retained a file handle")
				}
			}
			reopened, err := openRetentionGroup(g.dir)
			if err != nil {
				t.Fatalf("reopen after failed flush: %v", err)
			}
			defer reopened.close()
			if _, _, err := reopened.read(reopened.floor(), reopened.head); err != nil {
				t.Fatalf("committed history is unreadable after failed flush: %v", err)
			}
		})
	}
}

// The rotation always flushes: it evicts a segment, and the manifest must
// stop naming that segment before its files are deleted.
func TestRetentionRotationFlushesEvenUnderTheThreshold(t *testing.T) {
	// Only a rotation may flush here, so the manifest moving proves the
	// rotation flushed it.
	old := retentionFlushBytes
	retentionFlushBytes = 1 << 30
	t.Cleanup(func() { retentionFlushBytes = old })

	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	// A resize leaves a dirty resize journal that only a flush makes
	// durable.
	h.RecordResize("p", 80, 24)
	// One full segment plus a little: the rotation happens at 1 MiB.
	chunk := bytes.Repeat([]byte("q"), 64*1024)
	for i := 0; i < 17; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	if got := manifestHead(t, dir); got == 0 {
		t.Fatal("the rotation did not make the group durable")
	}
}

// The rotation's manifest names the older segment's bytes. A commit that
// did not flush left them in the page cache, so the rotation has to sync
// them: a manifest that names bytes the disk does not have makes the group
// fail closed on reopen ("committed retention bytes are missing"), and
// nothing recreates it.
func TestRetentionRotationSyncsTheOlderSegments(t *testing.T) {
	old := retentionFlushBytes
	retentionFlushBytes = 1 << 30
	t.Cleanup(func() { retentionFlushBytes = old })

	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", bytes.Repeat([]byte("w"), 4096)); err != nil {
		t.Fatal(err)
	}
	// A resize gives the first segment a resize journal, so the flush has
	// to sync that journal too.
	h.RecordResize("p", 80, 24)
	ph, _ := h.LookupPane("p")
	// Grow the first segment to just below the rotation point, with no
	// flush: its tail is in the page cache only.
	chunk := bytes.Repeat([]byte("x"), 64*1024)
	for {
		ph.mu.Lock()
		g := ph.recording
		rawLen := uint64(0)
		if g != nil && len(g.segs) > 0 {
			rawLen = g.segs[len(g.segs)-1].rawLen
		}
		ph.mu.Unlock()
		if rawLen+uint64(len(chunk)) > retentionSegRawMax {
			break
		}
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	// The next ingest rotates, and the rotation flushes.
	ph.mu.Lock()
	g := ph.recording
	g.faults.rawSyncs = 0
	g.faults.rszSyncs = 0
	ph.mu.Unlock()
	if err := h.Ingest("p", chunk); err != nil {
		t.Fatal(err)
	}
	ph.mu.Lock()
	raw, rsz := g.faults.rawSyncs, g.faults.rszSyncs
	ph.mu.Unlock()
	if raw < 2 || rsz < 2 {
		t.Fatalf("the rotation synced %d raw and %d resize files, want both segments",
			raw, rsz)
	}
}
