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
