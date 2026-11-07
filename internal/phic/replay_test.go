package phic

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func serveNativeReplay(w http.ResponseWriter, r *http.Request, data []byte, markers [][3]uint64) {
	serveNativeReplayEpoch(w, r, 7, data, markers)
}

// serveNativeReplayEpoch serves one replay page for the given epoch.
func serveNativeReplayEpoch(w http.ResponseWriter, r *http.Request, epoch uint64, data []byte, markers [][3]uint64) {
	q := r.URL.Query()
	from, _ := strconv.ParseUint(q.Get("from"), 10, 64)
	through, _ := strconv.ParseUint(q.Get("through"), 10, 64)
	cols, rows := uint32(80), uint32(24)
	if len(markers) > 0 && markers[0][0] == 0 {
		cols, rows = uint32(markers[0][1]), uint32(markers[0][2])
		markers = markers[1:]
	}
	before, _ := parseReplayPosition(q.Get("after_event_cursor"))
	target, _ := parseReplayPosition(q.Get("through_event_cursor"))
	if q.Get("through") == "latest" {
		through = uint64(len(data))
		target = replayPosition{epoch, through, uint64(len(markers))}
	}
	if from > through || through > uint64(len(data)) || before.ordinal > target.ordinal || target.ordinal > uint64(len(markers)) {
		http.Error(w, "bad fixture range", http.StatusBadRequest)
		return
	}
	end := min(through, from+recordingPageBytes)
	ordinal := before.ordinal
	var sizes [][3]uint64
	for ordinal < target.ordinal && markers[ordinal][0] <= end {
		if len(sizes) == 256 {
			end = markers[ordinal][0]
			break
		}
		sizes = append(sizes, markers[ordinal])
		ordinal++
	}
	h := wireproto.ReplayHeader{Epoch: epoch, Start: from, End: end, Through: through, ThroughCursor: target.String(), EventCursor: (replayPosition{epoch, end, ordinal}).String(), Resizes: sizes, InitCols: cols, InitRows: rows}
	writeReplayFixture(w, h, data[from:end])
}
func writeReplayFixture(w http.ResponseWriter, h wireproto.ReplayHeader, data []byte) {
	hdr, _ := json.Marshal(h)
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(hdr)))
	_, _ = w.Write(size[:])
	_, _ = w.Write(hdr)
	_, _ = w.Write(data)
}

func TestNativeReplayValidatesByteAndGeometryCertificates(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*wireproto.ReplayHeader)
		valid  bool
	}{
		{"valid", func(*wireproto.ReplayHeader) {}, true},
		{"wrong epoch", func(h *wireproto.ReplayHeader) { h.Epoch = 8 }, false},
		{"wrong byte count", func(h *wireproto.ReplayHeader) { h.End = 5 }, false},
		{"wrong target", func(h *wireproto.ReplayHeader) { h.ThroughCursor = "v1.7.4.2" }, false},
		{"missing geometry event", func(h *wireproto.ReplayHeader) { h.EventCursor = "v1.7.4.0" }, false},
		{"marker outside page", func(h *wireproto.ReplayHeader) { h.Resizes[0][0] = 5 }, false},
		{"invalid baseline", func(h *wireproto.ReplayHeader) { h.InitCols = 0 }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/terminals/p/replay" || r.URL.Query().Get("through_event_cursor") != "v1.7.4.1" {
					t.Error("wrong recovery endpoint or fence")
				}
				h := wireproto.ReplayHeader{Epoch: 7, Start: 0, End: 4, Through: 4, ThroughCursor: "v1.7.4.1", EventCursor: "v1.7.4.1", InitCols: 80, InitRows: 12, Resizes: [][3]uint64{{2, 100, 20}}}
				tc.change(&h)
				writeReplayFixture(w, h, []byte("data"))
			}))
			defer srv.Close()
			_, data, err := mustAPI(t, srv.URL).replay(t.Context(), "p", 7, 0, 4, "v1.7.0.0", "v1.7.4.1", false)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, err=%v, data=%q", tc.valid, err, data)
			}
		})
	}
}
