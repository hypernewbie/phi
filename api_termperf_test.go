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
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

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
