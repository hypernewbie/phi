package pibridge

import (
	"context"
	"strconv"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

const refreshDispatched = pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED

// recvRefreshRequest reads one outbound repaint request and returns its ID.
func recvRefreshRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type res struct {
		msg *pibridgepb.PhiToPi
		err error
	}
	ch := make(chan res, 1)
	go func() {
		m, e := stream.Recv()
		ch <- res{msg: m, err: e}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("recv refresh request: %v", r.err)
		}
		req := r.msg.GetTerminalRefreshRequest()
		if req == nil {
			t.Fatalf("not a terminal refresh request: %v", r.msg.GetPayload())
		}
		return req.GetRequestId()
	case <-ctx.Done():
		t.Fatalf("timed out waiting for terminal refresh request")
		return ""
	}
}

func sendRefreshAck(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc, id string, outcome pibridgepb.TerminalRefreshOutcome, reason string) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_TerminalRefreshAck{TerminalRefreshAck: &pibridgepb.TerminalRefreshAck{
			RequestId: id, Outcome: outcome, Reason: reason,
		}},
	}); err != nil {
		t.Fatalf("send refresh ack: %v", err)
	}
}

func TestRequestTerminalRefreshRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-r1", CapabilityLifecycle, CapabilityTerminalRefresh)
	defer cancel()

	type outcome struct {
		res TerminalRefreshResult
	}
	done := make(chan outcome, 1)
	go func() {
		done <- outcome{s.RequestTerminalRefresh(context.Background(), proc)}
	}()
	id := recvRefreshRequest(t, stream)
	if id == "" {
		t.Fatal("empty request id")
	}
	sendRefreshAck(t, stream, "pane-r1", proc, id, refreshDispatched, "")
	got := <-done
	if got.res.Outcome != refreshDispatched {
		t.Fatalf("outcome %v, want DISPATCHED", got.res.Outcome)
	}
	if got.res.Reason != "" {
		t.Fatalf("reason %q, want empty", got.res.Reason)
	}
	if got.res.RequestID != id {
		t.Fatalf("request id %q, want %q", got.res.RequestID, id)
	}

	// A second round trip mints a strictly newer server-owned ID.
	done = make(chan outcome, 1)
	go func() {
		done <- outcome{s.RequestTerminalRefresh(context.Background(), proc)}
	}()
	next := recvRefreshRequest(t, stream)
	firstID, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		t.Fatalf("parse id %q: %v", id, err)
	}
	secondID, err := strconv.ParseUint(next, 10, 64)
	if err != nil {
		t.Fatalf("parse id %q: %v", next, err)
	}
	if secondID <= firstID {
		t.Fatalf("request ids not monotonic: %q then %q", id, next)
	}
	sendRefreshAck(t, stream, "pane-r1", proc, next, refreshDispatched, "")
	if got := <-done; got.res.Outcome != refreshDispatched {
		t.Fatalf("second outcome %v, want DISPATCHED", got.res.Outcome)
	}
}

func TestRequestTerminalRefreshRefusals(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-r2", CapabilityLifecycle, CapabilityTerminalRefresh)
	defer cancel()

	if res := s.RequestTerminalRefresh(context.Background(), "missing"); res.Outcome != pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || res.Reason != "unavailable" {
		t.Fatalf("unknown process receipt %+v, want NOT_SENT/unavailable", res)
	}

	// One outstanding request per peer: the second caller is refused
	// without touching the host, and the first still completes.
	done := make(chan TerminalRefreshResult, 1)
	go func() { done <- s.RequestTerminalRefresh(context.Background(), proc) }()
	id := recvRefreshRequest(t, stream)
	if res := s.RequestTerminalRefresh(context.Background(), proc); res.Outcome != pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || res.Reason != "pending" {
		t.Fatalf("concurrent receipt %+v, want NOT_SENT/pending", res)
	}
	sendRefreshAck(t, stream, "pane-r2", proc, id, pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT, "unavailable")
	if res := <-done; res.Outcome != pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || res.Reason != "unavailable" {
		t.Fatalf("first receipt %+v, want NOT_SENT/unavailable passthrough", res)
	}
	// An off-vocabulary reason never reaches a client verbatim.
	done = make(chan TerminalRefreshResult, 1)
	go func() { done <- s.RequestTerminalRefresh(context.Background(), proc) }()
	id = recvRefreshRequest(t, stream)
	sendRefreshAck(t, stream, "pane-r2", proc, id, pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT, "arbitrary text")
	if res := <-done; res.Reason != "error" {
		t.Fatalf("reason %q, want sanitized %q", res.Reason, "error")
	}

	// Without the negotiated capability nothing is sent.
	s2, sock2, cleanup2 := testServer(t)
	defer cleanup2()
	plain, plainProc, _, cancelPlain := openLeaseStream(t, s2, sock2, "pane-r3", CapabilityLifecycle)
	defer cancelPlain()
	_ = plain
	if res := s2.RequestTerminalRefresh(context.Background(), plainProc); res.Outcome != pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || res.Reason != "unavailable" {
		t.Fatalf("missing capability receipt %+v, want NOT_SENT/unavailable", res)
	}
}

func TestRequestTerminalRefreshUncertain(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-r4", CapabilityLifecycle, CapabilityTerminalRefresh)
	defer cancel()

	start := time.Now()
	done := make(chan TerminalRefreshResult, 1)
	go func() { done <- s.RequestTerminalRefresh(context.Background(), proc) }()
	id := recvRefreshRequest(t, stream)
	res := <-done
	if res.Outcome != pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_UNKNOWN {
		t.Fatalf("silent host receipt %+v, want UNKNOWN", res)
	}
	if res.Reason != "error" {
		t.Fatalf("reason %q, want %q", res.Reason, "error")
	}
	if elapsed := time.Since(start); elapsed < terminalRefreshDeadline {
		t.Fatalf("receipt wait returned after %v, want at least %v", elapsed, terminalRefreshDeadline)
	}

	// A late ack for the abandoned ID cannot satisfy a later waiter.
	sendRefreshAck(t, stream, "pane-r4", proc, id, refreshDispatched, "")
	next := make(chan TerminalRefreshResult, 1)
	go func() { next <- s.RequestTerminalRefresh(context.Background(), proc) }()
	nextID := recvRefreshRequest(t, stream)
	if nextID == id {
		t.Fatalf("request id reused after timeout: %q", id)
	}
	sendRefreshAck(t, stream, "pane-r4", proc, nextID, refreshDispatched, "")
	if got := <-next; got.Outcome != refreshDispatched || got.RequestID != nextID {
		t.Fatalf("late ack satisfied the wrong waiter: %+v", got)
	}
}

func TestRequestTerminalRefreshPeerLoss(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-r5", CapabilityLifecycle, CapabilityTerminalRefresh)

	done := make(chan TerminalRefreshResult, 1)
	go func() { done <- s.RequestTerminalRefresh(context.Background(), proc) }()
	recvRefreshRequest(t, stream)
	// The peer disappears while the receipt is pending: the repaint may
	// still have run, so the receipt is UNKNOWN, never NOT_SENT.
	cancel()
	select {
	case res := <-done:
		if res.Outcome != pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_UNKNOWN {
			t.Fatalf("peer loss receipt %+v, want UNKNOWN", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("peer loss did not release the waiter")
	}
}

// TestTerminalRefreshQueueReservesLifecycleHeadroom proves the admission
// call used by RequestTerminalRefresh keeps the reserved lifecycle slots
// free and never closes the stream on overflow.
func TestTerminalRefreshQueueReservesLifecycleHeadroom(t *testing.T) {
	lifecycle := acceptedMsg(4)
	refresh := func() *pibridgepb.PhiToPi {
		return &pibridgepb.PhiToPi{
			PaneId: "pane", ProcessId: "proc", RuntimeGeneration: 1,
			Payload: &pibridgepb.PhiToPi_TerminalRefreshRequest{
				TerminalRefreshRequest: &pibridgepb.TerminalRefreshRequest{RequestId: "r1"},
			},
		}
	}
	p := newPeer(1, "sess", nil)
	for range maxQueuedMessages - syncboardLifecycleHeadroomMessages {
		if !p.enqueue(refresh(), false, true) {
			t.Fatal("refresh queue rejected before its reserved limit")
		}
	}
	if p.enqueue(refresh(), false, true) {
		t.Fatal("refresh used a reserved lifecycle message slot")
	}
	if !p.send(lifecycle) || !p.send(lifecycle) {
		t.Fatal("lifecycle messages could not use reserved queue slots")
	}
	if err := p.closeErr(); err != nil {
		t.Fatalf("refresh pressure closed the stream: %v", err)
	}
}
