package ws

// Terminal protocol invariants. These tests pin the
// server contracts the plan calls non-negotiable.
//
//   - attach is atomic: a client gets an attach frame with the head H and
//     then only output frames with start >= H (no gap, no dupes);
//   - seq accounting is exact across ring wraparound;
//   - the recording endpoint view matches the bytes the live stream
//     carried, including resize marker ordering;
//   - checkpoints are opaque, bounded, and newest-wins.

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

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
	h := NewHub(8)                    // tiny ring forces wrap
	h.Ingest("p", []byte("12345678")) // total=8, oldest=0
	h.Ingest("p", []byte("9ABCDEF"))  // total=15, oldest=7

	rec, ok := h.Recording("p", 0, 100)
	if !ok {
		t.Fatal("recording failed")
	}
	if rec.Start != 0 || rec.End != 15 {
		t.Fatalf("recording span [%d,%d), want [0,15)", rec.Start, rec.End)
	}
	if string(rec.Data) != "123456789ABCDEF" {
		t.Fatalf("recording data = %q; replay eviction must not delete history", rec.Data)
	}

	// Partial range inside the retained window.
	rec2, _ := h.Recording("p", 9, 12)
	if rec2.Start != 9 || rec2.End != 12 || string(rec2.Data) != "ABC" {
		t.Fatalf("partial recording = %+v %q", rec2, rec2.Data)
	}

	// from beyond head is an error.
	if _, ok := h.Recording("p", 16, 20); ok {
		t.Fatal("recording from beyond head must fail")
	}
}

func TestRecordResizeMarkersOrderAgainstOutput(t *testing.T) {
	h := NewHub(1024)
	h.Ingest("p", []byte("aaaa")) // 0..4
	h.RecordResize("p", 80, 24)
	h.Ingest("p", []byte("bb")) // 4..6
	h.RecordResize("p", 120, 40)
	h.RecordResize("p", 120, 40) // duplicate suppressed
	h.Ingest("p", []byte("cc"))  // 6..8

	rec, _ := h.Recording("p", 0, 8)
	if len(rec.Resizes) != 2 {
		t.Fatalf("want 2 markers (dup suppressed), got %+v", rec.Resizes)
	}
	if rec.Resizes[0].AtSeq != 4 || rec.Resizes[0].Cols != 80 || rec.Resizes[0].Rows != 24 {
		t.Fatalf("marker[0] = %+v", rec.Resizes[0])
	}
	if rec.Resizes[1].AtSeq != 6 || rec.Resizes[1].Cols != 120 {
		t.Fatalf("marker[1] = %+v", rec.Resizes[1])
	}

	// A range also carries the geometry already in force at its start.
	rec2, _ := h.Recording("p", 5, 8)
	if len(rec2.Resizes) != 2 || rec2.Resizes[0].AtSeq != 4 || rec2.Resizes[1].AtSeq != 6 {
		t.Fatalf("range markers = %+v", rec2.Resizes)
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

	// AttachHot must hand the newest snapshot through, verbatim.
	c := &Client{Send: make(chan []byte, 4)}
	h.AttachHot("p", c)
	ckpt := parseAttach(t, drainOne(c.Send)).GetCheckpoint()
	if ckpt == nil || ckpt.GetThrough() != 3 || len(ckpt.GetData()) != len("snap-old") {
		t.Fatalf("ckpt = %+v", ckpt)
	}
	if string(ckpt.GetData()) != "snap-old" {
		t.Fatalf("ckpt ansi = %q", ckpt.GetData())
	}
}

func TestAttachHeadDropsCheckpointBelowRetentionFloor(t *testing.T) {
	h := NewHub(8)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatalf("SetRecordingDirectory: %v", err)
	}
	h.Ingest("p", []byte("0123456789"))
	ph, ok := h.LookupPane("p")
	if !ok {
		t.Fatal("pane missing")
	}
	ph.mu.Lock()
	epoch := ph.epoch
	ph.mu.Unlock()
	if !h.StoreCheckpoint("p", CheckpointUpload{Epoch: epoch, Through: 10, Cols: 80, Rows: 24, Ansi: []byte("snap-old")}) {
		t.Fatal("valid checkpoint rejected")
	}
	// Rotate the retained window well past the stored checkpoint.
	chunk := bytes.Repeat([]byte("A"), 64<<10)
	for i := 0; i < int(retentionHistoryCap)/len(chunk)+40; i++ {
		h.Ingest("p", chunk)
	}
	ph.mu.Lock()
	pos := ph.positionLocked()
	ph.mu.Unlock()
	if pos.Oldest <= 10 {
		t.Fatalf("floor did not pass the checkpoint: %+v", pos)
	}
	c := &Client{Send: make(chan []byte, 4)}
	h.AttachHot("p", c)
	attach := parseAttach(t, drainOne(c.Send))
	if attach.GetCheckpoint() != nil {
		t.Fatalf("attach advertised checkpoint %+v below floor %d", attach.GetCheckpoint(), attach.GetOldest())
	}
	if attach.GetOldest() != pos.Oldest || attach.GetHead() != pos.Head {
		t.Fatalf("attach %+v != position %+v", attach, pos)
	}
	ph.mu.Lock()
	replayFrom := ph.recording.replayStart()
	ph.mu.Unlock()
	if replayFrom != attach.GetReplayFrom() {
		t.Fatalf("ReplayFrom = %d, want %d", attach.GetReplayFrom(), replayFrom)
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
	h.Ingest("a", []byte("z")) // recreates the pane, reusing the journal owner
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
