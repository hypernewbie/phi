package ws

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/internal/termstate"
)

// These tests define the accepted retention policy before the storage
// change: the newest retentionHistoryCap of raw history per terminal
// survives, older bytes are evicted, and disk use stays bounded.

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

// readRetained pages a window the way a client does: every response is
// bounded by the server's per-read cap, so a full-cap window takes several
// requests. It fails on a hole rather than returning short data.
func readRetained(t *testing.T, h *Hub, pane string, from, end uint64) (uint64, []byte, []ResizeMarker) {
	t.Helper()
	var out []byte
	var markers []ResizeMarker
	start := from
	for cursor := from; cursor < end; {
		rec, ok := h.Recording(pane, cursor, end)
		if !ok {
			t.Fatalf("retained page [%d,%d) refused", cursor, end)
		}
		// A first page may advance the start when the request began below
		// the floor; every later page must continue exactly where the last
		// one stopped.
		if cursor == from {
			start = rec.Start
		} else if rec.Start != cursor {
			t.Fatalf("retained page [%d,%d) answered [%d,%d)", cursor, end, rec.Start, rec.End)
		}
		if rec.End == rec.Start {
			// The server clamps a cursor at the head to an empty page
			// there; the window is complete.
			break
		}
		out = append(out, rec.Data...)
		for _, marker := range rec.Resizes {
			// A page restates the marker in force at its start; keep it once.
			if len(markers) > 0 && markers[len(markers)-1] == marker {
				continue
			}
			markers = append(markers, marker)
		}
		cursor = rec.End
	}
	return start, out, markers
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

func TestRetentionKeepsNewestCapAcrossWraps(t *testing.T) {
	capacity := uint64(retentionHistoryCap)
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, int(2*capacity+600*1024))
	ingestChunks(t, h, "p", source, 32*1024)

	oldest, head := retentionFloor(t, h, "p")
	if head != uint64(len(source)) {
		t.Fatalf("head=%d want %d", head, len(source))
	}
	if oldest != head-capacity {
		t.Fatalf("oldest=%d want head-cap=%d", oldest, head-capacity)
	}
	want := source[len(source)-int(capacity):]
	start, data, _ := readRetained(t, h, "p", oldest, head)
	if start != oldest || !bytes.Equal(data, want) {
		t.Fatalf("retained window: start=%d bytes=%d want start=%d %d bytes", start, len(data), oldest, len(want))
	}
	// A request starting in evicted history clamps to the real floor and
	// reports the advanced start; it never fabricates the missing prefix.
	clampedStart, clamped, _ := readRetained(t, h, "p", 0, head)
	if clampedStart != oldest || !bytes.Equal(clamped, want) {
		t.Fatalf("evicted-prefix read: start=%d bytes=%d want start=%d with newest cap",
			clampedStart, len(clamped), oldest)
	}
}

func TestRetentionExactCapacityBoundary(t *testing.T) {
	capacity := uint64(retentionHistoryCap)
	h := NewHub(0)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, int(capacity))
	ingestChunks(t, h, "p", source, 32*1024)
	if oldest, head := retentionFloor(t, h, "p"); oldest != 0 || head != capacity {
		t.Fatalf("exact capacity: oldest=%d head=%d want 0/%d", oldest, head, capacity)
	}
	if start, data, _ := readRetained(t, h, "p", 0, capacity); start != 0 || !bytes.Equal(data, source) {
		t.Fatal("exact-capacity history was truncated")
	}
	if err := h.Ingest("p", []byte("Z")); err != nil {
		t.Fatal(err)
	}
	if oldest, head := retentionFloor(t, h, "p"); oldest != 1 || head != capacity+1 {
		t.Fatalf("capacity+1: oldest=%d head=%d want 1/%d", oldest, head, capacity+1)
	}
	if start, data, _ := readRetained(t, h, "p", 0, capacity+1); start != 1 || !bytes.Equal(data, append(source[1:], 'Z')) {
		t.Fatalf("capacity+1 read: start=%d bytes=%d", start, len(data))
	}
}

func TestRetentionDirectPayloadsKeepCombinedSuffix(t *testing.T) {
	capacity := uint64(retentionHistoryCap)
	for _, size := range []int{64 * 1024, int(capacity) - 1, int(capacity) + 1} {
		t.Run("", func(t *testing.T) {
			h := NewHub(0)
			if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
				t.Fatal(err)
			}
			prefix := retentionTestSource(t, int(capacity)+4096)
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
			want := combined[len(combined)-int(capacity):]
			oldest, gotHead := retentionFloor(t, h, "p")
			if gotHead != head || oldest != head-capacity {
				t.Fatalf("size %d: oldest=%d head=%d want %d/%d", size, oldest, gotHead, head-capacity, head)
			}
			rec, ok := h.Recording("p", oldest, head)
			if !ok || rec.Start != oldest {
				t.Fatalf("size %d: retained range refused", size)
			}
			_, data, _ := readRetained(t, h, "p", oldest, head)
			if !bytes.Equal(data, want) {
				t.Fatalf("size %d: bytes=%d want exact newest cap of prefix+payload", size, len(data))
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
	steadyMax := int64(2*retentionSegRawMax + 2*retentionCkptMax + 256<<10)
	h := NewHub(4096)
	dir := t.TempDir()
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, 16<<20)
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
	if total > steadyMax {
		t.Fatalf("group files use %d bytes across %d files, want at most %d", total, files, steadyMax)
	}
	if oldest, head := retentionFloor(t, h, "p"); oldest != head-retentionHistoryCap {
		t.Fatalf("floor=%d head=%d after wrap", oldest, head)
	}
}

func TestRetentionBaseCheckpointsStayBounded(t *testing.T) {
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	dir := t.TempDir()
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, int(3*retentionSegNominal)+512<<10)
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
	tail := bytes.Repeat([]byte("t"), int(retentionHistoryCap))
	if err := first.Ingest("p", tail); err != nil {
		t.Fatal(err)
	}
	ph, _ := first.LookupPane("p")
	if n := len(ph.recording.segs); n != 2 {
		t.Fatalf("segments = %d, want 2 (rotation before breach)", n)
	}
	head := uint64(retentionSegNominal - 1 + retentionHistoryCap)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second := NewHub(0)
	t.Cleanup(func() { _ = second.Close() })
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	source := append(append([]byte{}, fill...), tail...)
	floor := head - retentionHistoryCap
	if start, data, _ := readRetained(t, second, "p", 0, head); start != floor || !bytes.Equal(data, source[floor:]) {
		t.Fatalf("reopen lost the retained suffix after near-full rotation: start=%d bytes=%d want %d", start, len(data), floor)
	}
}

func TestRetentionRestartPreservesSuffixScreenAndPermissions(t *testing.T) {
	capacity := uint64(retentionHistoryCap)
	dir := t.TempDir()
	first := NewHub(4096)
	if err := first.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, int(2*capacity)+12345)
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
	want := source[len(source)-int(capacity):]
	if start, data, _ := readRetained(t, second, "p", newPos.Oldest, newPos.Head); start != newPos.Oldest || !bytes.Equal(data, want) {
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
