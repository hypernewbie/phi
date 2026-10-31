package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"github.com/hypernewbie/phi/pkg/pty"
)

func serveTranscriptSearch(t *testing.T, method, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/api/pi-bridge/transcript-search", strings.NewReader(body))
	req.Host = "example.com"
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	handlePiBridgeTranscriptSearch(rec, req)
	return rec
}

func dialTranscriptPane(t *testing.T, b *Bridge, pane string) (pibridgepb.Integration_ConnectClient, context.CancelFunc, string) {
	t.Helper()
	env, _, managed := b.Provision(pane, true)
	if !managed {
		t.Fatal("provision not managed")
	}
	b.Complete(&pty.PTYInstance{ID: pane})
	proc := env[piBridgeEnvProcess]
	stream, cancel := dialBridge(t, b, pane, proc, env[piBridgeEnvToken])
	hello := &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
			ProtocolVersion: 1, SessionId: "sess", RuntimeId: "rt",
			Capabilities: []string{"pi.lifecycle.v1", "pi.transcript-search.v1"},
			CurrentState: &pibridgepb.StateSnapshot{
				State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess", LeafId: "leaf",
				Model: &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
			},
		}},
	}
	if err := stream.Send(hello); err != nil {
		cancel()
		t.Fatalf("hello: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		cancel()
		t.Fatalf("accepted: %v", err)
	}
	return stream, cancel, proc
}

func answerTranscriptSearchOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, process string, matches []*pibridgepb.TranscriptSearchMatch, anchor string, next uint32, complete bool) *pibridgepb.TranscriptSearchRequest {
	t.Helper()
	type recvResult struct {
		msg *pibridgepb.PhiToPi
		err error
	}
	received := make(chan recvResult, 1)
	go func() {
		msg, err := stream.Recv()
		received <- recvResult{msg: msg, err: err}
	}()
	var request *pibridgepb.TranscriptSearchRequest
	select {
	case got := <-received:
		if got.err != nil {
			t.Fatalf("receive transcript request: %v", got.err)
		}
		request = got.msg.GetTranscriptSearchRequest()
		if request == nil {
			t.Fatalf("not a transcript request: %v", got.msg.GetPayload())
		}
		if got.msg.GetPaneId() != pane || got.msg.GetProcessId() != process || got.msg.GetRuntimeGeneration() != 1 {
			t.Fatalf("request envelope pane=%q process=%q generation=%d", got.msg.GetPaneId(), got.msg.GetProcessId(), got.msg.GetRuntimeGeneration())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for transcript request")
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: process, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_TranscriptSearchResponse{TranscriptSearchResponse: &pibridgepb.TranscriptSearchResponse{
			RequestId: request.GetRequestId(), SessionId: "sess", AnchorLeafId: anchor,
			NextIndex: next, Matches: matches, Complete: complete,
		}},
	}); err != nil {
		t.Fatalf("send transcript response: %v", err)
	}
	return request
}

func TestHandlePiBridgeTranscriptSearchRoundTrip(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	previousBridge := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = previousBridge })

	pane := "pane-transcript-search"
	stream, cancel, process := dialTranscriptPane(t, b, pane)
	defer cancel()
	roundTrip := func(body string, matches []*pibridgepb.TranscriptSearchMatch, anchor string, next uint32, complete bool) (*httptest.ResponseRecorder, *pibridgepb.TranscriptSearchRequest) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/transcript-search", strings.NewReader(body))
		req.Host = "example.com"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			handlePiBridgeTranscriptSearch(rec, req)
			close(done)
		}()
		wire := answerTranscriptSearchOnce(t, stream, pane, process, matches, anchor, next, complete)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("transcript search handler hung")
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("Cache-Control %q, want no-store", rec.Header().Get("Cache-Control"))
		}
		return rec, wire
	}

	firstBody := fmt.Sprintf(`{"pane":%q,"query":"needle","generation":"1","initial":true}`, pane)
	first, wire := roundTrip(firstBody,
		[]*pibridgepb.TranscriptSearchMatch{{EntryId: "entry-1", Role: "assistant", Snippet: "before needle after"}},
		"leaf-1", 2, false,
	)
	if first.Code != http.StatusOK || !wire.GetInitial() || wire.GetQuery() != "needle" || wire.GetSessionId() != "sess" {
		t.Fatalf("first response %d %s; request %+v", first.Code, first.Body.String(), wire)
	}
	var firstPage struct {
		SessionID    string `json:"session_id"`
		AnchorLeafID string `json:"anchor_leaf_id"`
		NextIndex    uint32 `json:"next_index"`
		Matches      []struct {
			EntryID string `json:"entry_id"`
			Role    string `json:"role"`
			Snippet string `json:"snippet"`
		} `json:"matches"`
		Complete   bool   `json:"complete"`
		ProcessID  string `json:"process_id"`
		Generation string `json:"generation"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &firstPage); err != nil {
		t.Fatal(err)
	}
	if firstPage.SessionID != "sess" || firstPage.AnchorLeafID != "leaf-1" || firstPage.NextIndex != 2 ||
		firstPage.ProcessID != process || firstPage.Generation != "1" || firstPage.Complete ||
		len(firstPage.Matches) != 1 || firstPage.Matches[0].EntryID != "entry-1" || firstPage.Matches[0].Role != "assistant" {
		t.Fatalf("first page %+v", firstPage)
	}

	secondBody := fmt.Sprintf(`{"pane":%q,"query":"needle","generation":"1","process_id":%q,"session_id":"sess","anchor_leaf_id":"leaf-1","start_index":2,"initial":false}`, pane, process)
	second, wire := roundTrip(secondBody, nil, "leaf-1", 2, true)
	if second.Code != http.StatusOK || wire.GetInitial() || wire.GetStartIndex() != 2 || wire.GetSessionId() != "sess" || wire.GetAnchorLeafId() != "leaf-1" {
		t.Fatalf("second response %d %s; request %+v", second.Code, second.Body.String(), wire)
	}
}

func TestHandlePiBridgeTranscriptSearchValidationAndFallback(t *testing.T) {
	for name, tc := range map[string]struct {
		method      string
		contentType string
		body        string
		status      int
	}{
		"method":         {http.MethodGet, "application/json", `{}`, http.StatusMethodNotAllowed},
		"content type":   {http.MethodPost, "text/plain", `{}`, http.StatusBadRequest},
		"unknown field":  {http.MethodPost, "application/json", `{"pane":"p","query":"q","generation":"1","initial":true,"extra":1}`, http.StatusBadRequest},
		"trailing json":  {http.MethodPost, "application/json", `{"pane":"p","query":"q","generation":"1","initial":true}{}`, http.StatusBadRequest},
		"oversized":      {http.MethodPost, "application/json", strings.Repeat(" ", piBridgeTranscriptSearchMaxBody+1), http.StatusBadRequest},
		"invalid gen":    {http.MethodPost, "application/json", `{"pane":"p","query":"q","generation":"01","initial":true}`, http.StatusBadRequest},
		"invalid cursor": {http.MethodPost, "application/json", `{"pane":"p","query":"q","generation":"1","process_id":"proc","session_id":"sess","anchor_leaf_id":"leaf","initial":false}`, http.StatusBadRequest},
	} {
		t.Run(name, func(t *testing.T) {
			rec := serveTranscriptSearch(t, tc.method, tc.contentType, tc.body)
			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.status, rec.Body.String())
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control %q", rec.Header().Get("Cache-Control"))
			}
		})
	}
	unknown := serveTranscriptSearch(t, http.MethodPost, "application/json", `{"pane":"unknown","query":"needle","generation":"1","initial":true}`)
	if unknown.Code != http.StatusServiceUnavailable {
		t.Fatalf("unknown pane status %d, want 503", unknown.Code)
	}
}

func TestTranscriptSearchRouteUsesAccessAuthGate(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pi-bridge/transcript-search", handlePiBridgeTranscriptSearch)
	protected := accessAuthMiddleware(mux)
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/transcript-search", strings.NewReader(
		`{"pane":"unknown","query":"needle","generation":"1","initial":true}`,
	))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d, want 401", rec.Code)
	}
}
