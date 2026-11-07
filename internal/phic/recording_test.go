package phic

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestInvalidReplayNeverAdvancesWrittenFrontier(t *testing.T) {
	for _, tc := range []struct {
		name string
		h    wireproto.ReplayHeader
		body string
	}{
		{"clamped unavailable prefix", wireproto.ReplayHeader{Epoch: 7, Start: 1, End: 3, Through: 3, ThroughCursor: "v1.7.3.0", EventCursor: "v1.7.3.0", InitCols: 80, InitRows: 24}, "bc"},
		{"wrong epoch", wireproto.ReplayHeader{Epoch: 8, Start: 0, End: 3, Through: 3, ThroughCursor: "v1.7.3.0", EventCursor: "v1.7.3.0", InitCols: 80, InitRows: 24}, "abc"},
		{"wrong byte count", wireproto.ReplayHeader{Epoch: 7, Start: 0, End: 3, Through: 3, ThroughCursor: "v1.7.3.0", EventCursor: "v1.7.3.0", InitCols: 80, InitRows: 24}, "ab"},
		{"invalid resize", wireproto.ReplayHeader{Epoch: 7, Start: 0, End: 3, Through: 3, ThroughCursor: "v1.7.3.0", EventCursor: "v1.7.3.0", InitCols: 80, InitRows: 24, Resizes: [][3]uint64{{0, 0, 24}}}, "abc"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeReplayFixture(w, tc.h, []byte(tc.body))
			}))
			defer srv.Close()
			output := &shortTerminal{}
			relay := NewRelay(output, mustAPI(t, srv.URL))
			relay.epoch = 7
			relay.head = 3
			relay.headCursor = "v1.7.3.0"
			if err := relay.recover(t.Context(), "p", 3); !errors.Is(err, errInvalidRecording) {
				t.Fatalf("invalid range accepted: %v", err)
			}
			if relay.written != 0 || output.Len() != 0 {
				t.Fatalf("unavailable range advanced/painted: %d %q", relay.written, output.Bytes())
			}
		})
	}
}
func TestRepaintReusedPaneSuppressesQueriesAndAcceptsChangedGeometry(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		cols       uint64
	}{
		{"historical reply-producing query", "screen\x1b[6n", 80},
		{"historical status-string query", "screen\x1bP$qm\x1b\\", 80},
		{"historical geometry", "screen", 120},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				serveNativeReplay(w, r, []byte(tc.body), [][3]uint64{{0, tc.cols, 24}})
			}))
			defer srv.Close()
			output := &shortTerminal{}
			relay := NewRelay(output, mustAPI(t, srv.URL))
			relay.epoch = 7
			relay.head = uint64(len(tc.body))
			relay.headCursor = (replayPosition{7, uint64(len(tc.body)), 0}).String()
			relay.repaint = &repaintFilter{}
			if err := relay.recoverOutput(context.Background(), "p", uint64(len(tc.body)), relay.headCursor, true); err != nil {
				t.Fatal(err)
			}
			if relay.written != uint64(len(tc.body)) || string(output.Bytes()) != "screen" {
				t.Fatalf("repaint failed: source frontier=%d display=%q", relay.written, output.Bytes())
			}
			if err := relay.output(context.Background(), []byte("\x1b[6n"), false); err != nil {
				t.Fatal(err)
			}
			if string(output.Bytes()) != "screen\x1b[6n" {
				t.Fatal("live query did not reach the terminal")
			}
		})
	}
}
