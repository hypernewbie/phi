package phic

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestReconnectRecoversMissedBytesWithoutDuplicatesAndDrainsExit(t *testing.T) {
	for _, exitCode := range []byte{0, 17} {
		t.Run(fmt.Sprint(exitCode), func(t *testing.T) {
			prefix := []byte("PREFIX\r\n")
			first := []byte("FIRST\r\n")
			missed := []byte("MISSED\r\n")
			last := []byte("LAST\r\n")
			source := append(append(append(append([]byte{}, prefix...), first...), missed...), last...)
			var connections atomic.Int64
			var unavailable atomic.Bool
			up := websocket.Upgrader{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/ws/pane/p" {
					ws, err := up.Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer ws.Close()
					n := connections.Add(1)
					head := len(prefix)
					if n > 1 {
						head += len(first) + len(missed)
					}
					_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(head)}, nil))
					if n == 1 {
						_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(uint64(head), first))
						_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1001, "offline"), time.Now().Add(time.Second))
					} else {
						// Overlap replay's written boundary; duplicate bytes must not repaint.
						_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(uint64(head-2), source[head-2:]))
						_ = ws.WriteMessage(websocket.BinaryMessage, []byte{4, exitCode})
					}
					for {
						if _, _, err := ws.ReadMessage(); err != nil {
							return
						}
					}
				} else {
					from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
					through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
					if from == uint64(len(prefix)+len(first)) && !unavailable.Swap(true) {
						http.Error(w, "retry later", 503)
						return
					}
					if through > uint64(len(source)) {
						through = uint64(len(source))
					}
					h, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: through})
					var size [4]byte
					binary.BigEndian.PutUint32(size[:], uint32(len(h)))
					_, _ = w.Write(size[:])
					_, _ = w.Write(h)
					_, _ = w.Write(source[from:through])
				}
			}))
			defer srv.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			output := &shortTerminal{}
			relay := NewRelay(output, mustAPI(t, srv.URL))
			if _, err := relay.Connect(ctx, "p"); err != nil {
				t.Fatal(err)
			}
			err := relay.Run(ctx)
			if exitCode == 0 && err != nil {
				t.Fatal(err)
			}
			if exitCode != 0 {
				var exit *ExitError
				if !errors.As(err, &exit) || exit.Code != int(exitCode) {
					t.Fatalf("backend exit status lost: %v", err)
				}
			}
			if !bytes.Equal(output.Bytes(), source) || relay.written != uint64(len(source)) {
				t.Fatalf("reconnect corrupted source: output=%q frontier=%d want=%q", output.Bytes(), relay.written, source)
			}
			if connections.Load() != 2 || !unavailable.Load() {
				t.Fatalf("scenario never exercised reconnect/retry: connections=%d retry=%t", connections.Load(), unavailable.Load())
			}
		})
	}
}
