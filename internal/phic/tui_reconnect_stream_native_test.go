//go:build cgo && (((darwin || linux) && (amd64 || arm64)) || (windows && amd64))

package phic

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestNativeReconnectMatchesUninterruptedByteStream(t *testing.T) {
	for name, program := range map[string]string{
		"normal":       "prefix \x1b[38;2;200;50;10m你🙂 RED\x1b[0m\r\nnext",
		"alternate":    "before\r\n\x1b[?1049h\x1b[2J\x1b[3;4H你🙂\x1b[?1049l after",
		"continuation": "A\x1b]0;title\x07\x1b(0lqqk\x1b(B\x1b[31m你\x1b[0mB",
	} {
		t.Run(name, func(t *testing.T) {
			source := []byte(program)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				serveReviewRecording(w, r, source, [][3]uint64{{0, 80, 12}})
			}))
			defer srv.Close()
			p := &paneActor{ctx: t.Context(), api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}, cols: 80, rows: 12, conn: &websocket.Conn{}, outbox: make(chan paneWrite, 1)}
			var err error
			p.emu, err = p.newTerminal(80, 12)
			if err != nil {
				t.Fatal(err)
			}
			defer p.emu.Close()
			reference, err := termemu.NewGhostty(termemu.Options{Cols: 80, Rows: 12, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
			if err != nil {
				t.Fatal(err)
			}
			defer reference.Close()
			for i := range source {
				// One missing byte recovered per attachment, including every UTF-8
				// and escape-sequence boundary. No scheduler sleeps or screen polling.
				if err := p.bootstrap(wireAttach{Header: wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(i + 1)}}); err != nil {
					t.Fatal(err)
				}
				<-p.outbox // Every bootstrap must admit its final sizing.
				if err := reference.Feed(source[i:i+1], termemu.SourceLive); err != nil {
					t.Fatal(err)
				}
				got, err := p.emu.Snapshot()
				if err != nil {
					t.Fatal(err)
				}
				want, err := reference.Snapshot()
				if err != nil {
					t.Fatal(err)
				}
				if got.Cursor != want.Cursor || got.Alt != want.Alt || got.History != want.History || !reflect.DeepEqual(got.Cells, want.Cells) {
					t.Fatalf("state diverged after source byte %d: got %q want %q", i, frameText(got), frameText(want))
				}
				if p.frontier != uint64(i+1) {
					t.Fatal("incorrect admitted frontier")
				}
			}
			// A duplicate/overlap can never repaint the accepted prefix.
			if err := p.handleFrame(wireproto.EncodeLiveOutputFrame(0, source)); err != nil {
				t.Fatal(err)
			}
			got, _ := p.emu.Snapshot()
			want, _ := reference.Snapshot()
			if !reflect.DeepEqual(got.Cells, want.Cells) {
				t.Fatal("duplicate frame changed terminal")
			}
		})
	}
}

func TestNativeReplayGridIsRestoredToPanelEvenWhenDesiredSizeDidNotChange(t *testing.T) {
	p := &paneActor{ctx: t.Context(), cols: 20, rows: 4, conn: &websocket.Conn{}, outbox: make(chan paneWrite, 1)}
	var err error
	p.emu, err = p.newTerminal(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer p.emu.Close()
	if err := p.feedRecording(wireproto.RecordingHeader{Resizes: [][3]uint64{{0, 40, 8}}}, nil, termemu.SourceReplay); err != nil {
		t.Fatal(err)
	}
	if err := p.handleInput(paneInput{Kind: paneInputResize, Cols: 20, Rows: 4}); err != nil {
		t.Fatal(err)
	}
	frame, err := p.emu.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if frame.Cols != 20 || frame.Rows != 4 {
		t.Fatal("replayed geometry bypassed panel fit")
	}
	if string((<-p.outbox).bytes) != string(wireproto.EncodeResizeFrame(20, 4)) {
		t.Fatal("backend retained replay geometry")
	}
}

func TestNativeZeroEpochReplacementStartsANewParser(t *testing.T) {
	source := []byte("NEW")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { serveReviewRecording(w, r, source, nil) }))
	defer srv.Close()
	p := &paneActor{ctx: t.Context(), api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}, cols: 80, rows: 12, conn: &websocket.Conn{}, outbox: make(chan paneWrite, 1)}
	var err error
	p.emu, err = p.newTerminal(80, 12)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = p.emu.Close() }()
	if err := p.bootstrap(wireAttach{Header: wireproto.AttachHeadHeader{Epoch: 0}}); err != nil {
		t.Fatal(err)
	}
	<-p.outbox
	if err := p.handleFrame(wireproto.EncodeLiveOutputFrame(0, []byte("OLD"))); err != nil {
		t.Fatal(err)
	}
	if err := p.bootstrap(wireAttach{Header: wireproto.AttachHeadHeader{Epoch: 7, Head: 3}}); err != nil {
		t.Fatal(err)
	}
	<-p.outbox
	frame, err := p.emu.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if frameText(frame) != "NEW" || p.frontier != 3 {
		t.Fatal("epoch zero acted as unattached and mixed two pane lifetimes")
	}
}

func TestPaneDialNegotiatesNativeDeflateAndPreservesRawFrame(t *testing.T) {
	source := bytes.Repeat([]byte("\x1b[31m你🙂 scroll\x1b[0m\r\n"), 4096)
	negotiated := make(chan bool, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		negotiated <- bytes.Contains([]byte(r.Header.Get("Sec-WebSocket-Extensions")), []byte("permessage-deflate"))
		up := websocket.Upgrader{EnableCompression: true}
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7}, nil))
		_ = conn.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(0, source))
		_, _, _ = conn.ReadMessage()
	}))
	defer srv.Close()
	p := &paneActor{api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}}
	conn, _, err := p.dial(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if !<-negotiated {
		t.Fatal("phic did not negotiate transport compression")
	}
	_, frame, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	from, data, err := ParseLiveOutput(frame)
	if err != nil || from != 0 || !bytes.Equal(data, source) {
		t.Fatal("native decompression changed output bytes")
	}
}
