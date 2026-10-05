//go:build unix

package phic

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestReviewRelayRecoversPrefixAndGapAndStopsOnIdleCancel(t *testing.T) {
	prefix := bytes.Repeat([]byte("retained\r\n"), 240000)
	gap := []byte("GAP\r\n")
	live := []byte("LIVE\r\n")
	source := append(append(append([]byte{}, prefix...), gap...), live...)
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()
	if err := setSlaveRaw(slave); err != nil {
		t.Fatal(err)
	}
	if err := pty.Setsize(slave, &pty.Winsize{Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	tape := startPtyReader(master)
	connected := make(chan *websocket.Conn, 1)
	up := websocket.Upgrader{}
	var requests atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/ws/pane/p" {
			ws, err := up.Upgrade(w, req, nil)
			if err != nil {
				return
			}
			connected <- ws
			defer ws.Close()
			_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(len(prefix))}, nil))
			_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(uint64(len(prefix)+len(gap)), live))
			for {
				if _, _, err := ws.ReadMessage(); err != nil {
					return
				}
			}
		} else if req.URL.Path == "/api/terminals/p/recording" {
			requests.Add(1)
			from, _ := strconv.ParseUint(req.URL.Query().Get("from"), 10, 64)
			through, _ := strconv.ParseUint(req.URL.Query().Get("through"), 10, 64)
			if through-from > 2<<20 {
				t.Errorf("unbounded range: %d", through-from)
			}
			hdr, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: through, Resizes: [][3]uint64{{from, 80, 24}}})
			var size [4]byte
			binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
			_, _ = w.Write(size[:])
			_, _ = w.Write(hdr)
			_, _ = w.Write(source[from:through])
		} else {
			http.NotFound(w, req)
		}
	}))
	defer srv.Close()
	tty := &TTY{fd: int(slave.Fd()), raw: true}
	relay := NewRelay(tty, mustAPI(t, srv.URL))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := relay.Connect(ctx, "p"); err != nil {
		t.Fatal(err)
	}
	ws := <-connected
	defer ws.Close()
	done := make(chan error, 1)
	go func() { done <- relay.Run(ctx) }()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(tape.snapshot()) < len(source) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := tape.snapshot(); !bytes.Equal(got, source) {
		t.Errorf("retained bytes missing/duplicated: got %d want %d", len(got), len(source))
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Error("idle cancel left relay blocked in terminal read")
		_, _ = master.Write([]byte{0})
		relay.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("relay did not stop after forced input")
		}
	}
	if requests.Load() == 0 {
		t.Error("recording was never requested")
	}
}
