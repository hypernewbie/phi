package pibridge

import (
	"context"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func recvTranscriptSearchRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) *pibridgepb.TranscriptSearchRequest {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type result struct {
		msg *pibridgepb.PhiToPi
		err error
	}
	got := make(chan result, 1)
	go func() {
		msg, err := stream.Recv()
		got <- result{msg: msg, err: err}
	}()
	select {
	case result := <-got:
		if result.err != nil {
			t.Fatalf("receive search request: %v", result.err)
		}
		request := result.msg.GetTranscriptSearchRequest()
		if request == nil {
			t.Fatalf("not a transcript search request: %v", result.msg.GetPayload())
		}
		return request
	case <-ctx.Done():
		t.Fatal("timed out waiting for transcript search request")
		return nil
	}
}

func sendTranscriptSearchResponse(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, process string, response *pibridgepb.TranscriptSearchResponse) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: process, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_TranscriptSearchResponse{TranscriptSearchResponse: response},
	}); err != nil {
		t.Fatalf("send transcript response: %v", err)
	}
}

func TestRequestTranscriptSearchRoundTripAndContinuation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, process, _, cancel := openLeaseStream(t, s, sock, "pane-ts1", CapabilityLifecycle, CapabilityTranscriptSearch)
	defer cancel()

	request := TranscriptSearchRequest{Query: "Needle", Initial: true}
	done := make(chan struct {
		result TranscriptSearchResult
		err    error
	}, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		result, err := s.RequestTranscriptSearch(ctx, process, 1, request)
		done <- struct {
			result TranscriptSearchResult
			err    error
		}{result, err}
	}()
	wire := recvTranscriptSearchRequest(t, stream)
	if wire.GetRequestId() == "" || wire.GetQuery() != "Needle" || wire.GetSessionId() != "sess" ||
		wire.GetAnchorLeafId() != "" || wire.GetStartIndex() != 0 || !wire.GetInitial() {
		t.Fatalf("wire request %+v", wire)
	}
	sendTranscriptSearchResponse(t, stream, "pane-ts1", process, &pibridgepb.TranscriptSearchResponse{
		RequestId: wire.GetRequestId(), SessionId: "sess", AnchorLeafId: "leaf-1", NextIndex: 2,
		Matches: []*pibridgepb.TranscriptSearchMatch{{EntryId: "entry-1", Role: "assistant", Snippet: "before Needle after"}}, Complete: false,
	})
	first := <-done
	if first.err != nil || first.result.Unavailable || first.result.ProcessID != process || first.result.Generation != 1 ||
		first.result.AnchorLeafID != "leaf-1" || first.result.NextIndex != 2 || len(first.result.Matches) != 1 || first.result.Matches[0].Role != "assistant" {
		t.Fatalf("first page %+v err=%v", first.result, first.err)
	}

	request = TranscriptSearchRequest{Query: "Needle", SessionID: "sess", AnchorLeafID: "leaf-1", StartIndex: 2}
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		result, err := s.RequestTranscriptSearch(ctx, process, 1, request)
		done <- struct {
			result TranscriptSearchResult
			err    error
		}{result, err}
	}()
	wire = recvTranscriptSearchRequest(t, stream)
	if wire.GetSessionId() != "sess" || wire.GetAnchorLeafId() != "leaf-1" || wire.GetStartIndex() != 2 || wire.GetInitial() {
		t.Fatalf("continuation request %+v", wire)
	}
	sendTranscriptSearchResponse(t, stream, "pane-ts1", process, &pibridgepb.TranscriptSearchResponse{
		RequestId: wire.GetRequestId(), SessionId: "sess", AnchorLeafId: "leaf-1", NextIndex: 2, Complete: true,
	})
	last := <-done
	if last.err != nil || last.result.Unavailable || !last.result.Complete || last.result.NextIndex != 2 || len(last.result.Matches) != 0 {
		t.Fatalf("last page %+v err=%v", last.result, last.err)
	}
}

func TestRequestTranscriptSearchEmptyBranchAndInvalidResponseStayNonfatal(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, process, _, cancel := openLeaseStream(t, s, sock, "pane-ts2", CapabilityLifecycle, CapabilityTranscriptSearch)
	defer cancel()

	request := TranscriptSearchRequest{Query: "needle", Initial: true}
	done := make(chan TranscriptSearchResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		result, err := s.RequestTranscriptSearch(ctx, process, 1, request)
		if err != nil {
			t.Errorf("empty branch search: %v", err)
			return
		}
		done <- result
	}()
	wire := recvTranscriptSearchRequest(t, stream)
	sendTranscriptSearchResponse(t, stream, "pane-ts2", process, &pibridgepb.TranscriptSearchResponse{
		RequestId: wire.GetRequestId(), SessionId: "sess", Complete: true,
	})
	result := <-done
	if result.Unavailable || !result.Complete || result.AnchorLeafID != "" || result.NextIndex != 0 {
		t.Fatalf("empty-branch result %+v", result)
	}

	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestTranscriptSearch(ctx, process, 1, request)
		if err != nil {
			t.Errorf("invalid response search: %v", err)
			return
		}
		done <- res
	}()
	wire = recvTranscriptSearchRequest(t, stream)
	sendTranscriptSearchResponse(t, stream, "pane-ts2", process, &pibridgepb.TranscriptSearchResponse{
		RequestId: wire.GetRequestId(), SessionId: "sess", AnchorLeafId: "leaf", NextIndex: 1,
		Matches: []*pibridgepb.TranscriptSearchMatch{{EntryId: "entry", Role: "thinking", Snippet: "needle"}}, Complete: true,
	})
	result = <-done
	if !result.Unavailable || result.Complete || len(result.Matches) != 0 {
		t.Fatalf("invalid response did not fail closed: %+v", result)
	}
	if active, _ := s.Stats(); active != 1 {
		t.Fatalf("invalid search response closed lifecycle stream: active=%d", active)
	}
}

func TestRequestTranscriptSearchCapabilityGenerationAndTimeout(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, process, _, cancel := openLeaseStream(t, s, sock, "pane-ts3", CapabilityLifecycle)
	defer cancel()
	request := TranscriptSearchRequest{Query: "needle", Initial: true}
	if _, err := s.RequestTranscriptSearch(context.Background(), process, 1, request); err == nil || !strings.Contains(err.Error(), "not negotiated") {
		t.Fatalf("capability error %v", err)
	}

	cancel2, proc2 := func() (context.CancelFunc, string) {
		stream2, p, _, stop := openLeaseStream(t, s, sock, "pane-ts4", CapabilityLifecycle, CapabilityTranscriptSearch)
		_ = stream2
		return stop, p
	}()
	defer cancel2()
	if _, err := s.RequestTranscriptSearch(context.Background(), proc2, 2, request); err == nil || !strings.Contains(err.Error(), "generation stale") {
		t.Fatalf("generation error %v", err)
	}
	ctx, stop := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer stop()
	if _, err := s.RequestTranscriptSearch(ctx, proc2, 1, request); err == nil {
		t.Fatal("silent peer request did not time out")
	}
	if active, _ := s.Stats(); active != 2 {
		t.Fatalf("search timeout closed lifecycle stream: active=%d", active)
	}
	_ = stream
}

func TestRequestTranscriptSearchWorksAfterPeerReconnect(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream1, process, token, cancel1 := openLeaseStream(t, s, sock, "pane-ts-reconnect", CapabilityLifecycle, CapabilityTranscriptSearch)
	_ = stream1
	cancel1()

	stream2, cancel2 := openStream(t, sock, "pane-ts-reconnect", process, token)
	defer cancel2()
	hello := testHello("pane-ts-reconnect", process, 2, CapabilityLifecycle, CapabilityTranscriptSearch)
	hello.GetHello().RuntimeId = "rt2"
	hello.GetHello().SessionId = "sess2"
	hello.GetHello().GetCurrentState().SessionId = "sess2"
	if err := stream2.Send(hello); err != nil {
		t.Fatalf("reconnect hello: %v", err)
	}
	recvAccepted(t, stream2)

	done := make(chan TranscriptSearchResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		result, err := s.RequestTranscriptSearch(ctx, process, 2, TranscriptSearchRequest{Query: "needle", Initial: true})
		if err != nil {
			t.Errorf("search after reconnect: %v", err)
			return
		}
		done <- result
	}()
	wire := recvTranscriptSearchRequest(t, stream2)
	if wire.GetSessionId() != "sess2" || !wire.GetInitial() {
		t.Fatalf("reconnected request %+v", wire)
	}
	if err := stream2.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-ts-reconnect", ProcessId: process, RuntimeGeneration: 2,
		Payload: &pibridgepb.PiToPhi_TranscriptSearchResponse{TranscriptSearchResponse: &pibridgepb.TranscriptSearchResponse{
			RequestId: wire.GetRequestId(), SessionId: "sess2", AnchorLeafId: "leaf-2", NextIndex: 1,
			Matches: []*pibridgepb.TranscriptSearchMatch{{EntryId: "entry-2", Role: "user", Snippet: "needle after reconnect"}}, Complete: true,
		}},
	}); err != nil {
		t.Fatalf("reconnected response: %v", err)
	}
	result := <-done
	if result.Unavailable || result.ProcessID != process || result.Generation != 2 || result.SessionID != "sess2" || len(result.Matches) != 1 {
		t.Fatalf("reconnected result %+v", result)
	}
}

func TestValidateTranscriptSearchResponseUnicodeLiteralMatching(t *testing.T) {
	for _, tc := range []struct{ query, snippet string }{
		{"s", "before ſ after"},
		{"σ", "before ς after"},
		{"kx", "before Kx after"},
		{"[literal]", "before [LITERAL] after"},
	} {
		t.Run(tc.query, func(t *testing.T) {
			request := TranscriptSearchRequest{Query: tc.query, Initial: true}
			response := &pibridgepb.TranscriptSearchResponse{
				RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", NextIndex: 1,
				Matches: []*pibridgepb.TranscriptSearchMatch{{EntryId: "entry", Role: "assistant", Snippet: tc.snippet}}, Complete: true,
			}
			if _, ok := validateTranscriptSearchResponse(request, "sess", "t1", response); !ok {
				t.Fatal("valid Unicode literal match rejected")
			}
		})
	}
}

func TestValidateTranscriptSearchResponseRejectsBadPages(t *testing.T) {
	request := TranscriptSearchRequest{Query: "needle", Initial: true}
	valid := &pibridgepb.TranscriptSearchResponse{
		RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", NextIndex: 1,
		Matches: []*pibridgepb.TranscriptSearchMatch{{EntryId: "entry", Role: "user", Snippet: "needle"}}, Complete: true,
	}
	if _, ok := validateTranscriptSearchResponse(request, "sess", "t1", valid); !ok {
		t.Fatal("valid page rejected")
	}
	cases := map[string]*pibridgepb.TranscriptSearchResponse{
		"wrong-session":            {RequestId: "t1", SessionId: "other", AnchorLeafId: "leaf", NextIndex: 1, Complete: true},
		"non-progress":             {RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", Complete: false},
		"wrong-query":              {RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", NextIndex: 1, Matches: []*pibridgepb.TranscriptSearchMatch{{EntryId: "entry", Role: "user", Snippet: "no match"}}, Complete: true},
		"duplicate-entry":          {RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", NextIndex: 1, Matches: []*pibridgepb.TranscriptSearchMatch{{EntryId: "entry", Role: "user", Snippet: "needle"}, {EntryId: "entry", Role: "assistant", Snippet: "needle"}}, Complete: true},
		"overlong-snippet":         {RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", NextIndex: 1, Matches: []*pibridgepb.TranscriptSearchMatch{{EntryId: "entry", Role: "assistant", Snippet: strings.Repeat("x", maxTranscriptSnippetBytes+1) + "needle"}}, Complete: true},
		"unavailable-with-matches": {RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", NextIndex: 1, Matches: valid.Matches, Unavailable: true},
		"complete-and-unavailable": {RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", Complete: true, Unavailable: true},
		"cursor-jump":              {RequestId: "t1", SessionId: "sess", AnchorLeafId: "leaf", NextIndex: maxTranscriptSearchEntries + 1, Complete: true},
	}
	for name, response := range cases {
		t.Run(name, func(t *testing.T) {
			if _, ok := validateTranscriptSearchResponse(request, "sess", "t1", response); ok {
				t.Fatal("invalid response accepted")
			}
		})
	}
}
