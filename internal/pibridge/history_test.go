package pibridge

import (
	"context"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// openLeaseStream registers a lease and opens an accepted stream
// advertising caps. It returns the stream, process ID, token, and cancel.
func openLeaseStream(t *testing.T, s *Server, sock, pane string, caps ...string) (pibridgepb.Integration_ConnectClient, string, string, context.CancelFunc) {
	t.Helper()
	proc, token, err := s.RegisterPending(pane)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, pane, proc, token)
	if err := stream.Send(testHello(pane, proc, 1, caps...)); err != nil {
		cancel()
		t.Fatalf("hello: %v", err)
	}
	recvAccepted(t, stream)
	return stream, proc, token, cancel
}

func recvHistoryRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) string {
	t.Helper()
	streamCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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
			t.Fatalf("recv request: %v", r.err)
		}
		req := r.msg.GetHistoryRequest()
		if req == nil {
			t.Fatalf("not a history request: %v", r.msg.GetPayload())
		}
		return req.GetRequestId()
	case <-streamCtx.Done():
		t.Fatalf("timed out waiting for history request")
		return ""
	}
}

func sendHistoryResponse(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, res *pibridgepb.HistoryResponse) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_HistoryResponse{HistoryResponse: res},
	}); err != nil {
		t.Fatalf("send response: %v", err)
	}
}

func TestRequestHistoryRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-h1", CapabilityLifecycle, CapabilityHistory)
	defer cancel()

	type outcome struct {
		res HistoryResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestHistory(ctx, proc)
		done <- outcome{res: res, err: err}
	}()
	id := recvHistoryRequest(t, stream)
	if id == "" {
		t.Fatal("empty request id")
	}
	sendHistoryResponse(t, stream, "pane-h1", proc, &pibridgepb.HistoryResponse{
		RequestId: id, Entries: []string{"b", "a"},
	})
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestHistory: %v", o.err)
		}
		if o.res.Unavailable || len(o.res.Entries) != 2 || o.res.Entries[0] != "b" || o.res.Entries[1] != "a" {
			t.Fatalf("result %+v", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestHistory hung")
	}
}

func TestRequestHistoryUnavailable(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-h2", CapabilityLifecycle, CapabilityHistory)
	defer cancel()

	done := make(chan HistoryResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestHistory(ctx, proc)
		if err != nil {
			t.Errorf("RequestHistory: %v", err)
			return
		}
		done <- res
	}()
	id := recvHistoryRequest(t, stream)
	sendHistoryResponse(t, stream, "pane-h2", proc, &pibridgepb.HistoryResponse{RequestId: id, Unavailable: true})
	select {
	case res := <-done:
		if !res.Unavailable || len(res.Entries) != 0 {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestHistory hung")
	}
}

func TestRequestHistoryNegotiation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()

	// Lifecycle-only peers never receive a request.
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-h3", CapabilityLifecycle)
	defer cancel()
	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := s.RequestHistory(ctx, proc); err == nil || !strings.Contains(err.Error(), "not negotiated") {
		t.Fatalf("err %v, want not-negotiated", err)
	}

	// Unknown processes and peerless leases fail fast.
	if _, err := s.RequestHistory(ctx, "nope"); err == nil {
		t.Fatal("unknown process succeeded")
	}
	proc2, _, err := s.RegisterPending("pane-h3b")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc2)
	if _, err := s.RequestHistory(ctx, proc2); err == nil || !strings.Contains(err.Error(), "no live peer") {
		t.Fatalf("err %v, want no-live-peer", err)
	}
	_ = stream
}

func TestRequestHistoryTimeoutDropsLateReply(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-h4", CapabilityLifecycle, CapabilityHistory)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer stop()
		_, err := s.RequestHistory(ctx, proc)
		errCh <- err
	}()
	id := recvHistoryRequest(t, stream)
	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "history request") {
			t.Fatalf("err %v, want timeout", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestHistory hung")
	}
	// The late reply matches nothing and the next request is clean.
	sendHistoryResponse(t, stream, "pane-h4", proc, &pibridgepb.HistoryResponse{RequestId: id, Entries: []string{"late"}})
	time.Sleep(100 * time.Millisecond)
	l, _ := s.reg.lookupByProcess(proc)
	l.mu.Lock()
	p := l.peer
	l.mu.Unlock()
	p.histMu.Lock()
	pending := len(p.histPending)
	p.histMu.Unlock()
	if pending != 0 {
		t.Fatalf("pending %d, want 0", pending)
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	done := make(chan HistoryResult, 1)
	go func() {
		res, err := s.RequestHistory(ctx, proc)
		if err != nil {
			t.Errorf("second RequestHistory: %v", err)
			return
		}
		done <- res
	}()
	id2 := recvHistoryRequest(t, stream)
	if id2 == id {
		t.Fatal("request id reused")
	}
	sendHistoryResponse(t, stream, "pane-h4", proc, &pibridgepb.HistoryResponse{RequestId: id2, Entries: []string{"ok"}})
	select {
	case res := <-done:
		if len(res.Entries) != 1 || res.Entries[0] != "ok" {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second RequestHistory hung")
	}
}

func TestRequestHistoryIgnoresUnknownAndDuplicate(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-h5", CapabilityLifecycle, CapabilityHistory)
	defer cancel()

	done := make(chan HistoryResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestHistory(ctx, proc)
		if err != nil {
			t.Errorf("RequestHistory: %v", err)
			return
		}
		done <- res
	}()
	id := recvHistoryRequest(t, stream)
	// Unsolicited and empty ids never reach the waiter.
	sendHistoryResponse(t, stream, "pane-h5", proc, &pibridgepb.HistoryResponse{RequestId: "h999", Entries: []string{"bogus"}})
	sendHistoryResponse(t, stream, "pane-h5", proc, &pibridgepb.HistoryResponse{Entries: []string{"empty"}})
	sendHistoryResponse(t, stream, "pane-h5", proc, &pibridgepb.HistoryResponse{RequestId: id, Entries: []string{"real"}})
	select {
	case res := <-done:
		if len(res.Entries) != 1 || res.Entries[0] != "real" {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestHistory hung")
	}
	// A duplicate of the consumed id is dropped, not redelivered.
	sendHistoryResponse(t, stream, "pane-h5", proc, &pibridgepb.HistoryResponse{RequestId: id, Entries: []string{"dup"}})
	time.Sleep(100 * time.Millisecond)
	l, _ := s.reg.lookupByProcess(proc)
	l.mu.Lock()
	p := l.peer
	l.mu.Unlock()
	p.histMu.Lock()
	pending := len(p.histPending)
	p.histMu.Unlock()
	if pending != 0 {
		t.Fatalf("pending %d, want 0", pending)
	}
}

func TestRequestHistoryPendingCap(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-h6", CapabilityLifecycle, CapabilityHistory)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	type outcome struct {
		res HistoryResult
		err error
	}
	results := make(chan outcome, maxHistoryPending+1)
	for i := 0; i < maxHistoryPending; i++ {
		go func() {
			res, err := s.RequestHistory(ctx, proc)
			results <- outcome{res: res, err: err}
		}()
	}
	ids := map[string]bool{}
	for i := 0; i < maxHistoryPending; i++ {
		ids[recvHistoryRequest(t, stream)] = true
	}
	if len(ids) != maxHistoryPending {
		t.Fatalf("ids %v, want %d unique", ids, maxHistoryPending)
	}
	// The cap counts requests awaiting replies: one more fails fast.
	if _, err := s.RequestHistory(ctx, proc); err == nil || !strings.Contains(err.Error(), "too many pending") {
		t.Fatalf("err %v, want too-many-pending", err)
	}
	// Answering one frees room for the next caller.
	var first string
	for id := range ids {
		first = id
		break
	}
	sendHistoryResponse(t, stream, "pane-h6", proc, &pibridgepb.HistoryResponse{RequestId: first, Entries: []string{"one"}})
	select {
	case o := <-results:
		if o.err != nil || len(o.res.Entries) != 1 {
			t.Fatalf("outcome %+v", o)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first waiter hung")
	}
	go func() {
		res, err := s.RequestHistory(ctx, proc)
		results <- outcome{res: res, err: err}
	}()
	next := recvHistoryRequest(t, stream)
	if ids[next] {
		t.Fatalf("id %s reused", next)
	}
}

func TestRequestHistoryPeerLossFailsWaiters(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-h7", CapabilityLifecycle, CapabilityHistory)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestHistory(ctx, proc)
		errCh <- err
	}()
	recvHistoryRequest(t, stream)
	s.Revoke(proc)
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("waiter succeeded after revoke")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after revoke")
	}
}

func TestRequestHistoryReplacementFailsStaleWaiter(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel := openLeaseStream(t, s, sock, "pane-h8", CapabilityLifecycle, CapabilityHistory)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestHistory(ctx, proc)
		errCh <- err
	}()
	recvHistoryRequest(t, stream)

	// A generation-2 reconnect replaces the stream; the gen-1 waiter
	// must fail rather than accept a late gen-1 answer.
	stream2, cancel2 := openStream(t, sock, "pane-h8", proc, token)
	defer cancel2()
	hello2 := testHello("pane-h8", proc, 2, CapabilityLifecycle, CapabilityHistory)
	hello2.GetHello().RuntimeId = "rt2"
	hello2.GetHello().SessionId = "sess2"
	hello2.GetHello().GetCurrentState().SessionId = "sess2"
	if err := stream2.Send(hello2); err != nil {
		t.Fatalf("hello2: %v", err)
	}
	recvAccepted(t, stream2)
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("stale waiter succeeded after replacement")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stale waiter hung after replacement")
	}
}

type peerDown struct {
	pane, proc string
	gen        uint64
}

func collectPeerDowns(s *Server) chan peerDown {
	downs := make(chan peerDown, 8)
	s.SetOnPeerDown(func(paneID, processID string, generation uint64) {
		downs <- peerDown{pane: paneID, proc: processID, gen: generation}
	})
	return downs
}

func TestPeerDownPublishesOnDisconnect(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	downs := collectPeerDowns(s)
	_, proc, _, cancel := openLeaseStream(t, s, sock, "pane-pd1", CapabilityLifecycle)
	cancel()
	select {
	case d := <-downs:
		if d.pane != "pane-pd1" || d.proc != proc || d.gen != 1 {
			t.Fatalf("down %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no peer-down published")
	}
	select {
	case d := <-downs:
		t.Fatalf("duplicate peer-down %+v", d)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestPeerDownSilentOnReplacement(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	downs := collectPeerDowns(s)
	stream1, proc, token, cancel1 := openLeaseStream(t, s, sock, "pane-pd2", CapabilityLifecycle)
	stream2, cancel2 := openStream(t, sock, "pane-pd2", proc, token)
	defer cancel2()
	hello2 := testHello("pane-pd2", proc, 2, CapabilityLifecycle)
	hello2.GetHello().RuntimeId = "rt2"
	hello2.GetHello().SessionId = "sess2"
	hello2.GetHello().GetCurrentState().SessionId = "sess2"
	if err := stream2.Send(hello2); err != nil {
		t.Fatalf("hello2: %v", err)
	}
	recvAccepted(t, stream2)
	_ = stream1
	// Closing the replaced stream detaches a peer that is no longer
	// active: silent. Closing the current stream publishes once.
	cancel1()
	time.Sleep(300 * time.Millisecond)
	select {
	case d := <-downs:
		t.Fatalf("spurious peer-down %+v", d)
	default:
	}
	cancel2()
	select {
	case d := <-downs:
		if d.gen != 2 {
			t.Fatalf("down %+v, want gen 2", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no peer-down for the current stream")
	}
}
