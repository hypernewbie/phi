package phic

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestReturningDeliversQueriesIssuedWhileAwayButNotSeenQueries(t *testing.T) {
	for _, tc := range []struct{ name, old, fresh string }{
		{"cursor report", "SEEN\x1b[6n", "UNSEEN\x1b[6n"},
		{"color query", "SEEN\x1b]11;?\a", "UNSEEN\x1b]11;?\a"},
		{"UTF8 and split cursor command", "SEEN\x1b[31", "mUNSEEN\x1b[6n"},
		{"request incomplete before menu", "SEEN\x1b[6", "nUNSEEN"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := []byte(tc.old + tc.fresh)
			up := websocket.Upgrader{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/ws/pane/p" {
					ws, err := up.Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer ws.Close()
					_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: uint64(len(source))}, nil))
					_ = ws.WriteMessage(websocket.BinaryMessage, []byte{4, 0})
					for {
						if _, _, err := ws.ReadMessage(); err != nil {
							return
						}
					}
				} else {
					from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
					through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
					if through > uint64(len(source)) {
						through = uint64(len(source))
					}
					hdr, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: from, End: through})
					var size [4]byte
					binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
					_, _ = w.Write(size[:])
					_, _ = w.Write(hdr)
					_, _ = w.Write(source[from:through])
				}
			}))
			defer srv.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			output := &shortTerminal{}
			relay := NewRelay(output, mustAPI(t, srv.URL))
			relay.previous = &recordingCursor{epoch: 7, through: uint64(len(tc.old))}
			if _, err := relay.Connect(ctx, "p"); err != nil {
				t.Fatal(err)
			}
			if err := relay.Run(ctx); err != nil {
				t.Fatal(err)
			}
			var filter repaintFilter
			prefix, err := filter.Feed([]byte(tc.old), true)
			if err != nil {
				t.Fatal(err)
			}
			pending := append([]byte{}, filter.pending...)
			filter.pending = nil
			suffix, err := filter.Feed([]byte(tc.fresh), false)
			if err != nil {
				t.Fatal(err)
			}
			want := string(append(append(prefix, pending...), suffix...))
			if string(output.Bytes()) != want || relay.written != uint64(len(source)) {
				t.Fatalf("fresh query swallowed: display=%q frontier=%d want=%q", output.Bytes(), relay.written, want)
			}
			if !strings.Contains(string(output.Bytes()), "UNSEEN") {
				t.Fatal("missed source interval")
			}
		})
	}
}
