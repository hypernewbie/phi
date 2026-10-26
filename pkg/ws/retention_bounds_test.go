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
// must reach the full 32 MiB public window as two.
func TestRetentionApprovedWindow(t *testing.T) {
	setRetentionBounds(32<<20, 4<<20)
	defer setRetentionBounds(testRetentionCap, testRetentionSegment)
	if retentionSegsKept != 9 {
		t.Fatalf("approved window spans %d segments, want 9", retentionSegsKept)
	}
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	source := retentionTestSource(t, int(retentionHistoryCap)+int(retentionSegNominal))
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
}

// TestRetentionGiantPayloadRetainsNewestSegment pins the known limit of the
// single-segment replacement path: one write above a segment's physical size
// keeps only its newest segment, so the reachable window shrinks below the cap.
func TestRetentionGiantPayloadRetainsNewestSegment(t *testing.T) {
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
	if _, data, _ := readRetained(t, h, "p", oldest, head); !bytes.Equal(data, combined[len(combined)-int(head-oldest):]) {
		t.Fatalf("giant payload bytes=%d want the newest segment", len(data))
	}
}
