package ws

import (
	"strings"
	"testing"
)

// Event cursors carry the exact resize boundary a checkpoint consumed so a
// following recording page applies same-position resizes exactly once. These
// tests define the cursor codec, boundary filtering, page chaining, and
// expiry before the M2 consumer changes.

func TestRetentionEventCursorRoundTrip(t *testing.T) {
	enc := EncodeEventCursor(7, 12345, 2)
	epoch, pos, ordinal, err := ParseEventCursor(enc)
	if err != nil {
		t.Fatalf("parse encoded cursor: %v", err)
	}
	if epoch != 7 || pos != 12345 || ordinal != 2 {
		t.Fatalf("round trip = (%d,%d,%d), want (7,12345,2)", epoch, pos, ordinal)
	}
	if len(enc) > 128 {
		t.Fatalf("encoded cursor length %d exceeds 128-byte cap", len(enc))
	}
	for _, bad := range []string{"", "v1.1.2", "v2.1.2.3", "v1.a.2.3", "v1.1.2.3.4", "v1.1.2.-1", strings.Repeat("v1.1.2.3.", 20)} {
		if _, _, _, err := ParseEventCursor(bad); err == nil {
			t.Fatalf("ParseEventCursor(%q) succeeded, want error", bad)
		}
	}
}

func retentionPos(t *testing.T, h *Hub, pane string) PanePosition {
	t.Helper()
	ph, ok := h.LookupPane(pane)
	if !ok {
		t.Fatalf("pane %s absent", pane)
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	return ph.positionLocked()
}

func ingestTo(t *testing.T, h *Hub, pane string, size int) {
	t.Helper()
	if err := h.Ingest(pane, retentionTestSource(t, size)); err != nil {
		t.Fatal(err)
	}
}

func TestRetentionRecordingIncludesEndCursor(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	const pane = "cursor-end"
	ingestTo(t, h, pane, 4096)
	h.RecordResize(pane, 80, 24)
	ingestTo(t, h, pane, 4096)
	h.RecordResize(pane, 100, 30)
	ingestTo(t, h, pane, 4096)

	oldest, head := retentionFloor(t, h, pane)
	rec, ok := h.Recording(pane, oldest, head)
	if !ok {
		t.Fatal("Recording failed")
	}
	if len(rec.Resizes) != 2 {
		t.Fatalf("plain recording markers = %d, want 2 (existing inclusion)", len(rec.Resizes))
	}
	epoch, pos, ordinal, err := ParseEventCursor(rec.EventCursor)
	if err != nil {
		t.Fatalf("end cursor invalid: %v", err)
	}
	if epoch != rec.Epoch || pos != head || ordinal != 2 {
		t.Fatalf("end cursor = (%d,%d,%d), want (%d,%d,2)", epoch, pos, ordinal, rec.Epoch, head)
	}
}

func TestRetentionCursorFiltersCheckpointCoveredBoundary(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	const pane = "cursor-boundary"
	ingestTo(t, h, pane, 65536)
	// Two resizes at the same source position: the checkpoint consumes both.
	h.RecordResize(pane, 80, 24)
	h.RecordResize(pane, 100, 30)
	_, at := retentionFloor(t, h, pane)
	ingestTo(t, h, pane, 65536)
	_, head := retentionFloor(t, h, pane)

	statePos, _, _, _, err := h.HistoricalState(pane, retentionPos(t, h, pane).Epoch, at)
	if err != nil {
		t.Fatalf("HistoricalState: %v", err)
	}
	_, statePosThrough, stateOrdinal, err := ParseEventCursor(statePos.EventCursor)
	if err != nil {
		t.Fatalf("state cursor invalid: %v", err)
	}
	if statePosThrough != at || stateOrdinal != 2 {
		t.Fatalf("state cursor = (pos %d, ordinal %d), want (%d, 2)", statePosThrough, stateOrdinal, at)
	}
	rec, end, err := h.RecordingAfterCursor(pane, at, head, statePos.EventCursor)
	if err != nil {
		t.Fatalf("RecordingAfterCursor: %v", err)
	}
	if len(rec.Data) != int(head-at) {
		t.Fatalf("cursor page bytes = %d, want %d", len(rec.Data), head-at)
	}
	if len(rec.Resizes) != 0 {
		t.Fatalf("cursor page markers = %d, want 0 (boundary already applied)", len(rec.Resizes))
	}
	_, endPos, endOrdinal, err := ParseEventCursor(end)
	if err != nil {
		t.Fatalf("end cursor invalid: %v", err)
	}
	if endPos != head || endOrdinal != 2 {
		t.Fatalf("end cursor = (pos %d, ordinal %d), want (%d, 2)", endPos, endOrdinal, head)
	}
}

func TestRetentionEventCursorChainsAcrossPages(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	const pane = "cursor-chain"
	ingestTo(t, h, pane, 32768)
	h.RecordResize(pane, 80, 24)
	mid1 := uint64(32768)
	ingestTo(t, h, pane, 32768)
	h.RecordResize(pane, 100, 30)
	h.RecordResize(pane, 120, 40)
	mid2 := uint64(65536)
	ingestTo(t, h, pane, 32768)
	_, head := retentionFloor(t, h, pane)

	epoch := retentionPos(t, h, pane).Epoch
	after := EncodeEventCursor(epoch, 0, 0)
	var got [][3]uint64
	for _, span := range [][2]uint64{{0, mid1}, {mid1, mid2}, {mid2, head}} {
		rec, end, err := h.RecordingAfterCursor(pane, span[0], span[1], after)
		if err != nil {
			t.Fatalf("page %v: %v", span, err)
		}
		for _, m := range rec.Resizes {
			got = append(got, [3]uint64{m.AtSeq, uint64(m.Cols), uint64(m.Rows)})
		}
		after = end
	}
	want := [][3]uint64{{32768, 80, 24}, {65536, 100, 30}, {65536, 120, 40}}
	if len(got) != len(want) {
		t.Fatalf("chained markers = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("chained markers = %v, want %v", got, want)
		}
	}
}

func TestRetentionExpiredEventCursorFails(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	const pane = "cursor-expired"
	ingestTo(t, h, pane, 65536)
	h.RecordResize(pane, 80, 24)
	epoch := retentionPos(t, h, pane).Epoch
	stale := EncodeEventCursor(epoch, 65536, 0)
	// Evict the first segment with its resize boundary.
	ingestTo(t, h, pane, 2<<20)
	oldest, head := retentionFloor(t, h, pane)
	if oldest == 0 {
		t.Fatal("expected eviction before expiry check")
	}
	if _, _, err := h.RecordingAfterCursor(pane, oldest, head, stale); err != ErrEventCursorExpired {
		t.Fatalf("stale cursor err = %v, want ErrEventCursorExpired", err)
	}
	fresh := EncodeEventCursor(epoch, oldest, 1)
	if _, _, err := h.RecordingAfterCursor(pane, oldest, head, fresh); err != nil {
		t.Fatalf("fresh cursor err = %v, want nil", err)
	}
	if _, _, err := h.RecordingAfterCursor(pane, oldest, head, "bogus"); err != ErrEventCursorInvalid {
		t.Fatalf("malformed cursor err = %v, want ErrEventCursorInvalid", err)
	}
	otherEpoch := EncodeEventCursor(epoch+1, oldest, 1)
	if _, _, err := h.RecordingAfterCursor(pane, oldest, head, otherEpoch); err != ErrEventCursorExpired {
		t.Fatalf("cross-epoch cursor err = %v, want ErrEventCursorExpired", err)
	}
}

func TestRetentionOrdinalBehindCursorAtRetainedPositionStaysValid(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	const pane = "cursor-ordinal-behind"
	ingestTo(t, h, pane, 65536)
	h.RecordResize(pane, 80, 24)
	epoch := retentionPos(t, h, pane).Epoch
	// Evict the only resize: its ordinal is spent, but a cursor at a
	// retained frontier never needed it.
	ingestTo(t, h, pane, 2<<20)
	oldest, head := retentionFloor(t, h, pane)
	if oldest == 0 {
		t.Fatal("expected eviction before the validity check")
	}
	behind := EncodeEventCursor(epoch, oldest, 0)
	rec, _, err := h.RecordingAfterCursor(pane, oldest, head, behind)
	if err != nil {
		t.Fatalf("retained-position cursor err = %v, want nil", err)
	}
	if uint64(len(rec.Data)) != head-oldest {
		t.Fatalf("cursor page bytes = %d, want %d", len(rec.Data), head-oldest)
	}
}

func TestRetentionCursorExpiryPredicate(t *testing.T) {
	group := func(segs []retentionSeg, nextOrdinal, maxEvicted uint64) *retentionGroup {
		return &retentionGroup{segs: segs, nextOrdinal: nextOrdinal, maxEvictedMarkerSeq: maxEvicted}
	}
	seg := func(startOrdinal uint64, markers ...ResizeMarker) retentionSeg {
		return retentionSeg{retentionSegDesc: retentionSegDesc{gen: 1, startOrdinal: startOrdinal}, resizes: markers}
	}
	cases := []struct {
		name        string
		g           *retentionGroup
		floor, pos  uint64
		after       uint64
		wantExpired bool
	}{
		{
			name:  "fresh group ordinal zero is valid",
			g:     group([]retentionSeg{seg(1)}, 1, 0),
			floor: 0, pos: 100, after: 0,
		},
		{
			name:  "position below floor expires",
			g:     group([]retentionSeg{seg(1)}, 1, 0),
			floor: 100, pos: 99, after: 0,
			wantExpired: true,
		},
		{
			name:  "evicted earlier markers stay valid",
			g:     group([]retentionSeg{seg(2)}, 2, 65536),
			floor: 1 << 20, pos: 1 << 20, after: 0,
		},
		{
			name:  "evicted same-position markers expire",
			g:     group([]retentionSeg{seg(4097, ResizeMarker{AtSeq: 65536, Cols: 100, Rows: 30})}, 4098, 65536),
			floor: 0, pos: 65536, after: 0,
			wantExpired: true,
		},
		{
			name:  "ordinal-current cursor survives same-position eviction",
			g:     group([]retentionSeg{seg(4097, ResizeMarker{AtSeq: 65536, Cols: 100, Rows: 30})}, 4098, 65536),
			floor: 0, pos: 65536, after: 4097,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.g.cursorExpired(tc.floor, tc.pos, tc.after); got != tc.wantExpired {
				t.Fatalf("cursorExpired(%d, %d, %d) = %v, want %v", tc.floor, tc.pos, tc.after, got, tc.wantExpired)
			}
		})
	}
}

func TestRetentionEvictionTracksMaxMarkerSeq(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	const pane = "cursor-evict-track"
	ingestTo(t, h, pane, 65536)
	h.RecordResize(pane, 80, 24)
	// Byte rotation evicts the segment holding the only marker.
	ingestTo(t, h, pane, 2<<20)
	ph, _ := h.LookupPane(pane)
	if got := ph.recording.maxEvictedMarkerSeq; got != 65536 {
		t.Fatalf("maxEvictedMarkerSeq = %d, want 65536", got)
	}
}

func TestRetentionMissingGroupStateIsNotFound(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := h.HistoricalState("absent", 1, 0); err != ErrStateNotFound {
		t.Fatalf("HistoricalState absent err = %v, want ErrStateNotFound", err)
	}
	if _, _, _, _, err := h.LiveANSIState("absent", 1); err != ErrStateNotFound {
		t.Fatalf("LiveANSIState absent err = %v, want ErrStateNotFound", err)
	}
}
