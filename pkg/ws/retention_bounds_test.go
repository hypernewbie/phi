package ws

import (
	"bytes"
	"os"
	"testing"
)

// Package tests run the approved window scaled to one segment per window: a
// 1 MiB cap over 1 MiB segments spans two segments, exactly like the geometry
// the eviction tests were written for, on fixtures that stay small.
// TestRetentionApprovedWindow covers the shipped 32 MiB / 4 MiB bounds.
const (
	testRetentionCap     uint64 = 1 << 20
	testRetentionSegment uint64 = 1 << 20
)

func setRetentionBounds(capBytes, segNominal uint64) {
	retentionHistoryCap, retentionSegNominal = capBytes, segNominal
	retentionSegRawMax = retentionSegNominal + retentionSegSlack
	retentionSegsKept = int(retentionHistoryCap/retentionSegNominal) + 1
}

func TestMain(m *testing.M) {
	setRetentionBounds(testRetentionCap, testRetentionSegment)
	os.Exit(m.Run())
}

// TestRetentionApprovedWindow pins the shipped bounds: nine 4 MiB segments
// must reach the full 32 MiB public window, before and after the rotation that
// evicts the oldest segment, and again after a reopen.
func TestRetentionApprovedWindow(t *testing.T) {
	setRetentionBounds(32<<20, 4<<20)
	defer setRetentionBounds(testRetentionCap, testRetentionSegment)
	if retentionSegsKept != 9 {
		t.Fatalf("approved window spans %d segments, want 9", retentionSegsKept)
	}
	dir := t.TempDir()
	h := NewHub(0)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	// Two nominal segments past the cap: the second rotation group evicts the
	// zero-prefix segment, so the window has to hold up after real eviction.
	source := retentionTestSource(t, int(retentionHistoryCap)+2*int(retentionSegNominal))
	ingestChunks(t, h, "p", source, 1024*1024)
	oldest, head := retentionFloor(t, h, "p")
	if head != uint64(len(source)) || oldest != head-retentionHistoryCap {
		t.Fatalf("approved window oldest=%d head=%d want %d/%d", oldest, head, head-retentionHistoryCap, len(source))
	}
	start, data, _ := readRetained(t, h, "p", oldest, head)
	if start != oldest || !bytes.Equal(data, source[len(source)-int(retentionHistoryCap):]) {
		t.Fatalf("approved window read start=%d bytes=%d", start, len(data))
	}
	ph, _ := h.LookupPane("p")
	ph.mu.Lock()
	segs := append([]retentionSeg(nil), ph.recording.segs...)
	ph.mu.Unlock()
	if len(segs) != retentionSegsKept {
		t.Fatalf("retained segments=%d want %d", len(segs), retentionSegsKept)
	}
	if segs[0].start == 0 {
		t.Fatal("fixture kept the zero-prefix segment, so eviction never ran")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := NewHub(0)
	t.Cleanup(func() { _ = reopened.Close() })
	if err := reopened.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	// Recording opens the cold group lazily, like an attach after a restart.
	pos, _, _, _, err := reopened.State("p")
	if err != nil {
		t.Fatal(err)
	}
	oldest, head = pos.Oldest, pos.Head
	if head != uint64(len(source)) || oldest != head-retentionHistoryCap {
		t.Fatalf("reopened window oldest=%d head=%d want %d/%d", oldest, head, head-retentionHistoryCap, len(source))
	}
	start, data, _ = readRetained(t, reopened, "p", oldest, head)
	if start != oldest || !bytes.Equal(data, source[len(source)-int(retentionHistoryCap):]) {
		t.Fatalf("reopened window read start=%d bytes=%d", start, len(data))
	}
}

// TestRetentionGiantPayloadRetainsNewestSegment pins the known limit of the
// single-segment replacement path: one write above a segment's physical size
// keeps only its newest segment, so the reachable window shrinks below the cap.
func TestRetentionGiantPayloadRetainsNewestSegment(t *testing.T) {
	// A cap above the segment ceiling makes the shrink visible; the shipped
	// ratio has the same shape at a smaller scale.
	setRetentionBounds(8<<20, 1<<20)
	defer setRetentionBounds(testRetentionCap, testRetentionSegment)
	if retentionSegRawMax >= retentionHistoryCap {
		t.Fatalf("fixture needs a cap above one segment: cap=%d max=%d", retentionHistoryCap, retentionSegRawMax)
	}
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	prefix := retentionTestSource(t, int(retentionHistoryCap)+4096)
	ingestChunks(t, h, "p", prefix, 32*1024)
	payload := retentionTestSource(t, int(retentionSegRawMax)+1)
	if err := h.Ingest("p", payload); err != nil {
		t.Fatal(err)
	}
	combined := append(append([]byte(nil), prefix...), payload...)
	head := uint64(len(combined))
	wantOldest := max(head-retentionSegRawMax, head-min(head, uint64(retentionHistoryCap)))
	oldest, gotHead := retentionFloor(t, h, "p")
	if gotHead != head || oldest != wantOldest {
		t.Fatalf("giant payload oldest=%d head=%d want %d/%d", oldest, gotHead, wantOldest, head)
	}
	if oldest != head-retentionSegRawMax {
		t.Fatalf("giant payload retained %d bytes, want the segment ceiling %d", head-oldest, retentionSegRawMax)
	}
	if _, data, _ := readRetained(t, h, "p", oldest, head); !bytes.Equal(data, combined[len(combined)-int(head-oldest):]) {
		t.Fatalf("giant payload bytes=%d want the newest segment", len(data))
	}
}

// TestRetentionLargeAdmissionsShortenTheWindow pins the second known limit:
// an admission larger than half a segment rotates before the segment reaches
// its nominal size, so eviction can leave less than the public window. PTY
// reads are far smaller, which is why this only shows up on direct writes.
func TestRetentionLargeAdmissionsShortenTheWindow(t *testing.T) {
	setRetentionBounds(8<<20, 1<<20)
	defer setRetentionBounds(testRetentionCap, testRetentionSegment)
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	// Two 600 KiB admissions would breach a 1 MiB segment plus slack, so each
	// segment settles at one admission instead of its nominal size.
	chunk := retentionTestSource(t, 600<<10)
	for range 3 * retentionSegsKept {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	oldest, head := retentionFloor(t, h, "p")
	if head == 0 || oldest == 0 {
		t.Fatalf("fixture did not rotate: oldest=%d head=%d", oldest, head)
	}
	window := head - oldest
	if window >= uint64(retentionHistoryCap) {
		t.Fatalf("retained %d bytes, expected a window below the %d cap", window, retentionHistoryCap)
	}
	if want := uint64(retentionSegsKept) * uint64(len(chunk)); window > want {
		t.Fatalf("retained %d bytes, want at most %d", window, want)
	}
	start, data, _ := readRetained(t, h, "p", oldest, head)
	if start != oldest || uint64(len(data)) != window {
		t.Fatalf("shortened window read start=%d bytes=%d want %d/%d", start, len(data), oldest, window)
	}
}
