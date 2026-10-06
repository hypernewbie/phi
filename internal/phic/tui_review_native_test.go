//go:build cgo && (((darwin || linux) && (amd64 || arm64)) || (windows && amd64))

package phic

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func serveReviewRecording(w http.ResponseWriter, r *http.Request, b []byte, resizes [][3]uint64) {
	from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
	end, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
	end = min(end, uint64(len(b)))
	var sizes [][3]uint64
	for _, s := range resizes {
		if s[0] <= end {
			sizes = append(sizes, s)
		}
	}
	hdr, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: end, Resizes: sizes})
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
	_, _ = w.Write(size[:])
	_, _ = w.Write(hdr)
	_, _ = w.Write(b[from:end])
}

func TestReviewNativeExitDrainsUnannouncedFinalBytes(t *testing.T) {
	first := []byte("first\r\n")
	all := append(append([]byte{}, first...), []byte("LAST-RETAINED\r\n")...)
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/recording") {
			serveReviewRecording(w, r, all, nil)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7}, nil))
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(0, first))
		_ = ws.WriteMessage(websocket.BinaryMessage, []byte{wireproto.FrameExit, 3})
		for {
			if _, _, err = ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()
	ev := make(chan paneEvent, 64)
	p, err := newPaneActor(t.Context(), mustAPI(t, srv.URL), paneSpec{Key: paneKey{Origin: srv.URL, ID: "p"}, Cols: 50, Rows: 8}, ev, termemu.NewGhostty)
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	exit := waitPaneEvent(t, ev, paneExited)
	f, ok := p.snapshotCopy()
	frontier, _, _, _, _, _ := p.state()
	if !ok || exit.Code != 3 || frontier != uint64(len(all)) || !strings.Contains(frameText(f), "LAST-RETAINED") {
		t.Fatalf("exit failed: code=%d frontier=%d frame=%q", exit.Code, frontier, frameText(f))
	}
}

func TestReviewNativeReplayUsesRecordedGeometryAndFreshReplies(t *testing.T) {
	a := []byte("abcdefghijklmnop\r\n\x1b[2;1HOLD")
	b := []byte("\x1b[3;1HNEW\x1b[6n")
	all := append(append([]byte{}, a...), b...)
	sizes := [][3]uint64{{0, 8, 4}, {uint64(len(a)), 12, 6}}
	up := websocket.Upgrader{}
	inputs := make(chan string, 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/recording") {
			serveReviewRecording(w, r, all, sizes)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(len(all))}, nil))
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if len(data) > 0 && data[0] == wireproto.FrameInput {
				inputs <- string(data[1:])
			}
		}
	}))
	defer srv.Close()
	ev := make(chan paneEvent, 64)
	p, err := newPaneActor(t.Context(), mustAPI(t, srv.URL), paneSpec{Key: paneKey{Origin: srv.URL, ID: "p"}, Cols: 20, Rows: 8, Fresh: true}, ev, termemu.NewGhostty)
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	waitPaneEvent(t, ev, paneStatus)
	ref, err := termemu.NewGhostty(termemu.Options{Cols: 8, Rows: 4, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
	if err != nil {
		t.Fatal(err)
	}
	defer ref.Close()
	_ = ref.Feed(a, termemu.SourceReplay)
	_ = ref.Resize(12, 6)
	_ = ref.Feed(b, termemu.SourceReplay)
	_ = ref.Resize(20, 8)
	want, _ := ref.Snapshot()
	got, ok := p.snapshotCopy()
	if !ok || frameText(got) != frameText(want) || got.Cursor != want.Cursor {
		t.Fatalf("geometry replay mismatch\ngot=%q cursor=%+v\nwant=%q cursor=%+v", frameText(got), got.Cursor, frameText(want), want.Cursor)
	}
	select {
	case reply := <-inputs:
		if reply != "\x1b[3;4R" {
			t.Fatalf("startup reply=%q", reply)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("fresh startup query lost")
	}
}

func TestReviewNativeUnfinishedReplayQueryDoesNotSwallowNewQueries(t *testing.T) {
	var replies []string
	emu, err := termemu.NewGhostty(termemu.Options{Cols: 20, Rows: 8, ScrollbackBytes: 1 << 20, ScrollbackLines: 100, Events: termemu.EventOptions{OnReply: func(b []byte) { replies = append(replies, string(b)) }}})
	if err != nil {
		t.Fatal(err)
	}
	defer emu.Close()
	_ = emu.Feed([]byte("\x1b[6"), termemu.SourceReplay)
	_ = emu.Feed([]byte("n\x1b[6n"), termemu.SourceLive)
	if strings.Join(replies, "") != "\x1b[1;1R\x1b[1;1R" {
		t.Fatalf("unseen query completion/new query lost: %q", replies)
	}
}
