package phic

import (
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestPaneReconnectSendsResizeEvenWithoutDeltaOrGeometryChange(t *testing.T) {
	var mu sync.Mutex
	var sizes [][2]uint16
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7}, nil))
		for {
			_, frame, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if len(frame) != 5 || frame[0] != wireproto.FrameResize {
				continue
			}
			mu.Lock()
			sizes = append(sizes, [2]uint16{binary.BigEndian.Uint16(frame[1:3]), binary.BigEndian.Uint16(frame[3:5])})
			first := len(sizes) == 1
			mu.Unlock()
			if first {
				return
			} // Force a genuine disconnect after confirmed sizing.
		}
	}))
	defer srv.Close()
	actor, err := newPaneActor(t.Context(), mustAPI(t, srv.URL), paneSpec{Key: paneKey{ID: "p", Origin: srv.URL}, Cols: 88, Rows: 32}, nil, stubBuild)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.close()
	waitFor(t, "resize on initial connection and resumed connection", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(sizes) >= 2
	})
	mu.Lock()
	defer mu.Unlock()
	if sizes[0] != [2]uint16{88, 32} || sizes[1] != [2]uint16{88, 32} {
		t.Fatalf("wrong resume geometry: %+v", sizes)
	}
}
