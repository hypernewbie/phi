package main

// HTTP-level tests for the TERMPERF endpoints:
//
//	GET  /api/terminals/{id}/recording?from=&through=
//	POST /api/terminals/{id}/checkpoint
//
// The binary recording envelope is [u32 jsonLen BE][json][raw bytes], the
// same framing as the 0x08 ATTACH_HEAD WebSocket frame.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/hypernewbie/phi/internal/termstate"
	"github.com/hypernewbie/phi/pkg/ws"
)

func setupHotHub(t *testing.T) {
	t.Helper()
	orig := wsHub
	wsHub = ws.NewHub(4096)
	t.Cleanup(func() { wsHub = orig })
}

func TestRecordingEndpointServesFramedBytes(t *testing.T) {
	setupHotHub(t)
	wsHub.Ingest("pane-1", []byte("hello "))
	wsHub.Ingest("pane-1", []byte("world"))
	wsHub.RecordResize("pane-1", 100, 30)

	req := httptest.NewRequest(http.MethodGet, "/api/terminals/pane-1/recording?from=0&through=11", nil)
	w := httptest.NewRecorder()
	handleFallback(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.Bytes()
	if len(body) < 5 {
		t.Fatalf("body too short: %v", body)
	}
	n := binary.BigEndian.Uint32(body[0:4])
	var hdr ws.RecordingHeaderJSON
	if err := json.Unmarshal(body[4:4+n], &hdr); err != nil {
		t.Fatalf("bad header json: %v", err)
	}
	if hdr.Start != 0 || hdr.End != 11 {
		t.Fatalf("header span = [%d,%d), want [0,11)", hdr.Start, hdr.End)
	}
	if len(hdr.Resizes) != 1 || hdr.Resizes[0] != [3]uint64{11, 100, 30} {
		t.Fatalf("header resizes = %+v", hdr.Resizes)
	}
	if string(body[4+n:]) != "hello world" {
		t.Fatalf("payload = %q", body[4+n:])
	}
}

func TestRecordingEndpointPartialRangeAndErrors(t *testing.T) {
	setupHotHub(t)
	wsHub.Ingest("pane-2", []byte("0123456789"))

	req := httptest.NewRequest(http.MethodGet, "/api/terminals/pane-2/recording?from=3&through=7", nil)
	w := httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	body := w.Body.Bytes()
	n := binary.BigEndian.Uint32(body[0:4])
	var hdr ws.RecordingHeaderJSON
	_ = json.Unmarshal(body[4:4+n], &hdr)
	if string(body[4+n:]) != "3456" {
		t.Fatalf("partial payload = %q", body[4+n:])
	}

	// Unknown pane -> 404 via Recording's LookupPane miss.
	req404 := httptest.NewRequest(http.MethodGet, "/api/terminals/nope/recording?from=0&through=5", nil)
	w404 := httptest.NewRecorder()
	handleFallback(w404, req404)
	if w404.Code != http.StatusBadRequest && w404.Code != http.StatusNotFound {
		t.Fatalf("unknown pane should 4xx, got %d", w404.Code)
	}

	// from beyond head -> 400.
	reqBad := httptest.NewRequest(http.MethodGet, "/api/terminals/pane-2/recording?from=99&through=100", nil)
	wBad := httptest.NewRecorder()
	handleFallback(wBad, reqBad)
	if wBad.Code != http.StatusBadRequest {
		t.Fatalf("from beyond head should 400, got %d", wBad.Code)
	}
}

func TestRecordingEndpointRejectsWrongEpoch(t *testing.T) {
	setupHotHub(t)
	wsHub.Ingest("pane-3", []byte("hello"))

	ph, ok := wsHub.LookupPane("pane-3")
	if !ok {
		t.Fatal("pane-3 missing")
	}
	// Right epoch: 200.
	reqOK := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/terminals/pane-3/recording?from=0&through=5&epoch=%d", ph.EpochOf()), nil)
	wOK := httptest.NewRecorder()
	handleFallback(wOK, reqOK)
	if wOK.Code != http.StatusOK {
		t.Fatalf("matching epoch should 200, got %d", wOK.Code)
	}

	// Wrong epoch: 409.
	reqBad := httptest.NewRequest(http.MethodGet, "/api/terminals/pane-3/recording?from=0&through=5&epoch=999", nil)
	wBad := httptest.NewRecorder()
	handleFallback(wBad, reqBad)
	if wBad.Code != http.StatusConflict {
		t.Fatalf("wrong epoch should 409, got %d", wBad.Code)
	}
}

func TestCheckpointEndpointStoreAndConflict(t *testing.T) {
	setupHotHub(t)
	wsHub.Ingest("pane-3", []byte("abcdef")) // head=6

	epochOf := func() uint64 {
		ph, ok := wsHub.LookupPane("pane-3")
		if !ok {
			t.Fatal("pane missing")
		}
		return ph.EpochOf()
	}

	// Epoch is only known to attached clients (it rides ATTACH_HEAD); a
	// wrong epoch must 409.
	wrong := httptest.NewRequest(http.MethodPost, "/api/terminals/pane-3/checkpoint",
		bytes.NewBufferString(`{"epoch":1,"through":3,"cols":80,"rows":24,"ansi":"\u001b[2J"}`))
	wWrong := httptest.NewRecorder()
	handleFallback(wWrong, wrong)
	if wWrong.Code != http.StatusConflict {
		t.Fatalf("bad epoch should 409, got %d", wWrong.Code)
	}

	egood := strconv.FormatUint(epochOf(), 10)
	good := httptest.NewRequest(http.MethodPost, "/api/terminals/pane-3/checkpoint",
		bytes.NewBufferString(`{"epoch":`+egood+`,"through":3,"cols":80,"rows":24,"ansi":"screen-snapshot"}`))
	wGood := httptest.NewRecorder()
	handleFallback(wGood, good)
	if wGood.Code != http.StatusNoContent {
		t.Fatalf("valid checkpoint should 204, got %d", wGood.Code)
	}

	// Oversized payload -> 413.
	big := bytes.Repeat([]byte("x"), ws.MaxCheckpointBytes+10)
	bigReq := httptest.NewRequest(http.MethodPost, "/api/terminals/pane-3/checkpoint",
		bytes.NewBufferString(`{"epoch":`+egood+`,"through":3,"cols":80,"rows":24,"ansi":"`+string(big)+`"}`))
	wBig := httptest.NewRecorder()
	handleFallback(wBig, bigReq)
	if wBig.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized checkpoint should 413, got %d", wBig.Code)
	}
}

func itoa(v uint64) string { return strconv.FormatUint(v, 10) }

func TestRecordingHaveNegotiation(t *testing.T) {
	setupHotHub(t)
	wsHub.Ingest("pane-have", []byte("0123456789abcdefghij")) // head=20

	get := func(query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/terminals/pane-have/recording"+query, nil)
		w := httptest.NewRecorder()
		handleFallback(w, req)
		return w
	}
	spanOf := func(w *httptest.ResponseRecorder) (uint64, uint64, string) {
		t.Helper()
		body := w.Body.Bytes()
		n := binary.BigEndian.Uint32(body[0:4])
		var hdr ws.RecordingHeaderJSON
		if err := json.Unmarshal(body[4:4+n], &hdr); err != nil {
			t.Fatalf("bad header json: %v", err)
		}
		return hdr.Start, hdr.End, string(body[4+n:])
	}
	have := func(s, e uint64, data string) string {
		return fmt.Sprintf("%d:%d:%x", s, e, ws.ChunkHash([]byte(data)))
	}

	// Fully known span: 204, zero bytes.
	full := have(0, 10, "0123456789") + "," + have(10, 20, "abcdefghij")
	if w := get("?from=0&through=20&have=" + full); w.Code != http.StatusNoContent {
		t.Fatalf("all-known should 204, got %d", w.Code)
	}
	if w := get("?from=0&through=20&have=" + full); w.Body.Len() != 0 {
		t.Fatalf("204 must carry no body, got %d bytes", w.Body.Len())
	}

	// Prefix known: only the suffix travels.
	w := get("?from=0&through=20&have=" + have(0, 10, "0123456789"))
	if w.Code != http.StatusOK {
		t.Fatalf("prefix-known should 200, got %d", w.Code)
	}
	if s, e, data := spanOf(w); s != 10 || e != 20 || data != "abcdefghij" {
		t.Fatalf("span = [%d,%d) %q, want [10,20) suffix", s, e, data)
	}

	// Wrong hash: treated as unknown, full range resent.
	w = get("?from=0&through=20&have=" + have(0, 10, "xxxxxxxxxx"))
	if s, e, data := spanOf(w); s != 0 || e != 20 || data != "0123456789abcdefghij" {
		t.Fatalf("mismatch span = [%d,%d) %q, want full range", s, e, data)
	}

	// Garbage declaration: identical to no declaration.
	w = get("?from=0&through=20&have=garbage!!!")
	if s, e, _ := spanOf(w); s != 0 || e != 20 {
		t.Fatalf("garbage-have span = [%d,%d), want full range", s, e)
	}
}

func TestRecordingEndpointCursorFiltersAnd409(t *testing.T) {
	setupHotHub(t)
	if err := wsHub.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	const pane = "cursor-pane"
	payload := bytes.Repeat([]byte("0123456789abcdef"), 4096) // 64 KiB
	if err := wsHub.Ingest(pane, payload); err != nil {
		t.Fatal(err)
	}
	wsHub.RecordResize(pane, 80, 24)
	wsHub.RecordResize(pane, 100, 30)
	wsHub.RecordResize(pane, 120, 40)
	at := uint64(len(payload))
	if err := wsHub.Ingest(pane, payload); err != nil {
		t.Fatal(err)
	}
	ph, ok := wsHub.LookupPane(pane)
	if !ok {
		t.Fatal("pane missing")
	}
	epoch := ph.EpochOf()
	head := at + uint64(len(payload))

	get := func(query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/terminals/"+pane+"/recording?"+query, nil)
		w := httptest.NewRecorder()
		handleFallback(w, req)
		return w
	}
	headerOf := func(w *httptest.ResponseRecorder) (ws.RecordingHeaderJSON, []byte) {
		body := w.Body.Bytes()
		n := binary.BigEndian.Uint32(body[0:4])
		var hdr ws.RecordingHeaderJSON
		if err := json.Unmarshal(body[4:4+n], &hdr); err != nil {
			t.Fatalf("bad header json: %v", err)
		}
		return hdr, body[4+n:]
	}

	// Plain request keeps the existing inclusion and carries an end cursor.
	plain := get("from=0&through=" + strconv.FormatUint(head, 10))
	if plain.Code != http.StatusOK {
		t.Fatalf("plain recording should 200, got %d", plain.Code)
	}
	plainHdr, _ := headerOf(plain)
	if len(plainHdr.Resizes) != 3 {
		t.Fatalf("plain markers = %d, want 3", len(plainHdr.Resizes))
	}
	if plainHdr.EventCursor == "" {
		t.Fatal("plain recording omits the end cursor")
	}

	// A cursor that consumed the boundary filters all three same-position markers.
	covered := ws.EncodeEventCursor(epoch, at, 3)
	filtered := get("from=" + strconv.FormatUint(at, 10) + "&through=" + strconv.FormatUint(head, 10) + "&after_event_cursor=" + covered)
	if filtered.Code != http.StatusOK {
		t.Fatalf("cursor recording should 200, got %d", filtered.Code)
	}
	filteredHdr, filteredData := headerOf(filtered)
	if len(filteredHdr.Resizes) != 0 {
		t.Fatalf("cursor markers = %+v, want none", filteredHdr.Resizes)
	}
	if uint64(len(filteredData)) != head-at {
		t.Fatalf("cursor bytes = %d, want %d", len(filteredData), head-at)
	}

	// Malformed cursor -> 400; cross-epoch cursor -> 409.
	if w := get("from=0&through=10&after_event_cursor=bogus"); w.Code != http.StatusBadRequest {
		t.Fatalf("malformed cursor should 400, got %d", w.Code)
	}
	other := ws.EncodeEventCursor(epoch+1, at, 3)
	if w := get("from=0&through=10&after_event_cursor=" + other); w.Code != http.StatusConflict {
		t.Fatalf("cross-epoch cursor should 409, got %d", w.Code)
	}

	// Evict the boundary, then prove the stale cursor expires with 409.
	if err := wsHub.Ingest(pane, bytes.Repeat([]byte("x"), 2<<20)); err != nil {
		t.Fatal(err)
	}
	floorProbe := get("from=0&through=999999999")
	if floorProbe.Code != http.StatusOK {
		t.Fatalf("floor probe should 200, got %d", floorProbe.Code)
	}
	probeHdr, _ := headerOf(floorProbe)
	if probeHdr.Start == 0 {
		t.Fatal("expected eviction before expiry check")
	}
	// A cursor whose frontier left the window expires with 409.
	stale := ws.EncodeEventCursor(epoch, at, 1)
	staleQ := "from=" + strconv.FormatUint(probeHdr.Start, 10) + "&through=" + strconv.FormatUint(probeHdr.End, 10) + "&after_event_cursor=" + stale
	if w := get(staleQ); w.Code != http.StatusConflict {
		t.Fatalf("expired cursor should 409, got %d", w.Code)
	}
}

func TestTerminalStateMissingPaneReturns404(t *testing.T) {
	setupHotHub(t)
	req := httptest.NewRequest(http.MethodGet, "/api/terminals/no-such-pane/state?epoch=1&through=0&kind=ansi-v1", nil)
	w := httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing pane state should 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTerminalStateLatestANSICarriesContinuation(t *testing.T) {
	setupHotHub(t)
	if err := wsHub.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	// An unfinished UTF-8 sequence: the live suffix completes it.
	if err := wsHub.Ingest("cont-pane", []byte("A\xe2\x82")); err != nil {
		t.Fatal(err)
	}
	ph, ok := wsHub.LookupPane("cont-pane")
	if !ok {
		t.Fatal("pane missing")
	}
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/terminals/cont-pane/state?epoch=%d&through=latest&kind=ansi-v1", ph.EpochOf()), nil)
	w := httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("latest ansi should 200, got %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.Bytes()
	n := binary.BigEndian.Uint32(body[0:4])
	payload := body[4+n:]
	if !bytes.HasSuffix(payload, []byte{0xe2, 0x82}) {
		t.Fatal("live ANSI checkpoint omits the pending input suffix")
	}
	e, err := termstate.New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.Feed(payload); err != nil {
		t.Fatal(err)
	}
	if err = e.Feed([]byte{0xac}); err != nil {
		t.Fatal(err)
	}
	screen, err := e.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(screen, []byte("\u20ac")) || bytes.Contains(screen, []byte("\ufffd")) {
		t.Fatalf("live suffix did not complete the split sequence: %q", screen)
	}
}

func TestTerminalStateLatestGhosttyServesLiveSnapshot(t *testing.T) {
	setupHotHub(t)
	if err := wsHub.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := wsHub.Ingest("ghostty-pane", []byte("live screen\r\n")); err != nil {
		t.Fatal(err)
	}
	ph, ok := wsHub.LookupPane("ghostty-pane")
	if !ok {
		t.Fatal("pane missing")
	}
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/terminals/ghostty-pane/state?epoch=%d&through=latest&kind=ghostty-ready-v1", ph.EpochOf()), nil)
	w := httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("latest ghostty should 200, got %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.Bytes()
	n := binary.BigEndian.Uint32(body[0:4])
	var hdr struct {
		Epoch  uint64 `json:"epoch"`
		Oldest uint64 `json:"oldest"`
		Head   uint64 `json:"head"`
		Ckpt   *struct {
			Kind    string `json:"kind"`
			Through uint64 `json:"through"`
			Len     int    `json:"len"`
		} `json:"ckpt"`
	}
	if err := json.Unmarshal(body[4:4+n], &hdr); err != nil {
		t.Fatalf("bad header json: %v", err)
	}
	if hdr.Ckpt == nil || hdr.Ckpt.Kind != "ghostty-ready-v1" || hdr.Ckpt.Through != hdr.Head {
		t.Fatalf("ckpt = %+v, want live ghostty snapshot", hdr.Ckpt)
	}
	if hdr.Ckpt.Len != len(body)-4-int(n) {
		t.Fatal("ckpt length does not match the payload")
	}
}
