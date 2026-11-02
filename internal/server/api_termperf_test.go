package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws"
)

func setupHotHub(t *testing.T) {
	t.Helper()
	orig := testServer.hub
	testServer.hub = ws.NewHub(4096)
	t.Cleanup(func() { _ = testServer.hub.Close(); testServer.hub = orig })
}

func TestCheckpointEndpointStoreAndConflict(t *testing.T) {
	setupHotHub(t)
	testServer.hub.Ingest("pane-3", []byte("abcdef")) // head=6

	epochOf := func() uint64 {
		ph, ok := testServer.hub.LookupPane("pane-3")
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
	testServer.handleFallback(wWrong, wrong)
	if wWrong.Code != http.StatusConflict {
		t.Fatalf("bad epoch should 409, got %d", wWrong.Code)
	}

	egood := strconv.FormatUint(epochOf(), 10)
	good := httptest.NewRequest(http.MethodPost, "/api/terminals/pane-3/checkpoint",
		bytes.NewBufferString(`{"epoch":`+egood+`,"through":3,"cols":80,"rows":24,"ansi":"screen-snapshot"}`))
	wGood := httptest.NewRecorder()
	testServer.handleFallback(wGood, good)
	if wGood.Code != http.StatusNoContent {
		t.Fatalf("valid checkpoint should 204, got %d", wGood.Code)
	}

	// Oversized payload -> 413.
	big := bytes.Repeat([]byte("x"), ws.MaxCheckpointBytes+10)
	bigReq := httptest.NewRequest(http.MethodPost, "/api/terminals/pane-3/checkpoint",
		bytes.NewBufferString(`{"epoch":`+egood+`,"through":3,"cols":80,"rows":24,"ansi":"`+string(big)+`"}`))
	wBig := httptest.NewRecorder()
	testServer.handleFallback(wBig, bigReq)
	if wBig.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized checkpoint should 413, got %d", wBig.Code)
	}
}
