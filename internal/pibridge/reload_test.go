package pibridge

import (
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func recvReloadRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) *pibridgepb.PhiToPi {
	t.Helper()
	type result struct {
		msg *pibridgepb.PhiToPi
		err error
	}
	ch := make(chan result, 1)
	go func() {
		msg, err := stream.Recv()
		ch <- result{msg: msg, err: err}
	}()
	select {
	case got := <-ch:
		if got.err != nil {
			t.Fatalf("recv reload request: %v", got.err)
		}
		if got.msg.GetReloadRequest() == nil {
			t.Fatalf("not a reload request: %v", got.msg.GetPayload())
		}
		return got.msg
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for reload request")
		return nil
	}
}

func TestRequestReloadAdmission(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-r1", CapabilityLifecycle, CapabilityReload)
	defer cancel()

	if err := s.RequestReload(proc); err != nil {
		t.Fatalf("RequestReload: %v", err)
	}
	msg := recvReloadRequest(t, stream)
	if msg.GetPaneId() != "pane-r1" || msg.GetProcessId() != proc || msg.GetRuntimeGeneration() != 1 {
		t.Fatalf("identity %+v", msg)
	}
	state, ok := s.PaneState(proc)
	if !ok || !state.HasPeer {
		t.Fatalf("reload admission disturbed stream: state=%+v ok=%t", state, ok)
	}
}

func TestRequestReloadRequiresLiveNegotiatedPeer(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	if err := s.RequestReload("unknown"); err == nil || !strings.Contains(err.Error(), "unknown process") {
		t.Fatalf("unknown process error %v", err)
	}

	_, proc, _, cancel := openLeaseStream(t, s, sock, "pane-r2", CapabilityLifecycle)
	defer cancel()
	if err := s.RequestReload(proc); err == nil || !strings.Contains(err.Error(), "not negotiated") {
		t.Fatalf("missing capability error %v", err)
	}

	peerless, _, err := s.RegisterPending("pane-r3")
	if err != nil {
		t.Fatalf("RegisterPending: %v", err)
	}
	s.Complete(peerless)
	if err := s.RequestReload(peerless); err == nil || !strings.Contains(err.Error(), "no live peer") {
		t.Fatalf("peerless error %v", err)
	}
}

func TestRequestReloadQueueRefusalIsNonfatal(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	_, proc, _, cancel := openLeaseStream(t, s, sock, "pane-r4", CapabilityLifecycle, CapabilityReload)
	defer cancel()
	l, _ := s.reg.lookupByProcess(proc)
	l.mu.Lock()
	p := l.peer
	l.mu.Unlock()
	p.mu.Lock()
	p.outstanding = maxQueuedMessages
	p.mu.Unlock()

	if err := s.RequestReload(proc); err == nil || !strings.Contains(err.Error(), "not admitted") {
		t.Fatalf("queue refusal error %v", err)
	}
	p.mu.Lock()
	closed := p.closed
	p.outstanding = 0
	p.mu.Unlock()
	state, ok := s.PaneState(proc)
	if closed || !ok || !state.HasPeer {
		t.Fatalf("nonfatal refusal closed peer: closed=%t state=%+v ok=%t", closed, state, ok)
	}
}
