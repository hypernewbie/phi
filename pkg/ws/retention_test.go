package ws

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/internal/termstate"
)

// These tests define the accepted retention policy before the storage
// change: the newest 1 MiB of raw history per terminal survives,
// older bytes are evicted, and disk use stays bounded.

// retentionTestSource builds deterministic output with line structure so
// suffix comparisons detect any dropped, duplicated, or reordered byte.
func retentionTestSource(t *testing.T, size int) []byte {
	t.Helper()
	out := make([]byte, 0, size)
	for seq := 0; len(out) < size; seq++ {
		line := []byte("retained history line with sequence and Unicode 你🙂\r\n")
		// Stamp the sequence into the line so every window is unique.
		stamped := append([]byte(nil), line...)
		for i := 0; i < 8; i++ {
			stamped[i] = byte(seq >> (8 * i))
		}
		out = append(out, stamped...)
	}
	return out[:size]
}

func ingestChunks(t *testing.T, h *Hub, pane string, source []byte, chunk int) {
	t.Helper()
	for start := 0; start < len(source); start += chunk {
		end := min(start+chunk, len(source))
		if err := h.Ingest(pane, source[start:end]); err != nil {
			t.Fatalf("ingest [%d,%d): %v", start, end, err)
		}
	}
}

func retentionFloor(t *testing.T, h *Hub, pane string) (uint64, uint64) {
	t.Helper()
	ph, ok := h.LookupPane(pane)
	if !ok {
		t.Fatalf("pane %s absent", pane)
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	pos := ph.positionLocked()
	return pos.Oldest, pos.Head
}

func TestParseRetentionSegFileRejectsShortNames(t *testing.T) {
	for _, name := range []string{".raw", ".rsz", ".ckpt", "", "s.raw", "s0000000000000001.log"} {
		if gen, ok := parseRetentionSegFile(name); ok {
			t.Fatalf("parseRetentionSegFile(%q) = (%d, true), want rejection", name, gen)
		}
	}
	gen, ok := parseRetentionSegFile("s0000000000000007.ckpt")
	if !ok || gen != 7 {
		t.Fatalf("parseRetentionSegFile(valid) = (%d, %v), want (7, true)", gen, ok)
	}
}

func TestRetentionKeepsNewest1MiBAcrossWraps(t *testing.T) {
	const capacity = 1 << 20
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, 2*capacity+600*1024)
	ingestChunks(t, h, "p", source, 32*1024)

	oldest, head := retentionFloor(t, h, "p")
	if head != uint64(len(source)) {
		t.Fatalf("head=%d want %d", head, len(source))
	}
	if oldest != head-capacity {
		t.Fatalf("oldest=%d want head-cap=%d", oldest, head-capacity)
	}
	want := source[len(source)-capacity:]
	rec, ok := h.Recording("p", oldest, head)
	if !ok || rec.Start != oldest || rec.End != head || !bytes.Equal(rec.Data, want) {
		t.Fatalf("retained window: ok=%t span=[%d,%d) bytes=%d want [%d,%d) exact newest 1 MiB",
			ok, rec.Start, rec.End, len(rec.Data), oldest, head)
	}
	// A request starting in evicted history clamps to the real floor and
	// reports the advanced start; it never fabricates the missing prefix.
	clamped, ok := h.Recording("p", 0, head)
	if !ok || clamped.Start != oldest || !bytes.Equal(clamped.Data, want) {
		t.Fatalf("evicted-prefix read: ok=%t start=%d bytes=%d want start=%d with newest 1 MiB",
			ok, clamped.Start, len(clamped.Data), oldest)
	}
}

func TestRetentionExactCapacityBoundary(t *testing.T) {
	const capacity = 1 << 20
	h := NewHub(0)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, capacity)
	ingestChunks(t, h, "p", source, 32*1024)
	if oldest, head := retentionFloor(t, h, "p"); oldest != 0 || head != capacity {
		t.Fatalf("exact capacity: oldest=%d head=%d want 0/%d", oldest, head, capacity)
	}
	rec, ok := h.Recording("p", 0, capacity)
	if !ok || !bytes.Equal(rec.Data, source) {
		t.Fatal("exact-capacity history was truncated")
	}
	if err := h.Ingest("p", []byte("Z")); err != nil {
		t.Fatal(err)
	}
	if oldest, head := retentionFloor(t, h, "p"); oldest != 1 || head != capacity+1 {
		t.Fatalf("capacity+1: oldest=%d head=%d want 1/%d", oldest, head, capacity+1)
	}
	rec, ok = h.Recording("p", 0, capacity+1)
	if !ok || rec.Start != 1 || !bytes.Equal(rec.Data, append(source[1:], 'Z')) {
		t.Fatalf("capacity+1 read: ok=%t start=%d bytes=%d", ok, rec.Start, len(rec.Data))
	}
}

func TestRetentionDirectPayloadsKeepCombinedSuffix(t *testing.T) {
	const capacity = 1 << 20
	for _, size := range []int{64 * 1024, capacity - 1, capacity + 1} {
		t.Run("", func(t *testing.T) {
			h := NewHub(0)
			if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
				t.Fatal(err)
			}
			prefix := retentionTestSource(t, capacity+4096)
			ingestChunks(t, h, "p", prefix, 32*1024)
			payload := retentionTestSource(t, size)
			// Make the payload distinguishable from the prefix window.
			for i := range payload {
				payload[i] ^= 0x5a
			}
			if err := h.Ingest("p", payload); err != nil {
				t.Fatal(err)
			}
			combined := append(append([]byte(nil), prefix...), payload...)
			head := uint64(len(combined))
			want := combined[len(combined)-capacity:]
			oldest, gotHead := retentionFloor(t, h, "p")
			if gotHead != head || oldest != head-capacity {
				t.Fatalf("size %d: oldest=%d head=%d want %d/%d", size, oldest, gotHead, head-capacity, head)
			}
			rec, ok := h.Recording("p", oldest, head)
			if !ok || !bytes.Equal(rec.Data, want) {
				t.Fatalf("size %d: ok=%t bytes=%d want exact newest 1 MiB of prefix+payload", size, ok, len(rec.Data))
			}
		})
	}
}

func TestRetentionOneByteBatchesDoNotEvictEarly(t *testing.T) {
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	source := retentionTestSource(t, 2048)
	ingestChunks(t, h, "p", source, 1)
	if oldest, head := retentionFloor(t, h, "p"); oldest != 0 || head != uint64(len(source)) {
		t.Fatalf("one-byte batches evicted early: oldest=%d head=%d", oldest, head)
	}
	rec, ok := h.Recording("p", 0, uint64(len(source)))
	if !ok || !bytes.Equal(rec.Data, source) {
		t.Fatal("one-byte batches lost bytes")
	}
}

func TestRetentionBoundsDiskUsage(t *testing.T) {
	const steadyMax = 6.25 * 1024 * 1024
	h := NewHub(4096)
	dir := t.TempDir()
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, 8<<20)
	ingestChunks(t, h, "p", source, 64*1024)
	var total int64
	var files int
	if err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files++
		total += info.Size()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if total > int64(steadyMax) {
		t.Fatalf("group files use %d bytes across %d files, want at most %.0f", total, files, steadyMax)
	}
	if oldest, head := retentionFloor(t, h, "p"); oldest != head-(1<<20) {
		t.Fatalf("floor=%d head=%d after 8 MiB", oldest, head)
	}
}

func TestRetentionBaseCheckpointsStayBounded(t *testing.T) {
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	dir := t.TempDir()
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, 3.5*1024*1024)
	ingestChunks(t, h, "p", source, 64*1024)
	ph, _ := h.LookupPane("p")
	ph.mu.Lock()
	segs := len(ph.recording.segs)
	unbased := 0
	for _, s := range ph.recording.segs {
		if s.ckptLen == 0 {
			unbased++
		}
	}
	ph.mu.Unlock()
	if segs > 2 {
		t.Fatalf("retained segments=%d", segs)
	}
	if unbased != 0 {
		t.Fatalf("segments without a base checkpoint=%d", unbased)
	}
	var ckpts int
	if err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && len(path) >= 5 && path[len(path)-5:] == ".ckpt" {
			ckpts++
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if ckpts > 2 {
		t.Fatalf("checkpoint files=%d", ckpts)
	}
}

func TestRetentionNearFullSegmentRotatesBeforeBreachingRawMax(t *testing.T) {
	dir := t.TempDir()
	first := NewHub(0)
	if err := first.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	fill := bytes.Repeat([]byte("f"), retentionSegNominal-1)
	if err := first.Ingest("p", fill); err != nil {
		t.Fatal(err)
	}
	tail := bytes.Repeat([]byte("t"), 64<<10)
	if err := first.Ingest("p", tail); err != nil {
		t.Fatal(err)
	}
	ph, _ := first.LookupPane("p")
	if n := len(ph.recording.segs); n != 2 {
		t.Fatalf("segments = %d, want 2 (rotation before breach)", n)
	}
	head := uint64(retentionSegNominal - 1 + 64<<10)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second := NewHub(0)
	t.Cleanup(func() { _ = second.Close() })
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	source := append(append([]byte{}, fill...), tail...)
	floor := head - (1 << 20)
	rec, ok := second.Recording("p", 0, head)
	if !ok || rec.Start != floor || !bytes.Equal(rec.Data, source[floor:]) {
		t.Fatal("reopen lost the retained suffix after near-full rotation")
	}
}

func TestRetentionRestartPreservesSuffixScreenAndPermissions(t *testing.T) {
	const capacity = 1 << 20
	dir := t.TempDir()
	first := NewHub(4096)
	if err := first.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, 2*capacity+12345)
	ingestChunks(t, first, "p", source, 32*1024)
	oldPos, oldState, _, _, err := first.State("p")
	if err != nil {
		t.Fatal(err)
	}
	render := func(data []byte) ([]byte, []byte) {
		e, err := termstate.New(t.Context(), 80, 24)
		if err != nil {
			t.Fatal(err)
		}
		defer e.Close()
		if err = e.Restore(data); err != nil {
			t.Fatal(err)
		}
		screen, err := e.FormatVTState()
		if err != nil {
			t.Fatal(err)
		}
		continuation, err := e.Continuation()
		if err != nil {
			t.Fatal(err)
		}
		return screen, continuation
	}
	oldScreen, oldContinuation := render(oldState)
	// A restart closes the first owner before the second opens the group.
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second := NewHub(4096)
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	ph, ok := second.LookupPane("p")
	if ok {
		t.Fatalf("restart published pane %v without demand", ph)
	}
	newPos, newState, _, _, err := second.State("p")
	if err != nil {
		t.Fatal(err)
	}
	if newPos.Head != oldPos.Head || newPos.Oldest != oldPos.Head-capacity {
		t.Fatalf("restart position oldest=%d head=%d want %d/%d",
			newPos.Oldest, newPos.Head, oldPos.Head-capacity, oldPos.Head)
	}
	newScreen, newContinuation := render(newState)
	if !bytes.Equal(oldScreen, newScreen) || !bytes.Equal(oldContinuation, newContinuation) {
		t.Fatal("restart changed the visible screen or parser continuation")
	}
	want := source[len(source)-capacity:]
	rec, ok := second.Recording("p", newPos.Oldest, newPos.Head)
	if !ok || !bytes.Equal(rec.Data, want) {
		t.Fatal("restart lost the retained suffix")
	}
	if err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().Perm()&0077 != 0 {
			t.Fatalf("%s is readable by another user: %o", path, info.Mode().Perm())
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
