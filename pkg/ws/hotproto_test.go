package ws

// Hot-v1 protocol invariants (see temp/TERMPERF.md). These tests pin the
// server contracts the plan calls non-negotiable.
//
//   - attach is atomic: a hot client gets ATTACH_HEAD with the head H and
//     then only LIVE_OUTPUT frames with startSeq >= H (no gap, no dupes);
//   - seq accounting is exact across ring wraparound;
//   - the recording endpoint view matches the bytes the live stream
//     carried, including resize marker ordering;
//   - checkpoints are opaque, bounded, and newest-wins.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"testing"
	"time"
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

func parseAttachHead(t *testing.T, frame []byte) (attachHeadJSON, []byte) {
	t.Helper()
	if len(frame) < 5 || frame[0] != 0x08 {
		t.Fatalf("not an ATTACH_HEAD frame: %v", frame)
	}
	n := binary.BigEndian.Uint32(frame[1:5])
	var hdr attachHeadJSON
	if err := json.Unmarshal(frame[5:5+n], &hdr); err != nil {
		t.Fatalf("bad ATTACH_HEAD json: %v", err)
	}
	return hdr, frame[5+n:]
}

func TestAttachHotIsAtomicAndLiveOnly(t *testing.T) {
	h := NewHub(1024)
	h.Ingest("p", []byte("hello"))

	c := &Client{Send: make(chan []byte, 8)}
	h.AttachHot("p", c)

	frame := drainOne(c.Send)
	hdr, extra := parseAttachHead(t, frame)
	if hdr.Head != 5 || hdr.Oldest != 0 || hdr.Ckpt != nil {
		t.Fatalf("bad head position: %+v", hdr)
	}
	if len(extra) != 0 {
		t.Fatalf("no checkpoint expected, got %d extra bytes", len(extra))
	}
	mustNotArrive(t, c.Send) // no replay, no 0x06

	// Live output after attach must start exactly at head.
	h.Ingest("p", []byte(" world"))
	live := drainOne(c.Send)
	if live == nil || live[0] != 0x09 {
		t.Fatalf("expected 0x09 LIVE_OUTPUT, got %v", live)
	}
	if got := binary.BigEndian.Uint64(live[1:9]); got != 5 {
		t.Fatalf("live startSeq = %d, want 5", got)
	}
	if string(live[9:]) != " world" {
		t.Fatalf("live payload = %q", live[9:])
	}

	// Second ingest continues contiguously.
	h.Ingest("p", []byte("!"))
	live2 := drainOne(c.Send)
	if got := binary.BigEndian.Uint64(live2[1:9]); got != 11 {
		t.Fatalf("second live startSeq = %d, want 11", got)
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
	if rec.Start != 7 || rec.End != 15 {
		t.Fatalf("recording span [%d,%d), want [7,15)", rec.Start, rec.End)
	}
	if string(rec.Data) != "89ABCDEF" {
		t.Fatalf("recording data = %q, want 89ABCDEF (8 retained bytes clamped to oldest)", rec.Data)
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

func TestRecordingMatchesLegacyReplay(t *testing.T) {
	h := NewHub(1024)
	payload := bytes.Repeat([]byte("x"), 100)
	h.Ingest("p", payload)

	legacy := &Client{Send: make(chan []byte, 16)}
	h.AttachWithReplay("p", legacy)
	var replay bytes.Buffer
	for {
		m := drainOne(legacy.Send)
		if m == nil {
			break
		}
		if m[0] == 0x01 {
			replay.Write(m[1:])
		}
	}
	rec, _ := h.Recording("p", 0, 1<<62)
	if !bytes.Equal(replay.Bytes(), rec.Data) {
		t.Fatalf("recording %d bytes != legacy replay %d bytes", len(rec.Data), replay.Len())
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

	// Range filters markers.
	rec2, _ := h.Recording("p", 5, 8)
	if len(rec2.Resizes) != 1 || rec2.Resizes[0].AtSeq != 6 {
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
	hdr, extra := parseAttachHead(t, drainOne(c.Send))
	if hdr.Ckpt == nil || hdr.Ckpt.Through != 3 || hdr.Ckpt.Len != len("snap-old") {
		t.Fatalf("ckpt header = %+v", hdr.Ckpt)
	}
	if string(extra) != "snap-old" {
		t.Fatalf("ckpt ansi = %q", extra)
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
	h.ClosePane("a")
	h.Ingest("a", []byte("z")) // recreates the pane
	ea2, _ := h.LookupPane("a")
	if ea2.epoch == ea.epoch {
		t.Fatal("pane recreation must mint a fresh epoch")
	}
}

func TestHotDropWarningIsControlNotStream(t *testing.T) {
	h := NewHub(1024)
	// The warning injection is reached only when the send channel cannot
	// be reclaimed after 100 drops; that state is racy to construct via
	// Ingest, so call the extracted injection directly and pin the frame
	// type each client mode must receive.
	hot := &Client{Send: make(chan []byte, 1)}
	hot.Hot = true
	legacy := &Client{Send: make(chan []byte, 1)}

	h.injectDropWarning(hot, time.Now())
	m := drainOne(hot.Send)
	if m == nil || m[0] != 0x02 {
		t.Fatalf("hot client warning must be a 0x02 control frame, got %v", m)
	}
	var v map[string]string
	n := binary.BigEndian.Uint32(m[1:5])
	if err := json.Unmarshal(m[5:5+n], &v); err != nil || v["type"] != "output-dropped" {
		t.Fatalf("hot warning payload = %q err=%v", m[5:5+n], err)
	}

	h.injectDropWarning(legacy, time.Now())
	m = drainOne(legacy.Send)
	if m == nil || m[0] != 0x01 || !bytes.Contains(m, []byte("output dropped")) {
		t.Fatalf("legacy client warning must stay inline 0x01 text, got %v", m)
	}
}
