package ws

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// tailState reports the current segment's admitted sizes, its dirty flag,
// and the on-disk sizes of its files.
func tailState(t *testing.T, g *retentionGroup) (rawLen uint64, rszCount uint64, dirty bool, rawSize, rszSize int64) {
	t.Helper()
	cur := &g.segs[len(g.segs)-1]
	base := filepath.Join(g.dir, retentionSegBase(cur.gen))
	rawInfo, err := os.Stat(base + ".raw")
	if err != nil {
		t.Fatalf("stat raw segment: %v", err)
	}
	rawSize = rawInfo.Size()
	if info, err := os.Stat(base + ".rsz"); err == nil {
		rszSize = info.Size()
	} else if !os.IsNotExist(err) {
		t.Fatalf("stat resize segment: %v", err)
	}
	return cur.rawLen, uint64(cur.rszCount), cur.dirty, rawSize, rszSize
}

// A clean tail needs no repair. Truncating two files per streamed chunk was
// the measured cost; this pins the common path to zero repairs.
func TestRetentionCleanCommitsSkipTailRepair(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("clean "), 512)
	for i := 0; i < 4; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatalf("batched ingest %d: %v", i, err)
		}
		h.RecordResize("p", uint16(80+i), 24)
	}
	ph, ok := h.LookupPane("p")
	if !ok {
		t.Fatal("pane missing after the first ingest")
	}
	g := ph.recording
	// Crossing the flush threshold makes the group durable without a repair.
	for i := 0; i < int(retentionFlushBytes/uint64(len(chunk)))+2; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatalf("durable ingest %d: %v", i, err)
		}
	}
	if g.faults.truncates != 0 {
		t.Fatalf("clean commits repaired the tail %d times", g.faults.truncates)
	}
	want := uint64(int(retentionFlushBytes/uint64(len(chunk)))+2+4) * uint64(len(chunk))
	rawLen, _, dirty, rawSize, _ := tailState(t, g)
	if dirty {
		t.Fatal("clean commits left the tail marked dirty")
	}
	if rawLen != want || rawSize != int64(want) {
		t.Fatalf("admitted=%d rawfile=%d want=%d", rawLen, rawSize, want)
	}
	if rec, ok := h.Recording("p", 0, want); !ok || uint64(len(rec.Data)) != want {
		t.Fatalf("retained history unreadable: ok=%t len=%d want=%d", ok, len(rec.Data), want)
	}
}

// A failed commit leaves bytes past the admitted end. The next commit must
// remove them, so a shorter payload cannot expose the failed suffix.
func TestRetentionFailedCommitRepairsTailOnce(t *testing.T) {
	perCommitDurability(t)
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

	injected := errors.New("injected raw sync failure")
	g.faults.rawSync = injected
	if err := h.Ingest("p", []byte("0123456789abcdef")); !errors.Is(err, injected) {
		t.Fatalf("failed ingest error = %v, want %v", err, injected)
	}
	rawLen, _, dirty, rawSize, _ := tailState(t, g)
	if !dirty {
		t.Fatal("failed write did not mark the tail dirty")
	}
	if rawLen != 4 || rawSize != 20 {
		t.Fatalf("after failure admitted=%d rawfile=%d want 4/20", rawLen, rawSize)
	}

	// A shorter retry must repair the tail first, not append after it.
	if err := h.Ingest("p", []byte("next")); err != nil {
		t.Fatalf("retry after repair: %v", err)
	}
	rawLen, _, dirty, rawSize, _ = tailState(t, g)
	if dirty {
		t.Fatal("tail still marked dirty after a successful commit")
	}
	if rawLen != 8 || rawSize != 8 {
		t.Fatalf("after repair admitted=%d rawfile=%d want 8/8", rawLen, rawSize)
	}
	if g.faults.truncates != 1 {
		t.Fatalf("repairs = %d, want exactly 1", g.faults.truncates)
	}
	if rec, ok := h.Recording("p", 0, 8); !ok || !bytes.Equal(rec.Data, []byte("seednext")) {
		t.Fatalf("retained bytes = %q ok=%t, want %q", rec.Data, ok, "seednext")
	}
}

// A resize-only failure leaves a resize journal record past rszCount. Output
// admission retries it, so the repair must run before the retried record.
func TestRetentionResizeFailureRepairsJournal(t *testing.T) {
	perCommitDurability(t)
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	h.RecordResize("p", 80, 24)
	if err := h.Ingest("p", []byte("before")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	g := ph.recording
	g.faults.rszSync = errors.New("injected resize sync failure")
	h.RecordResize("p", 100, 40)
	if ph.pendingResize == nil {
		t.Fatal("failed resize was not retained for retry")
	}
	if _, _, dirty, _, rszSize := tailState(t, g); !dirty || rszSize != 2*retentionRszRecLen {
		t.Fatalf("after resize failure dirty=%t rszfile=%d want true/%d", dirty, rszSize, 2*retentionRszRecLen)
	}

	if err := h.Ingest("p", []byte("after")); err != nil {
		t.Fatalf("retry after resize failure: %v", err)
	}
	_, rszCount, dirty, _, rszSize := tailState(t, g)
	if dirty {
		t.Fatal("resize repair left the tail dirty")
	}
	if rszSize != int64(rszCount)*retentionRszRecLen {
		t.Fatalf("rszfile=%d want rszCount %d * %d", rszSize, rszCount, retentionRszRecLen)
	}
	_, _, markers := readRetained(t, h, "p", 0, g.head)
	if len(markers) != 2 || markers[0].Cols != 80 || markers[0].Rows != 24 || markers[1].Cols != 100 || markers[1].Rows != 40 {
		t.Fatalf("resize markers = %+v, want 80x24 then 100x40", markers)
	}
	if rec, ok := h.Recording("p", 0, g.head); !ok || !bytes.Equal(rec.Data, []byte("beforeafter")) {
		t.Fatalf("retained bytes = %q ok=%t", rec.Data, ok)
	}
}

// A repair that fails must keep the tail marked dirty, so the next commit
// tries again instead of appending after unknown bytes.
func TestRetentionFailedRepairKeepsTailDirty(t *testing.T) {
	perCommitDurability(t)
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	h.RecordResize("p", 80, 24)
	if err := h.Ingest("p", []byte("seed")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	g := ph.recording
	g.faults.rawSync = errors.New("injected raw sync failure")
	if err := h.Ingest("p", []byte("0123456789abcdef")); err == nil {
		t.Fatal("faulted ingest was admitted")
	}

	// Let the raw repair succeed, then fail the resize repair. Clearing
	// dirty after only the first truncation would admit an unrepaired tail.
	cur := &g.segs[len(g.segs)-1]
	base := filepath.Join(g.dir, retentionSegBase(cur.gen))
	closed := cur.rsz
	if err := closed.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("x")); err == nil {
		t.Fatal("commit with an unusable resize descriptor was admitted")
	}
	if _, _, dirty, rawSize, _ := tailState(t, g); !dirty || rawSize != 4 {
		t.Fatalf("partial repair dirty=%t rawfile=%d, want true/4", dirty, rawSize)
	}

	reopened, err := os.OpenFile(base+".rsz", os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("reopen resize segment: %v", err)
	}
	cur.rsz = reopened
	if err := h.Ingest("p", []byte("next")); err != nil {
		t.Fatalf("retry after restored descriptor: %v", err)
	}
	rawLen, _, dirty, rawSize, _ := tailState(t, g)
	if dirty || rawLen != 8 || rawSize != 8 {
		t.Fatalf("after recovery dirty=%t admitted=%d rawfile=%d want false/8/8", dirty, rawLen, rawSize)
	}
	if rec, ok := h.Recording("p", 0, 8); !ok || !bytes.Equal(rec.Data, []byte("seednext")) {
		t.Fatalf("retained bytes = %q ok=%t", rec.Data, ok)
	}
}

// A write that fails must leave the tail dirty. The flag is set before the
// write for exactly this case.
func TestRetentionFailedWriteStillMarksDirty(t *testing.T) {
	perCommitDurability(t)
	for _, test := range []struct {
		name   string
		break_ func(t *testing.T, g *retentionGroup, ph *PaneHub)
		commit func(h *Hub) error
	}{
		{
			name: "raw",
			break_: func(t *testing.T, g *retentionGroup, ph *PaneHub) {
				t.Helper()
				cur := &g.segs[len(g.segs)-1]
				if cur.raw == nil {
					t.Fatal("raw descriptor absent")
				}
				if err := cur.raw.Close(); err != nil {
					t.Fatal(err)
				}
			},
			commit: func(h *Hub) error { return h.Ingest("p", []byte("payload")) },
		},
		{
			name: "resize",
			break_: func(t *testing.T, g *retentionGroup, ph *PaneHub) {
				t.Helper()
				cur := &g.segs[len(g.segs)-1]
				if cur.rsz == nil {
					t.Fatal("resize descriptor absent")
				}
				if err := cur.rsz.Close(); err != nil {
					t.Fatal(err)
				}
			},
			commit: func(h *Hub) error {
				h.RecordResize("p", 100, 40)
				ph, _ := h.LookupPane("p")
				if ph.pendingResize != nil {
					return errors.New("resize was not admitted")
				}
				return nil
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			h := NewHub(0)
			t.Cleanup(func() { _ = h.Close() })
			if err := h.SetRecordingDirectory(dir); err != nil {
				t.Fatal(err)
			}
			h.RecordResize("p", 80, 24)
			if err := h.Ingest("p", []byte("seed")); err != nil {
				t.Fatal(err)
			}
			ph, _ := h.LookupPane("p")
			g := ph.recording
			if _, _, dirty, _, _ := tailState(t, g); dirty {
				t.Fatal("seed commit left the tail dirty")
			}

			test.break_(t, g, ph)
			if err := test.commit(h); err == nil {
				t.Fatal("commit with an unusable descriptor was admitted")
			}
			if _, _, dirty, _, _ := tailState(t, g); !dirty {
				t.Fatal("failed write did not mark the tail dirty")
			}
			if g.faults.truncates != 0 {
				t.Fatalf("clean entry repair ran %d times", g.faults.truncates)
			}
		})
	}
}

// Rotation starts a clean segment, and one pane's failure must not force a
// repair in another pane's group.
func TestRetentionRotationAndGroupIsolationSkipRepair(t *testing.T) {
	old := retentionFlushBytes
	retentionFlushBytes = 1 << 30
	t.Cleanup(func() { retentionFlushBytes = old })

	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	// A full segment forces a rotation; the new current segment starts clean.
	chunk := bytes.Repeat([]byte("q"), 64*1024)
	for i := 0; i < int(retentionSegNominal)/len(chunk)+1; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	ph, _ := h.LookupPane("p")
	g := ph.recording
	if len(g.segs) < 2 {
		t.Fatalf("no rotation happened: %d segments", len(g.segs))
	}
	if _, _, dirty, _, _ := tailState(t, g); dirty {
		t.Fatal("the segment created by rotation is dirty")
	}

	// The sync fault only fires on a durable commit, so drop the batching
	// threshold before failing one pane's tail and streaming another.
	retentionFlushBytes = 0
	if err := h.Ingest("b", []byte("seed")); err != nil {
		t.Fatal(err)
	}
	bh, _ := h.LookupPane("b")
	g.faults.rawSync = fmt.Errorf("injected raw sync failure")
	if err := h.Ingest("p", []byte("tail")); err == nil {
		t.Fatal("faulted pane admitted output")
	}
	if _, _, dirty, _, _ := tailState(t, g); !dirty {
		t.Fatal("faulted pane's tail is not dirty")
	}
	for i := 0; i < 4; i++ {
		if err := h.Ingest("b", []byte("quiet")); err != nil {
			t.Fatalf("unrelated pane ingest %d: %v", i, err)
		}
	}
	bg := bh.recording
	if bg.faults.truncates != 0 {
		t.Fatalf("unrelated pane repaired its tail %d times", bg.faults.truncates)
	}
	if bg.segs[len(bg.segs)-1].dirty {
		t.Fatal("unrelated pane's tail is dirty")
	}
}
