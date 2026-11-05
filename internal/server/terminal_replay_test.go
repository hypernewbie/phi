package server

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestReplayEndpointFencesBytesAndGeometry(t *testing.T) {
	setupHotHub(t)
	if err := testServer.hub.InitPaneJournal("p", 90, 25); err != nil {
		t.Fatal(err)
	}
	if err := testServer.hub.Ingest("p", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	ph, _ := testServer.hub.LookupPane("p")
	epoch := ph.EpochOf()
	resize := func(cols uint16) {
		t.Helper()
		commit, _, err := testServer.hub.StagePaneResize("p", cols, 30)
		if err != nil {
			t.Fatal(err)
		}
		if err := commit(); err != nil {
			t.Fatal(err)
		}
	}
	resize(100)
	fence := ws.EncodeEventCursor(epoch, 5, 1)
	resize(120) // Must stay outside the earlier attach fence at the same byte.
	q := url.Values{"epoch": {fmt.Sprint(epoch)}, "from": {"0"}, "through": {"5"}, "through_event_cursor": {fence}}
	w := httptest.NewRecorder()
	testServer.handleFallback(w, httptest.NewRequest(http.MethodGet, "/api/terminals/p/replay?"+q.Encode(), nil))
	if w.Code != http.StatusOK {
		t.Fatalf("replay: %d %s", w.Code, w.Body.String())
	}
	body := w.Body.Bytes()
	if len(body) < 4 {
		t.Fatal("missing envelope")
	}
	n := int(binary.BigEndian.Uint32(body))
	if n > 65536 || 4+n > len(body) {
		t.Fatal("invalid header bound")
	}
	var h wireproto.ReplayHeader
	if err := json.Unmarshal(body[4:4+n], &h); err != nil {
		t.Fatal(err)
	}
	if h.Epoch != epoch || h.Start != 0 || h.End != 5 || h.EventCursor != fence ||
		h.InitCols != 90 || h.InitRows != 25 || string(body[4+n:]) != "hello" ||
		len(h.Resizes) != 1 || h.Resizes[0] != [3]uint64{5, 100, 30} {
		t.Fatalf("wrong certified page: %+v %q", h, body[4+n:])
	}
	for _, tc := range []struct {
		name   string
		change func(url.Values)
		code   int
	}{
		{"wrong epoch", func(q url.Values) { q.Set("epoch", fmt.Sprint(epoch+1)) }, 409},
		{"missing fence", func(q url.Values) { q.Del("through_event_cursor") }, 400},
		{"future fence", func(q url.Values) { q.Set("through_event_cursor", ws.EncodeEventCursor(epoch, 5, 99)) }, 409},
		{"bad after position", func(q url.Values) { q.Set("after_event_cursor", ws.EncodeEventCursor(epoch, 1, 0)) }, 400},
		{"past head", func(q url.Values) { q.Set("from", "6") }, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query, _ := url.ParseQuery(q.Encode())
			tc.change(query)
			w := httptest.NewRecorder()
			testServer.handleFallback(w, httptest.NewRequest(http.MethodGet, "/api/terminals/p/replay?"+query.Encode(), nil))
			if w.Code != tc.code {
				t.Fatalf("got %d, want %d: %s", w.Code, tc.code, w.Body.String())
			}
		})
	}
}

func TestRetiredTerminalAPIsRequireProtocolUpgrade(t *testing.T) {
	for _, endpoint := range []string{"state", "recording"} {
		w := httptest.NewRecorder()
		testServer.handleFallback(w, httptest.NewRequest(http.MethodGet, "/api/terminals/p/"+endpoint, nil))
		if w.Code != http.StatusUpgradeRequired || !strings.Contains(w.Body.String(), wireproto.TerminalSubprotocol) ||
			!strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") {
			t.Fatalf("%s: wrong upgrade response: %d %s", endpoint, w.Code, w.Body.String())
		}
	}
}

// A 409 certifies the whole window in one bounded header, so a native
// client can resume at the floor without a second unlocked lookup.
func TestReplayExpiredCarriesTheCertifiedWindow(t *testing.T) {
	setupHotHub(t)
	testServer.hub.SetReplayBufferBytes(4)
	if err := testServer.hub.InitPaneJournal("p", 90, 25); err != nil {
		t.Fatal(err)
	}
	if err := testServer.hub.Ingest("p", []byte("0123456789")); err != nil {
		t.Fatal(err)
	}
	ph, _ := testServer.hub.LookupPane("p")
	epoch := ph.EpochOf()
	w := httptest.NewRecorder()
	q := url.Values{"epoch": {fmt.Sprint(epoch)}, "from": {"0"}, "through": {"latest"}}
	testServer.handleFallback(w, httptest.NewRequest(http.MethodGet, "/api/terminals/p/replay?"+q.Encode(), nil))
	if w.Code != http.StatusConflict {
		t.Fatalf("expired replay: %d %s", w.Code, w.Body.String())
	}
	raw := w.Header().Get("X-Phi-Replay-Window")
	if len(raw) == 0 || len(raw) > 2048 {
		t.Fatalf("window header bounds: %d", len(raw))
	}
	var info struct {
		Epoch            uint64 `json:"epoch"`
		Oldest           uint64 `json:"oldest"`
		Head             uint64 `json:"head"`
		FloorCols        uint16 `json:"floor_cols"`
		FloorRows        uint16 `json:"floor_rows"`
		HeadCols         uint16 `json:"head_cols"`
		HeadRows         uint16 `json:"head_rows"`
		FloorEventCursor string `json:"floor_event_cursor"`
		EventCursor      string `json:"event_cursor"`
	}
	if err := json.Unmarshal([]byte(raw), &info); err != nil {
		t.Fatalf("window header: %v (%s)", err, raw)
	}
	if info.Epoch != epoch || info.Oldest != 6 || info.Head != 10 ||
		info.FloorCols != 90 || info.FloorRows != 25 || info.HeadCols != 90 || info.HeadRows != 25 {
		t.Fatalf("window snapshot: %+v", info)
	}
	if info.FloorEventCursor != ws.EncodeEventCursor(epoch, 6, 0) ||
		info.EventCursor != ws.EncodeEventCursor(epoch, 10, 0) {
		t.Fatalf("window cursors: %+v", info)
	}
}
