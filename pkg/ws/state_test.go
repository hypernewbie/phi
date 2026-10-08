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
	// Asking for a book returns its exact bytes, in shuffled order, even
	// though the live parser has evicted all but its recent presentation.
	for _, from := range []int{len(source) - 4096, 0, len(source) / 2, 1024} {
		got, ok := h.Recording("books", uint64(from), uint64(from+512))
		if !ok || !bytes.Equal(got.Data, source[from:from+512]) {
			t.Fatalf("book unavailable at %d", from)
		}
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

func TestStateAnchorsBoundHistoricalReplayAndPreserveResizeOrder(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	var source []byte
	for i := 0; i < 96; i++ {
		chunk := bytes.Repeat([]byte(fmt.Sprintf("BOOK-%02d 你🙂\r\n", i)), 2048)
		if i == 50 {
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
	anchors := append([]stateAnchor(nil), ph.stateAnchors...)
	ph.mu.Unlock()
	if len(anchors) < 2 || len(anchors) > stateAnchorCount {
		t.Fatalf("unexpected anchor count: %d", len(anchors))
	}
	through := anchors[len(anchors)-1].through
	if through >= uint64(len(source)) {
		t.Fatal("anchor unexpectedly points past source")
	}
	pos, restored, cols, rows, err := h.HistoricalState("paged", ph.epoch, through)
	if err != nil {
		t.Fatal(err)
	}
	if pos.Head != through || cols != 100 || rows != 30 || len(restored) == 0 {
		t.Fatal("historical checkpoint lost geometry/state")
	}
	// Compare the requested anchor with the live parser restored directly from
	// the same compressed record; no complete recording fetch is involved.
	raw, err := restoreAnchor(anchors[len(anchors)-1].compressed)
	if err != nil {
		t.Fatal(err)
	}
	e, err := termstate.New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.Restore(raw); err != nil {
		t.Fatal(err)
	}
	loaded, err := termstate.New(t.Context(), cols, rows)
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.Close()
	if err = loaded.Restore(restored); err != nil {
		t.Fatal(err)
	}
	wantScreen, err := e.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	gotScreen, err := loaded.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	wantContinuation, err := e.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	gotContinuation, err := loaded.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotScreen, wantScreen) || !bytes.Equal(gotContinuation, wantContinuation) {
		t.Fatal("anchor reconstruction diverged from source parser/screen state")
	}
	localRows, err := loaded.HistoryRows()
	if err != nil {
		t.Fatal(err)
	}
	if localRows > historyCheckpointRows+256 {
		t.Fatalf("requested history response is not row bounded: %d", localRows)
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
