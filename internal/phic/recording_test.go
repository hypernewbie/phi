package phic

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestInvalidRecordingNeverAdvancesWrittenFrontier(t *testing.T) {
	for _, tc := range []struct {
		name string
		h    wireproto.RecordingHeader
		body string
	}{
		{"clamped unavailable prefix", wireproto.RecordingHeader{Epoch: 7, Start: 1, End: 3}, "bc"},
		{"wrong epoch", wireproto.RecordingHeader{Epoch: 8, Start: 0, End: 3}, "abc"},
		{"wrong byte count", wireproto.RecordingHeader{Epoch: 7, Start: 0, End: 3}, "ab"},
		{"invalid resize", wireproto.RecordingHeader{Epoch: 7, Start: 0, End: 3, Resizes: [][3]uint64{{0, 0, 24}}}, "abc"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				h, _ := json.Marshal(tc.h)
				var size [4]byte
				binary.BigEndian.PutUint32(size[:], uint32(len(h)))
				_, _ = w.Write(size[:])
				_, _ = w.Write(h)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			output := &shortTerminal{}
			relay := NewRelay(output, mustAPI(t, srv.URL))
			relay.epoch = 7
			if err := relay.recover(t.Context(), "p", 3); !errors.Is(err, errInvalidRecording) {
				t.Fatalf("invalid range accepted: %v", err)
			}
			if relay.written != 0 || output.Len() != 0 {
				t.Fatalf("unavailable range advanced/painted: %d %q", relay.written, output.Bytes())
			}
		})
	}
}
func TestPreflightRejectsHistoricalQueriesAndGeometryBeforePainting(t *testing.T) {
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
				h, _ := json.Marshal(wireproto.RecordingHeader{Epoch: 7, Start: 0, End: uint64(len(tc.body)), Resizes: [][3]uint64{{0, tc.cols, 24}}})
				var size [4]byte
				binary.BigEndian.PutUint32(size[:], uint32(len(h)))
				_, _ = w.Write(size[:])
				_, _ = w.Write(h)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			output := &shortTerminal{}
			relay := NewRelay(output, mustAPI(t, srv.URL))
			relay.epoch = 7
			if err := relay.preflight(context.Background(), "p", uint64(len(tc.body)), 80, 24); err == nil {
				t.Fatal("unsafe replay admitted")
			}
			if relay.written != 0 || output.Len() != 0 {
				t.Fatal("guard painted historical bytes before rejecting")
			}
		})
	}
}
