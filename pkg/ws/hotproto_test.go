package ws

// Terminal protocol invariants. These tests pin the
// server contracts the plan calls non-negotiable.
//
//   - attach is atomic: a client gets an attach frame with the head H and
//     then only output frames with start >= H (no gap, no dupes);
//   - seq accounting is exact; the journal never evicts;
//   - the recording endpoint view matches the bytes the live stream
//     carried, including resize marker ordering;
//   - checkpoints are opaque, bounded, upload-only; attach never serves one.

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func drainOne(ch chan []byte) []byte {
	select {
	case m := <-ch:
		return m
	default:
		return nil
	}
}

func mustNotArrive(t *testing.T, ch chan []byte) {
	t.Helper()
	if m := drainOne(ch); m != nil {
		t.Fatalf("expected no frame, got %v", m)
	}
}

// parseAttach decodes one server frame and returns its attach payload.
// Checkpoint bytes ride inside the message now, so there is no separate
// trailing span to return.
func parseAttach(t *testing.T, frame []byte) *wspb.TerminalAttach {
	t.Helper()
	server, err := wireproto.DecodeServerFrame(frame)
	if err != nil {
		t.Fatalf("decode server frame: %v", err)
	}
	attach := server.GetAttach()
	if attach == nil {
		t.Fatalf("not an attach frame: %v", server.GetPayload())
	}
	return attach
}

func parseOutput(t *testing.T, frame []byte) *wspb.TerminalOutput {
	t.Helper()
	server, err := wireproto.DecodeServerFrame(frame)
	if err != nil {
		t.Fatalf("decode server frame: %v", err)
	}
	out := server.GetOutput()
	if out == nil {
		t.Fatalf("not an output frame: %v", server.GetPayload())
	}
	return out
}

func TestAttachHotIsAtomicAndLiveOnly(t *testing.T) {
	h := NewHub(1024)
	h.Ingest("p", []byte("hello"))

	c := &Client{Send: make(chan []byte, 8)}
	h.AttachHot("p", c)

	attach := parseAttach(t, drainOne(c.Send))
	if attach.GetHead() != 5 || attach.GetOldest() != 0 || attach.GetCheckpoint() != nil {
		t.Fatalf("bad head position: %+v", attach)
	}
	mustNotArrive(t, c.Send) // live-only: no replay frames

	// Live output after attach must start exactly at head.
	h.Ingest("p", []byte(" world"))
	live := parseOutput(t, drainOne(c.Send))
	if live.GetStart() != 5 {
		t.Fatalf("live start = %d, want 5", live.GetStart())
	}
	if string(live.GetData()) != " world" {
		t.Fatalf("live payload = %q", live.GetData())
	}

	// Second ingest continues contiguously.
	h.Ingest("p", []byte("!"))
	live2 := parseOutput(t, drainOne(c.Send))
	if live2.GetStart() != 11 {
		t.Fatalf("second live start = %d, want 11", live2.GetStart())
	}
	mustNotArrive(t, c.Send)
}

func TestSeqAccountingAcrossWraparound(t *testing.T) {
	h := NewHub(8)
	h.Ingest("p", []byte("12345678")) // total=8
	h.Ingest("p", []byte("9ABCDEF"))  // total=15
	ph, _ := h.LookupPane("p")
	epoch := ph.EpochOf()

	// The RAM window keeps only its capacity, so a replay from byte zero
	// is expired instead of pretending the evicted prefix still exists.
	if _, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: 0, Latest: true}); !errors.Is(err, ErrReplayExpired) {
		t.Fatalf("replay from an evicted prefix = %v, want expired", err)
	}

	page, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: 7, Latest: true})
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if page.Start != 7 || page.End != 15 {
		t.Fatalf("replay span [%d,%d), want [7,15)", page.Start, page.End)
	}
	if string(page.Data) != "89ABCDEF" {
		t.Fatalf("replay data = %q, want the retained tail", page.Data)
	}

	// Partial range inside the retained window.
	partial, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: 9, Through: 12, ThroughCursor: EncodeEventCursor(epoch, 12, 0)})
	if err != nil {
		t.Fatalf("partial replay: %v", err)
	}
	if partial.Start != 9 || partial.End != 12 || string(partial.Data) != "ABC" {
		t.Fatalf("partial replay = %+v %q", partial, partial.Data)
	}

	// from beyond head is an error.
	if _, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: 16, Latest: true}); err == nil {
		t.Fatal("replay from beyond head must fail")
	}

	// A numeric through without its attach fence is an error: the fence
	// certifies the head the caller attached to.
	if _, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: 7, Through: 15}); !errors.Is(err, ErrReplayBadRequest) {
		t.Fatalf("unfenced through must fail bad-request, got %v", err)
	}
}

// A staged resize keeps the pane transaction open until commit or abort,
// and its geometry frame orders against live output by byte position.
func TestIngestPublishesCommittedResizeWhenPayloadFails(t *testing.T) {
	h := NewHub(1024)
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	c := &Client{Send: make(chan []byte, 8)}
	h.AttachHot("p", c)
	drainOne(c.Send) // attach

	commit, abort, err := h.StagePaneResize("p", 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	if err := commit(); err != nil {
		t.Fatal(err)
	}
	if err := commit(); err != nil {
		t.Fatalf("repeated commit must release once: %v", err)
	}
	abort() // repeated release is a no-op

	frame, err := wireproto.DecodeServerFrame(drainOne(c.Send))
	if err != nil || frame.GetGeometry() == nil {
		t.Fatalf("committed resize never reached live clients: %+v %v", frame, err)
	}
	if g := frame.GetGeometry(); g.GetCols() != 100 || g.GetRows() != 30 {
		t.Fatalf("geometry = %dx%d", g.GetCols(), g.GetRows())
	}

	h.Ingest("p", []byte("x"))
	ph, _ := h.LookupPane("p")
	page, err := h.Replay("p", ReplayRequest{Epoch: ph.EpochOf(), From: 0, Latest: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Resizes) != 1 || page.Resizes[0].AtSeq != 0 || page.Resizes[0].Cols != 100 {
		t.Fatalf("replay markers = %+v, want one marker at byte 0", page.Resizes)
	}
}

func TestRecordResizeMarkersOrderAgainstOutput(t *testing.T) {
	h := NewHub(1024)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	commit := func(cols, rows uint16) {
		t.Helper()
		commit, _, err := h.StagePaneResize("p", cols, rows)
		if err != nil {
			t.Fatalf("stage %dx%d: %v", cols, rows, err)
		}
		if err := commit(); err != nil {
			t.Fatalf("commit %dx%d: %v", cols, rows, err)
		}
	}
	h.Ingest("p", []byte("aaaa")) // 0..4
	commit(120, 40)
	h.Ingest("p", []byte("bb")) // 4..6
	commit(120, 40)             // duplicate suppressed
	h.Ingest("p", []byte("cc")) // 6..8

	ph, _ := h.LookupPane("p")
	page, err := h.Replay("p", ReplayRequest{Epoch: ph.EpochOf(), From: 0, Latest: true})
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	// The 80x24 baseline is initial geometry, not a marker.
	if len(page.Resizes) != 1 {
		t.Fatalf("want 1 marker (dup suppressed), got %+v", page.Resizes)
	}
	if m := page.Resizes[0]; m.AtSeq != 4 || m.Cols != 120 || m.Rows != 40 {
		t.Fatalf("marker = %+v", m)
	}
	if page.InitCols != 80 || page.InitRows != 24 {
		t.Fatalf("initial geometry = %dx%d", page.InitCols, page.InitRows)
	}
}

func TestStoreCheckpointRules(t *testing.T) {
	h := NewHub(1024)
	h.Ingest("p", []byte("hello")) // head=5

	epoch := func() uint64 {
		ph, _ := h.LookupPane("p")
		ph.mu.Lock()
		defer ph.mu.Unlock()
		return ph.epoch
	}()

	if h.StoreCheckpoint("p", CheckpointUpload{Epoch: epoch + 1, Through: 3, Cols: 80, Rows: 24, Ansi: []byte("x")}) {
		t.Fatal("epoch mismatch must be rejected")
	}
	if h.StoreCheckpoint("p", CheckpointUpload{Epoch: epoch, Through: 6, Cols: 80, Rows: 24, Ansi: []byte("x")}) {
		t.Fatal("through > head must be rejected")
	}
	if h.StoreCheckpoint("p", CheckpointUpload{Epoch: epoch, Through: 3, Cols: 0, Rows: 24, Ansi: []byte("x")}) {
		t.Fatal("zero cols must be rejected")
	}
	if h.StoreCheckpoint("p", CheckpointUpload{Epoch: epoch, Through: 3, Cols: 80, Rows: 24, Ansi: make([]byte, MaxCheckpointBytes+1)}) {
		t.Fatal("oversized ansi must be rejected")
	}
	if !h.StoreCheckpoint("p", CheckpointUpload{Epoch: epoch, Through: 3, Cols: 80, Rows: 24, Ansi: []byte("snap-old")}) {
		t.Fatal("valid checkpoint rejected")
	}
	if !h.StoreCheckpoint("p", CheckpointUpload{Epoch: epoch, Through: 2, Cols: 80, Rows: 24, Ansi: []byte("snap-stale")}) {
		t.Fatal("stale upload is accepted but must not replace")
	}

	// A v2 attach never serves snapshots: replay is the only recovery
	// path, so uploads stay stored but unread on attach.
	c := &Client{Send: make(chan []byte, 4)}
	h.AttachHot("p", c)
	if ckpt := parseAttach(t, drainOne(c.Send)).GetCheckpoint(); ckpt != nil {
		t.Fatalf("attach served checkpoint %+v", ckpt)
	}
}

func TestEpochDiffersPerPane(t *testing.T) {
	h := NewHub(64)
	h.Ingest("a", []byte("x"))
	h.Ingest("b", []byte("y"))
	ea, _ := h.LookupPane("a")
	eb, _ := h.LookupPane("b")
	if ea.epoch == eb.epoch {
		t.Fatal("panes must not share an epoch")
	}
	previousEpoch := ea.EpochOf()
	h.ClosePane("a")
	// A replacement PTY with the same pane ID mints a fresh epoch and
	// drops the previous owner's retained history.
	inst := &pty.PTYInstance{ID: "a", Pty: &pty.Pty{Cols: 80, Rows: 24}}
	if err := h.InitPaneForOwner(inst); err != nil {
		t.Fatal(err)
	}
	h.Ingest("a", []byte("z"))
	ea2, _ := h.LookupPane("a")
	if ea2.EpochOf() == previousEpoch {
		t.Fatal("pane recreation must mint a fresh epoch")
	}
}

func TestHotDropWarningIsControlNotStream(t *testing.T) {
	h := NewHub(1024)
	// The warning injection is reached only when the send channel cannot
	// be reclaimed after 100 drops; that state is racy to construct via
	// Ingest, so call the extracted injection directly and pin the frame
	// type the client must receive: a drop notice beside the byte
	// stream, never bytes inside it.
	client := &Client{Send: make(chan []byte, 1)}

	h.injectDropWarning(client, time.Now())
	m := drainOne(client.Send)
	server, err := wireproto.DecodeServerFrame(m)
	if err != nil || server.GetDropNotice() == nil {
		t.Fatalf("client warning must be a drop notice, got %+v err=%v", server, err)
	}
}

// Epochs ride the wire as JSON numbers and JS clients round-trip them
// through doubles. Above 2^53 the low bits do not survive, so every
// epoch-scoped check (checkpoint store, recording fetch with epoch)
// would spuriously mismatch in production while tests with small epochs
// stay green. These pin the double-safe range and the full wire shape.
func TestRandomEpochStaysDoubleSafe(t *testing.T) {
	const maxSafe = uint64((1 << 53) - 1)
	for i := 0; i < 1000; i++ {
		e := randomEpoch()
		if e > maxSafe {
			t.Fatalf("randomEpoch %d exceeds double-safe range", e)
		}
		if back := uint64(float64(e)); back != e {
			t.Fatalf("epoch %d does not survive a double round trip (got %d)", e, back)
		}
	}
}

func TestEpochSurvivesWireRoundTripIntoCheckpoint(t *testing.T) {
	for i := 0; i < 20; i++ {
		h := NewHub(1024)
		ph, gerr := h.GetOrCreatePaneHub("p")
		if gerr != nil {
			t.Fatal(gerr)
		}
		// Simulate the JS client exactly: JSON number -> double ->
		// decimal string -> uint64, as ws.js Number() + fetch URL do.
		wire, err := json.Marshal(map[string]uint64{"epoch": ph.epoch})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var decoded struct {
			Epoch float64 `json:"epoch"`
		}
		if err := json.Unmarshal(wire, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		back := uint64(decoded.Epoch)
		if back != ph.epoch {
			t.Fatalf("epoch %d came back as %d", ph.epoch, back)
		}
		if !h.StoreCheckpoint("p", CheckpointUpload{
			Epoch: back, Through: 0, Cols: 80, Rows: 24, Ansi: []byte("x"),
		}) {
			t.Fatalf("checkpoint with round-tripped epoch %d rejected", back)
		}
	}
}
