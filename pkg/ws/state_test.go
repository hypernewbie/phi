package ws

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/hypernewbie/phi/internal/termstate"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestBoundedStateRetainsRequestedBooks(t *testing.T) {
	h := NewHub(4096)
	source := bytes.Repeat([]byte("\x1b[32mBOOK 你🙂\x1b[0m\r\n"), 100000)
	if err := h.Ingest("books", source); err != nil {
		t.Fatal(err)
	}
	pos, state, cols, rows, err := h.State("books")
	if err != nil {
		t.Fatal(err)
	}
	if len(state) > len(source)/20 {
		t.Fatalf("bounded state is %d of %d bytes", len(state), len(source))
	}
	if cols != 80 || rows != 24 || pos.Head != uint64(len(source)) {
		t.Fatal("state position/geometry mismatch")
	}
	ph, _ := h.LookupPane("books")
	ph.mu.Lock()
	floor := int(ph.recording.floor())
	ph.mu.Unlock()
	// Asking for a retained book returns its exact bytes, in shuffled
	// order, even though the live parser has evicted all but its recent
	// presentation.
	midWindow := floor + (len(source)-floor)/2
	for _, from := range []int{len(source) - 4096, floor + 1024, midWindow, len(source) - 512} {
		got, ok := h.Recording("books", uint64(from), uint64(from+512))
		if !ok || !bytes.Equal(got.Data, source[from:from+512]) {
			t.Fatalf("book unavailable at %d (floor %d)", from, floor)
		}
	}
	// A span starting in evicted history clamps to the floor; a span
	// wholly below it is gone.
	clamped, ok := h.Recording("books", 0, uint64(len(source)))
	if !ok || clamped.Start != uint64(floor) || !bytes.Equal(clamped.Data, source[floor:]) {
		t.Fatal("evicted prefix did not clamp to the retained floor")
	}
	if _, ok := h.Recording("books", 0, 1024); ok {
		t.Fatal("wholly evicted span unexpectedly readable")
	}
	client := &Client{NativeState: true, Send: make(chan []byte, 4)}
	h.AttachHot("books", client)
	frame := <-client.Send
	if frame[0] != wireproto.FrameAttachHead || len(frame) > len(source)/20 {
		t.Fatal("attach sent the library")
	}
	headerBytes := int(binary.BigEndian.Uint32(frame[1:5]))
	var attach wireproto.AttachHeadHeader
	if err := json.Unmarshal(frame[5:5+headerBytes], &attach); err != nil {
		t.Fatal(err)
	}
	if attach.Ckpt == nil || attach.Ckpt.Through != pos.Head {
		t.Fatal("attach checkpoint lost its source frontier")
	}
	local, err := termstate.New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	if err = local.Restore(frame[5+headerBytes:]); err != nil {
		t.Fatal(err)
	}
	localRows, err := local.HistoryRows()
	if err != nil {
		t.Fatal(err)
	}
	if localRows > 512 {
		t.Fatalf("initial local history exceeds the page-rounded budget: %d rows", localRows)
	}
	if err := h.Ingest("books", []byte("NEWEST")); err != nil {
		t.Fatal(err)
	}
	live := <-client.Send
	if live[0] != wireproto.FrameLiveOutput || !bytes.HasSuffix(live, []byte("NEWEST")) {
		t.Fatal("live update lost after bounded attach")
	}
}

func TestAttachSendsBoundedANSIStateAndPreservesParserContinuation(t *testing.T) {
	h := NewHub(4096)
	source := bytes.Repeat([]byte("\x1b[31mcurrent library line\x1b[0m\r\n"), 10000)
	source = append(source, []byte("\x1b]2;unfinished title")...)
	if err := h.Ingest("ansi", source); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := h.State("ansi"); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("ansi")
	ph.mu.Lock()
	formatted, formatErr := ph.state.FormatVT()
	continuation, continuationErr := ph.state.Continuation()
	ph.mu.Unlock()
	if formatErr != nil || continuationErr != nil {
		t.Fatalf("format=%v continuation=%v", formatErr, continuationErr)
	}
	t.Logf("ansi state=%d continuation=%d", len(formatted), len(continuation))
	client := &Client{AnsiState: true, Send: make(chan []byte, 2)}
	h.AttachHot("ansi", client)
	frame := <-client.Send
	var header wireproto.AttachHeadHeader
	if err := json.Unmarshal(frame[5:5+binary.BigEndian.Uint32(frame[1:5])], &header); err != nil {
		t.Fatal(err)
	}
	state := frame[5+binary.BigEndian.Uint32(frame[1:5]):]
	if header.Ckpt == nil || header.Ckpt.Kind != "ansi-v1" || header.Ckpt.Through != uint64(len(source)) {
		t.Fatal("ANSI attach checkpoint frontier mismatch")
	}
	if len(state) > len(source)/10 || !bytes.Contains(state, []byte("current library line")) {
		t.Fatal("attach did not send a bounded current screen")
	}
	if !bytes.HasSuffix(state, []byte("\x1b]2;unfinished title")) {
		t.Fatal("attach dropped the unfinished parser continuation")
	}
	suffix := []byte(" continued\x07LIVE")
	if err := h.Ingest("ansi", suffix); err != nil {
		t.Fatal(err)
	}
	if live := <-client.Send; !bytes.HasSuffix(live, suffix) {
		t.Fatal("live suffix was lost after parser-state transfer")
	}
}

func TestBoundedHistoricalReplayMatchesLiveStateAndResizeOrder(t *testing.T) {
	h := NewHub(4096)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	var source []byte
	var resizeSeq uint64
	for i := 0; i < 96; i++ {
		chunk := bytes.Repeat([]byte(fmt.Sprintf("BOOK-%02d 你🙂\r\n", i)), 2048)
		if i == 90 {
			resizeSeq = uint64(len(source))
			h.RecordResize("paged", 100, 30)
			source = append(source, []byte("\x1b[8;30;100t")...)
		}
		source = append(source, chunk...)
		if err := h.Ingest("paged", chunk); err != nil {
			t.Fatal(err)
		}
	}
	ph, ok := h.LookupPane("paged")
	if !ok {
		t.Fatal("pane absent")
	}
	ph.mu.Lock()
	floor := ph.recording.floor()
	epoch := ph.epoch
	ph.mu.Unlock()
	if resizeSeq <= floor || resizeSeq-4096 <= floor {
		t.Fatalf("resize seq %d not inside retained window above floor %d", resizeSeq, floor)
	}
	render := func(data []byte, cols, rows int) ([]byte, []byte, uint32) {
		e, err := termstate.New(t.Context(), cols, rows)
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
		localRows, err := e.HistoryRows()
		if err != nil {
			t.Fatal(err)
		}
		return screen, continuation, localRows
	}
	livePos, live, _, _, err := h.State("paged")
	if err != nil {
		t.Fatal(err)
	}
	// Historical reconstruction at the head must equal the live parser:
	// same frontier reached through the retained base plus replay.
	pos, restored, cols, rows, err := h.HistoricalState("paged", epoch, livePos.Head)
	if err != nil {
		t.Fatal(err)
	}
	if pos.Head != livePos.Head || cols != 100 || rows != 30 || len(restored) == 0 {
		t.Fatal("historical checkpoint lost geometry/state")
	}
	wantScreen, wantContinuation, _ := render(live, 80, 24)
	gotScreen, gotContinuation, _ := render(restored, cols, rows)
	if !bytes.Equal(gotScreen, wantScreen) || !bytes.Equal(gotContinuation, wantContinuation) {
		t.Fatal("historical reconstruction diverged from live parser/screen state")
	}
	// Geometry flips exactly at the retained resize position.
	_, _, preCols, preRows, err := h.HistoricalState("paged", epoch, resizeSeq-4096)
	if err != nil {
		t.Fatal(err)
	}
	if preCols != 80 || preRows != 24 {
		t.Fatalf("pre-resize geometry=%dx%d", preCols, preRows)
	}
	_, mid, midCols, midRows, err := h.HistoricalState("paged", epoch, resizeSeq)
	if err != nil {
		t.Fatal(err)
	}
	if midCols != 100 || midRows != 30 {
		t.Fatalf("resize geometry=%dx%d", midCols, midRows)
	}
	_, _, localRows := render(mid, midCols, midRows)
	if localRows > historyCheckpointRows+256 {
		t.Fatalf("requested history response is not row bounded: %d", localRows)
	}
	// A position below the floor is gone, not reconstructed.
	if _, _, _, _, err := h.HistoricalState("paged", epoch, floor-1); err != ErrStatePositionMismatch {
		t.Fatalf("evicted position: %v", err)
	}
}

func TestHistoricalStateDoesNotReplaceLiveState(t *testing.T) {
	h := NewHub(4096)
	first := bytes.Repeat([]byte("OLD\r\n"), 2000)
	if err := h.Ingest("p", first); err != nil {
		t.Fatal(err)
	}
	pos, before, _, _, err := h.State("p")
	if err != nil {
		t.Fatal(err)
	}
	historic, snapshot, _, _, err := h.HistoricalState("p", pos.Epoch, 4096)
	if err != nil || historic.Head != 4096 || len(snapshot) == 0 {
		t.Fatal("requested history failed", err)
	}
	after, latest, _, _, err := h.State("p")
	if err != nil || after.Head != pos.Head || !bytes.Equal(latest, before) {
		t.Fatal("history altered live state", err)
	}
}
