package ws

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
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
			if page.Incomplete {
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

func TestRAMReplayResizeMetadataBounds(t *testing.T) {
	for _, capacity := range []int{0, 32} {
		w := newReplayWindow(capacity, 80, 24)
		for i := 0; i < 3*replayWindowResizeCap; i++ {
			w.appendResize(uint16(80+i%2), 24)
			w.write([]byte("x"))
			if len(w.resizes) > replayWindowResizeCap || cap(w.resizes) > replayWindowResizeCap {
				t.Fatal("resize storage exceeded its hard cap")
			}
		}
		if capacity == 0 && w.resizes != nil {
			t.Fatal("disabled retention allocated resize history")
		}
	}
	h := NewHub(64)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("ab")); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		commit, _, err := h.StagePaneResize("p", uint16(81+i%2), 24)
		if err != nil {
			t.Fatal(err)
		}
		if err := commit(); err != nil {
			t.Fatal(err)
		}
	}
	info, _ := h.ReplayWindow("p")
	from, after := uint64(0), EncodeEventCursor(info.Epoch, 0, 0)
	markers, pages := 0, 0
	for after != info.EventCursor {
		page, err := h.Replay("p", ReplayRequest{Epoch: info.Epoch, From: from, Through: info.Head, ThroughCursor: info.EventCursor, AfterCursor: after})
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Resizes) > 256 || page.EndCursor == after {
			t.Fatal("marker-only paging exceeded its cap or stalled")
		}
		markers += len(page.Resizes)
		pages++
		from, after = page.End, page.EndCursor
	}
	if markers != 1000 || pages != 4 {
		t.Fatalf("markers=%d pages=%d", markers, pages)
	}
	// Overflow at the same byte expires old ordinals without losing the
	// latest geometry or pretending the byte floor alone certifies it.
	for i := 0; i < replayWindowResizeCap; i++ {
		commit, _, err := h.StagePaneResize("p", uint16(83+i%2), 24)
		if err != nil {
			t.Fatal(err)
		}
		if err := commit(); err != nil {
			t.Fatal(err)
		}
	}
	page, err := h.Replay("p", ReplayRequest{Epoch: info.Epoch, From: 2, Through: 2, ThroughCursor: info.EventCursor, AfterCursor: after})
	if !errors.Is(err, ErrReplayExpired) || page.Position == nil || page.Position.Oldest != 2 {
		t.Fatalf("expired ordinal: %v %+v", err, page.Position)
	}
	latest := page.Position
	if latest.FloorEventCursor != latest.EventCursor || latest.FloorCols != latest.HeadCols {
		t.Fatal("floor geometry and ordinal are not one certificate")
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
	if err := h.InitPaneForOwner(old); err == nil {
		t.Fatal("retired owner reinitialized")
	}
	if err := h.ingestForOwner(old, []byte("late")); err == nil {
		t.Fatal("retired owner admitted output")
	}
	if _, _, err := h.stageResizeForOwner(old, 90, 25); err == nil {
		t.Fatal("retired owner resized replacement")
	}
	if h.attachHot("p", &Client{Send: make(chan []byte, 1)}, old) {
		t.Fatal("retired owner attached")
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
	started, admitted := make(chan struct{}), make(chan error, 1)
	go func() { close(started); admitted <- h.Ingest("p", []byte("b")) }()
	<-started
	select {
	case <-admitted:
		t.Fatal("output passed an uncommitted resize")
	default:
	}
	if err := commit(); err != nil {
		t.Fatal(err)
	}
	abort()
	if err := <-admitted; err != nil {
		t.Fatal(err)
	}
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

// TestRAMReplaySlowClient proves the congestion invariant end to end: one
// paused reader overflows its own bounded queue while a healthy reader
// keeps every frame, the producer keeps admitting bytes, and the paused
// reader can still recover from the retained window instead of mistaking
// a dropped frame for complete output.
func TestRAMReplaySlowClient(t *testing.T) {
	h := NewHub(1 << 20)
	defer func() { _ = h.Close() }()
	const pane = "pane-slow-client"
	if err := h.InitPaneJournal(pane, 80, 24); err != nil {
		t.Fatal(err)
	}
	paused := &Client{Send: make(chan []byte, 8), Logger: componentLogger().With("pane", pane)}
	healthy := &Client{Send: make(chan []byte, 4096), Logger: componentLogger().With("pane", pane)}
	h.Register(pane, paused)
	h.Register(pane, healthy)

	received := make(chan []byte, 4096)
	go func() {
		defer close(received)
		for msg := range healthy.Send {
			received <- msg
		}
	}()

	const frames = 600
	for i := 0; i < frames; i++ {
		if err := h.Ingest(pane, []byte("line-"+strconv.Itoa(i)+"\n")); err != nil {
			t.Fatal(err)
		}
	}
	// A committed resize after the flood proves the healthy reader still
	// gets control frames and the window still certifies their geometry.
	commit, abort, err := h.StagePaneResize(pane, 120, 30)
	if err != nil {
		t.Fatal(err)
	}
	defer abort()
	if err := commit(); err != nil {
		t.Fatal(err)
	}
	info, ok := h.ReplayWindow(pane)
	if !ok || info.Head == 0 {
		t.Fatalf("window after resize: %+v ok=%v", info, ok)
	}
	head := info.Head

	h.Unregister(pane, healthy)
	var outputs int
	var lastEnd uint64
	var sawGeometry bool
	for msg := range received {
		frame, err := wireproto.DecodeServerFrame(msg)
		if err != nil {
			t.Fatalf("healthy frame: %v", err)
		}
		if out := frame.GetOutput(); out != nil {
			outputs++
			lastEnd = out.GetStart() + uint64(len(out.GetData()))
			continue
		}
		if geom := frame.GetGeometry(); geom != nil {
			if geom.GetCols() != 120 || geom.GetRows() != 30 || geom.GetAtSeq() != head {
				t.Fatalf("healthy geometry: %+v", geom)
			}
			sawGeometry = true
			continue
		}
		if frame.GetDropNotice() != nil {
			t.Fatalf("healthy reader received a drop notice")
		}
	}
	if outputs != frames || lastEnd != head || !sawGeometry {
		t.Fatalf("healthy reader: outputs=%d last=%d geometry=%v head=%d", outputs, lastEnd, sawGeometry, head)
	}

	// The paused reader is still attached with a bounded queue; its lost
	// frames are exactly what recovery has to repair.
	if got, want := len(paused.Send), cap(paused.Send); got != want {
		t.Fatalf("paused queue=%d, want bounded at %d", got, want)
	}
	// The paused reader kept only the newest frames: the prompt tells it
	// output was lost, and recovery comes from the window below.
	pausedFrames := 0
drain:
	for {
		select {
		case msg := <-paused.Send:
			frame, err := wireproto.DecodeServerFrame(msg)
			if err != nil {
				t.Fatal(err)
			}
			if frame.GetOutput() != nil {
				pausedFrames++
			}
		default:
			break drain
		}
	}
	if pausedFrames >= frames {
		t.Fatalf("paused reader kept %d frames; congestion did not drop any", pausedFrames)
	}

	h.mu.RLock()
	attached := h.panes[pane] != nil && h.panes[pane].clients[paused]
	h.mu.RUnlock()
	if !attached {
		t.Fatal("overflow detached the paused reader instead of keeping it open")
	}

	// The retained window still certifies every byte and the resize, so a
	// recovery read needs no cooperation from the reader that fell behind.
	if info.Head != head || info.Oldest != 0 {
		t.Fatalf("window: %+v ok=%v", info, ok)
	}
	page, err := h.Replay(pane, ReplayRequest{Epoch: info.Epoch, From: 0, Latest: true})
	if err != nil {
		t.Fatal(err)
	}
	if page.End != info.Head || len(page.Data) != int(info.Head) || len(page.Resizes) != 1 {
		t.Fatalf("recovery page: end=%d data=%d resizes=%d head=%d", page.End, len(page.Data), len(page.Resizes), info.Head)
	}
}
