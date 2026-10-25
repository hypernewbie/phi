package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws"
)

// writePastTheFloor fills a pane with enough output that the retention
// floor moves above zero, and returns the head.
func writePastTheFloor(t *testing.T, pane string) uint64 {
	t.Helper()
	if err := wsHub.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("x"), 64*1024)
	// More than the floor plus the 2MiB response bound, so a request that
	// starts at zero used to invert into an empty window.
	for i := 0; i < 80; i++ {
		if err := wsHub.Ingest(pane, chunk); err != nil {
			t.Fatal(err)
		}
	}
	return 80 * 64 * 1024
}

func recordingHeader(t *testing.T, w *httptest.ResponseRecorder) (ws.RecordingHeaderJSON, []byte) {
	t.Helper()
	body := w.Body.Bytes()
	if len(body) < 4 {
		t.Fatalf("body too short: %d bytes", len(body))
	}
	n := binary.BigEndian.Uint32(body[0:4])
	if 4+int(n) > len(body) {
		t.Fatalf("header length %d does not fit in %d bytes", n, len(body))
	}
	var hdr ws.RecordingHeaderJSON
	if err := json.Unmarshal(body[4:4+n], &hdr); err != nil {
		t.Fatal(err)
	}
	return hdr, body[4+int(n):]
}

// A request that starts below the retention floor must answer with the
// retained window, not with a 400. The floor moves while the session runs,
// so "from=0" is a normal thing for a client to ask for.
func TestRecordingEndpointServesTheRetainedWindowBelowTheFloor(t *testing.T) {
	setupHotHub(t)
	head := writePastTheFloor(t, "pane-rot")

	// The window is bigger than one bounded response, so a client pages it.
	var hdr ws.RecordingHeaderJSON
	var data []byte
	cursor := uint64(0)
	for cursor < head {
		req := httptest.NewRequest(http.MethodGet, "/api/terminals/pane-rot/recording?from="+strconv.FormatUint(cursor, 10)+"&through=18446744073709551615", nil)
		w := httptest.NewRecorder()
		handleFallback(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200 for a request that starts below the floor, got %d: %s", w.Code, w.Body.String())
		}
		pageHdr, page := recordingHeader(t, w)
		if cursor == 0 {
			hdr = pageHdr
			if hdr.Start == 0 {
				t.Fatal("the pane did not rotate, so the floor stayed at zero")
			}
		} else if pageHdr.Start != cursor {
			t.Fatalf("page started at %d, want the previous end %d", pageHdr.Start, cursor)
		}
		if pageHdr.End <= pageHdr.Start {
			t.Fatalf("page [%d,%d) carried no bytes", pageHdr.Start, pageHdr.End)
		}
		data = append(data, page...)
		cursor = pageHdr.End
	}
	if cursor != head {
		t.Fatalf("retained window ended at %d, want the head %d", cursor, head)
	}
	if uint64(len(data)) != head-hdr.Start {
		t.Fatalf("answered %d bytes for a window of %d", len(data), head-hdr.Start)
	}
	if !bytes.Equal(data, bytes.Repeat([]byte("x"), len(data))) {
		t.Fatal("the served bytes are not the recorded ones")
	}
}

// A window that lies wholly below the floor has no bytes left. The answer
// is the empty span at the floor: its start is above the requested
// position, which is the expired-prefix signal every client reads.
func TestRecordingEndpointAnswersAnEvictedWindowAsTheEmptySpanAtTheFloor(t *testing.T) {
	setupHotHub(t)
	writePastTheFloor(t, "pane-rot")

	req := httptest.NewRequest(http.MethodGet, "/api/terminals/pane-rot/recording?from=0&through=18446744073709551615", nil)
	w := httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	floor, _ := recordingHeader(t, w)

	req = httptest.NewRequest(http.MethodGet, "/api/terminals/pane-rot/recording?from=0&through=0", nil)
	w = httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for an evicted window, got %d: %s", w.Code, w.Body.String())
	}
	hdr, data := recordingHeader(t, w)
	if hdr.Start != floor.Start || hdr.End != floor.Start {
		t.Fatalf("answered as [%d,%d], want the empty span at the floor %d", hdr.Start, hdr.End, floor.Start)
	}
	if len(data) != 0 {
		t.Fatalf("an evicted window returned %d bytes", len(data))
	}
}
