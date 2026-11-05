package ws

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/pkg/pty"
)

// ptyInstance builds a real instance record with spawn geometry.
func ptyInstance(id string, cols, rows uint16) pty.PTYInstance {
	return pty.PTYInstance{ID: id, Pty: &pty.Pty{Cols: cols, Rows: rows}}
}

// The RAM window is the retained-output authority: it keeps at most its
// configured capacity, admits an oversized burst by keeping only its tail,
// and never writes a byte to disk.
func TestRAMReplayWindow(t *testing.T) {
	tests := []struct {
		name     string
		capacity int
		bursts   [][]byte
		want     string
		wantOld  uint64
		wantHead uint64
	}{
		{
			name:     "small capacity keeps the tail",
			capacity: 8,
			bursts:   [][]byte{[]byte("12345678"), []byte("9ABCDEF")},
			want:     "89ABCDEF",
			wantOld:  7,
			wantHead: 15,
		},
		{
			name:     "oversized admission keeps the last capacity",
			capacity: 8,
			bursts:   [][]byte{[]byte("0123456789ABCDEF")},
			want:     "89ABCDEF",
			wantOld:  8,
			wantHead: 16,
		},
		{
			name:     "exact capacity fills without rollover",
			capacity: 8,
			bursts:   [][]byte{[]byte("12345678")},
			want:     "12345678",
			wantOld:  0,
			wantHead: 8,
		},
		{
			name:     "retention disabled admits bytes but keeps none",
			capacity: 0,
			bursts:   [][]byte{[]byte("abc")},
			want:     "",
			wantOld:  3,
			wantHead: 3,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			h := NewHub(tc.capacity)
			t.Cleanup(func() { _ = h.Close() })
			if err := h.SetRecordingDirectory(dir); err != nil {
				t.Fatal(err)
			}
			if err := h.InitPaneJournal("p", 80, 24); err != nil {
				t.Fatal(err)
			}
			for _, b := range tc.bursts {
				if err := h.Ingest("p", b); err != nil {
					t.Fatal(err)
				}
			}
			ph, _ := h.LookupPane("p")
			pos := ph.positionLocked()
			if pos.Oldest != tc.wantOld || pos.Head != tc.wantHead {
				t.Fatalf("window = [%d,%d), want [%d,%d)", pos.Oldest, pos.Head, tc.wantOld, tc.wantHead)
			}
			if tc.want == "" {
				return
			}
			page, err := h.Replay("p", ReplayRequest{Epoch: pos.Epoch, From: pos.Oldest, Latest: true})
			if err != nil {
				t.Fatalf("replay: %v", err)
			}
			if string(page.Data) != tc.want {
				t.Fatalf("retained = %q, want %q", page.Data, tc.want)
			}
			if page.Incomplete != (pos.Oldest > 0) {
				t.Fatalf("incomplete = %v at oldest %d", page.Incomplete, pos.Oldest)
			}
			// No pane output reached disk: only the namespace lease exists.
			v3 := filepath.Join(dir, "v3")
			entries, err := os.ReadDir(v3)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range entries {
				if e.Name() != "lease" {
					t.Fatalf("pane output wrote %q", e.Name())
				}
			}
		})
	}
}

// A 32 MiB window is the hard ceiling on retained payload, not a target:
// after 40 MiB of output the ring holds exactly 32 MiB and the floor moved.
func TestRAMReplayWindowCap(t *testing.T) {
	h := NewHub(32 << 20)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("x"), 1<<20)
	for i := 0; i < 40; i++ {
		if err := h.Ingest("p", chunk); err != nil {
			t.Fatal(err)
		}
	}
	ph, _ := h.LookupPane("p")
	ph.mu.Lock()
	if got := ph.win.used(); got != 32<<20 {
		ph.mu.Unlock()
		t.Fatalf("retained = %d, want %d", got, 32<<20)
	}
	if got := ph.win.capacity(); got != 32<<20 {
		ph.mu.Unlock()
		t.Fatalf("capacity = %d, want %d", got, 32<<20)
	}
	pos := ph.positionLocked()
	ph.mu.Unlock()
	if pos.Head != 40<<20 || pos.Oldest != 8<<20 {
		t.Fatalf("window = [%d,%d), want [%d,%d)", pos.Oldest, pos.Head, uint64(8<<20), uint64(40<<20))
	}
	if _, err := h.Replay("p", ReplayRequest{Epoch: pos.Epoch, From: 0, Latest: true}); !errors.Is(err, ErrReplayExpired) {
		t.Fatalf("evicted prefix = %v, want expired", err)
	}
}

// A same-position resize fence may exclude later markers at that position,
// but a page starting before a marker must include it: geometry is never
// applied to bytes it did not cover.
func TestRAMReplayPositions(t *testing.T) {
	h := NewHub(1024)
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("ab")); err != nil {
		t.Fatal(err)
	}
	commit, _, err := h.StagePaneResize("p", 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	if err := commit(); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("cd")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	epoch := ph.EpochOf()

	page, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: 0, Latest: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Resizes) != 1 || page.Resizes[0].AtSeq != 2 || page.Resizes[0].Cols != 100 {
		t.Fatalf("markers = %+v", page.Resizes)
	}

	// A cursor that omits a marker before its own start is malformed.
	if _, err := h.Replay("p", ReplayRequest{
		Epoch: epoch, From: 3, Through: 4,
		ThroughCursor: EncodeEventCursor(epoch, 4, 1),
		AfterCursor:   EncodeEventCursor(epoch, 3, 0),
	}); !errors.Is(err, ErrReplayBadRequest) {
		t.Fatalf("inconsistent start cursor = %v, want bad request", err)
	}
}

// A replacement owner mints a new epoch, drops the previous window, and
// refuses bytes from the retired read loop.
func TestRAMReplayOwnerReplacement(t *testing.T) {
	h := NewHub(64)
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	oldInst := ptyInstance("p", 80, 24)
	old := &oldInst
	if err := h.InitPaneForOwner(old); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("old")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	oldEpoch := ph.EpochOf()

	freshInst := ptyInstance("p", 100, 30)
	fresh := &freshInst
	if err := h.InitPaneForOwner(fresh); err != nil {
		t.Fatal(err)
	}
	ph, _ = h.LookupPane("p")
	if ph.EpochOf() == oldEpoch {
		t.Fatal("replacement reused the retired epoch")
	}
	pos := ph.positionLocked()
	if pos.Head != 0 || pos.Oldest != 0 {
		t.Fatalf("replacement inherited history: %+v", pos)
	}
	if _, err := h.Replay("p", ReplayRequest{Epoch: oldEpoch, From: 0, Latest: true}); !errors.Is(err, ErrReplayEpoch) {
		t.Fatalf("old epoch = %v, want epoch mismatch", err)
	}
	// Repeating the same owner is idempotent.
	before := ph.EpochOf()
	if err := h.InitPaneForOwner(fresh); err != nil {
		t.Fatal(err)
	}
	if ph.EpochOf() != before {
		t.Fatal("repeat init minted a new epoch")
	}
}

// A same-size stage still holds the resize transaction until commit or
// abort, and repeated closure calls release exactly once.
func TestRAMReplayResizeTransaction(t *testing.T) {
	h := NewHub(1024)
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("a")); err != nil {
		t.Fatal(err)
	}
	commit, abort, err := h.StagePaneResize("p", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.StagePaneResize("p", 100, 30); err == nil {
		t.Fatal("same-size stage must still serialize later resizes")
	}
	if err := commit(); err != nil {
		t.Fatal(err)
	}
	abort()
	// The same-size commit recorded no marker.
	ph, _ := h.LookupPane("p")
	page, err := h.Replay("p", ReplayRequest{Epoch: ph.EpochOf(), From: 0, Latest: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Resizes) != 0 {
		t.Fatalf("same-size stage recorded %+v", page.Resizes)
	}
}
