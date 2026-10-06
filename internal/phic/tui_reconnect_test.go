package phic

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// TestPaneActorReconnectRetainsCore drops the socket once and proves the same
// emulator keeps both the pre-drop and post-reconnect output with no gaps.
func TestPaneActorReconnectRetainsCore(t *testing.T) {
	first := []byte("one\n")
	second := []byte("two\n")
	var conns atomic.Int32
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/pane/p" {
			http.NotFound(w, r)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		n := conns.Add(1)
		if n == 1 {
			_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: 0}, nil))
			_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(0, first))
			time.Sleep(50 * time.Millisecond)
			return
		}
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(len(first))}, nil))
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(uint64(len(first)), second))
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	events := make(chan paneEvent, 256)
	actor, err := newPaneActor(ctx, mustAPI(t, srv.URL), paneSpec{Key: paneKey{Origin: srv.URL, ID: "p"}, Cols: 40, Rows: 8}, events, stubBuild)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.close()

	waitFor(t, "both retained output spans", func() bool {
		frame, ok := actor.snapshotCopy()
		if !ok {
			return false
		}
		text := frameText(frame)
		return strings.Contains(text, "one") && strings.Contains(text, "two")
	})
	if conns.Load() < 2 {
		t.Fatalf("reconnect never happened: connections = %d", conns.Load())
	}
}

// TestPaneActorEpochChangeRebuilds proves a new recording epoch rebuilds the
// emulator instead of merging two terminal states.
func TestPaneActorEpochChangeRebuilds(t *testing.T) {
	var conns atomic.Int32
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/pane/p" {
			http.NotFound(w, r)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		if conns.Add(1) == 1 {
			_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: 0}, nil))
			_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(0, []byte("old epoch\n")))
			time.Sleep(50 * time.Millisecond)
			return
		}
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 8, Head: 0}, nil))
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(0, []byte("new epoch\n")))
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	events := make(chan paneEvent, 256)
	actor, err := newPaneActor(ctx, mustAPI(t, srv.URL), paneSpec{Key: paneKey{Origin: srv.URL, ID: "p"}, Cols: 40, Rows: 8}, events, stubBuild)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.close()

	waitFor(t, "rebuilt epoch frame", func() bool {
		frame, ok := actor.snapshotCopy()
		if !ok {
			return false
		}
		text := frameText(frame)
		return strings.Contains(text, "new epoch") && !strings.Contains(text, "old epoch")
	})
}
