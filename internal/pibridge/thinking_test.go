package pibridge

import (
	"context"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func recvThinkingLevelsRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan struct {
		msg *pibridgepb.PhiToPi
		err error
	}, 1)
	go func() {
		msg, err := stream.Recv()
		result <- struct {
			msg *pibridgepb.PhiToPi
			err error
		}{msg, err}
	}()
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatalf("recv thinking request: %v", got.err)
		}
		request := got.msg.GetThinkingLevelsRequest()
		if request == nil {
			t.Fatalf("not a thinking-level request: %v", got.msg.GetPayload())
		}
		return request.GetRequestId()
	case <-ctx.Done():
		t.Fatal("timed out waiting for thinking-level request")
		return ""
	}
}

func recvSetThinkingRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) (string, *pibridgepb.SetThinkingRequest) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan struct {
		msg *pibridgepb.PhiToPi
		err error
	}, 1)
	go func() {
		msg, err := stream.Recv()
		result <- struct {
			msg *pibridgepb.PhiToPi
			err error
		}{msg, err}
	}()
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatalf("recv set-thinking request: %v", got.err)
		}
		request := got.msg.GetSetThinkingRequest()
		if request == nil {
			t.Fatalf("not a set-thinking request: %v", got.msg.GetPayload())
		}
		return request.GetRequestId(), request
	case <-ctx.Done():
		t.Fatal("timed out waiting for set-thinking request")
		return "", nil
	}
}

func sendThinkingLevelsResponse(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, process string, generation uint64, response *pibridgepb.ThinkingLevelsResponse) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: process, RuntimeGeneration: generation,
		Payload: &pibridgepb.PiToPhi_ThinkingLevelsResponse{ThinkingLevelsResponse: response},
	}); err != nil {
		t.Fatalf("send thinking levels: %v", err)
	}
}

func sendSetThinkingAck(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, process string, generation uint64, ack *pibridgepb.SetThinkingAck) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: process, RuntimeGeneration: generation,
		Payload: &pibridgepb.PiToPhi_SetThinkingAck{SetThinkingAck: ack},
	}); err != nil {
		t.Fatalf("send set-thinking ack: %v", err)
	}
}

func TestRequestThinkingLevelsOriginAndValidation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, process, _, cancel := openLeaseStream(t, s, sock, "pane-thinking", CapabilityLifecycle, CapabilityThinking)
	defer cancel()

	type outcome struct {
		result ThinkingLevelsResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		result, err := s.RequestThinkingLevels(ctx, process)
		done <- outcome{result, err}
	}()
	id := recvThinkingLevelsRequest(t, stream)
	if id == "" {
		t.Fatal("empty request id")
	}
	// An invalid duplicate list is dropped without consuming the waiter.
	sendThinkingLevelsResponse(t, stream, "pane-thinking", process, 1, &pibridgepb.ThinkingLevelsResponse{
		RequestId: id, Provider: "p", Model: "m", Levels: []string{"high", "high"},
	})
	sendThinkingLevelsResponse(t, stream, "pane-thinking", process, 1, &pibridgepb.ThinkingLevelsResponse{
		RequestId: id, Provider: "p", Model: "m", Levels: []string{"off", "high", "xhigh", "max"},
	})
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("RequestThinkingLevels: %v", got.err)
		}
		if got.result.Unavailable || got.result.ProcessID != process || got.result.Generation != 1 || got.result.Provider != "p" || got.result.Model != "m" || len(got.result.Levels) != 4 {
			t.Fatalf("result %+v", got.result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("thinking list waiter hung")
	}
}

func TestRequestSetThinkingGenerationFenceAndRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, process, _, cancel := openLeaseStream(t, s, sock, "pane-set-thinking", CapabilityLifecycle, CapabilityThinking)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestSetThinking(ctx, process, 2, "high", "p", "m"); err == nil || !strings.Contains(err.Error(), "thinking peer identity changed") {
		t.Fatalf("stale generation not rejected: %v", err)
	}
	l, ok := s.reg.lookupByProcess(process)
	if !ok {
		t.Fatal("lease missing")
	}
	l.mu.Lock()
	peer := l.peer
	peer.modelsMu.Lock()
	pending := len(peer.setThinkingPending)
	peer.modelsMu.Unlock()
	l.mu.Unlock()
	if pending != 0 {
		t.Fatalf("stale generation admitted: pending=%d", pending)
	}

	done := make(chan struct {
		result SetThinkingResult
		err    error
	}, 1)
	go func() {
		result, err := s.RequestSetThinking(ctx, process, 1, "high", "p", "m")
		done <- struct {
			result SetThinkingResult
			err    error
		}{result, err}
	}()
	id, request := recvSetThinkingRequest(t, stream)
	if id == "" || request.GetLevel() != "high" || request.GetProvider() != "p" || request.GetModel() != "m" {
		t.Fatalf("request id=%q request=%+v", id, request)
	}
	sendSetThinkingAck(t, stream, "pane-set-thinking", process, 1, &pibridgepb.SetThinkingAck{RequestId: id, Reason: "<script>"})
	sendSetThinkingAck(t, stream, "pane-set-thinking", process, 1, &pibridgepb.SetThinkingAck{RequestId: id, Ok: true})
	select {
	case got := <-done:
		if got.err != nil || !got.result.OK || got.result.Reason != "" {
			t.Fatalf("result %+v error %v", got.result, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("set-thinking waiter hung")
	}
}
