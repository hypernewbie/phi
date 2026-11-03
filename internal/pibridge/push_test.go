package pibridge

import (
	"errors"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// recvNotification reads until a SyncboardNotification arrives, skipping the
// state and lifecycle messages that share the stream.
func recvNotification(t *testing.T, stream pibridgepb.Integration_ConnectClient) *pibridgepb.SyncboardNotification {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
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
				t.Fatalf("recv: %v", r.err)
			}
			if n := r.msg.GetSyncboardNotification(); n != nil {
				return n
			}
		case <-time.After(time.Until(deadline)):
			t.Fatal("timed out waiting for a syncboard notification")
		}
	}
	t.Fatal("timed out waiting for a syncboard notification")
	return nil
}

func leaseFor(t *testing.T, s *Server, pane string) *lease {
	t.Helper()
	s.reg.mu.Lock()
	l := s.reg.byPane[pane]
	s.reg.mu.Unlock()
	if l == nil {
		t.Fatalf("no lease for pane %q", pane)
	}
	return l
}

func pushServer(t *testing.T) (*Server, string, func()) {
	t.Helper()
	s, sock, cleanup := testServer(t)
	s.EnableSyncboardPush(true)
	return s, sock, cleanup
}

// TestSyncboardPushReachesRuntime is the delivery invariant: an addressed
// message reaches the pane runtime that negotiated the capability.
func TestSyncboardPushReachesRuntime(t *testing.T) {
	s, sock, cleanup := pushServer(t)
	defer cleanup()
	stream, _, _, cancel := openLeaseStream(t, s, sock, "pane-push", CapabilityLifecycle, CapabilitySyncboardPush)
	defer cancel()

	if err := s.SendSyncboardPush("pane-push", SyncboardPush{
		Seq: 4, Sender: "agent-a", Recipient: "pane-push",
		Value: []byte("hello"), MessageID: "m-1",
	}); err != nil {
		t.Fatalf("send: %v", err)
	}
	n := recvNotification(t, stream)
	if string(n.GetValue()) != "hello" || n.GetMessageId() != "m-1" || n.GetSeq() != 4 {
		t.Fatalf("notification = %v", n)
	}
	if got := leaseFor(t, s, "pane-push").pendingPushCount(); got != 1 {
		t.Fatalf("pending = %d, want 1 until acknowledged", got)
	}
}

// TestSyncboardPushRequiresCapability proves a runtime that never advertised
// the capability is never sent one, even with the server flag on.
func TestSyncboardPushRequiresCapability(t *testing.T) {
	s, sock, cleanup := pushServer(t)
	defer cleanup()
	_, _, _, cancel := openLeaseStream(t, s, sock, "pane-nocap", CapabilityLifecycle)
	defer cancel()

	err := s.SendSyncboardPush("pane-nocap", SyncboardPush{Recipient: "pane-nocap", Value: []byte("x"), MessageID: "m-1"})
	if !errors.Is(err, ErrPushUnavailable) {
		t.Fatalf("err = %v, want ErrPushUnavailable", err)
	}
	if got := leaseFor(t, s, "pane-nocap").pendingPushCount(); got != 0 {
		t.Fatalf("pending = %d, want nothing retained", got)
	}
}

// TestSyncboardPushUnknownPane proves an unaddressable pane is refused rather
// than silently dropped into another lease.
func TestSyncboardPushUnknownPane(t *testing.T) {
	s, _, cleanup := pushServer(t)
	defer cleanup()

	if err := s.SendSyncboardPush("pane-missing", SyncboardPush{Recipient: "pane-missing", Value: []byte("x"), MessageID: "m-1"}); !errors.Is(err, ErrPushUnavailable) {
		t.Fatalf("err = %v, want ErrPushUnavailable", err)
	}
}

// TestSyncboardPushAckClearsPending is the acknowledgement invariant: once the
// runtime confirms a message id, Phi stops retaining it for resend.
func TestSyncboardPushAckClearsPending(t *testing.T) {
	s, sock, cleanup := pushServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-ack", CapabilityLifecycle, CapabilitySyncboardPush)
	defer cancel()

	if err := s.SendSyncboardPush("pane-ack", SyncboardPush{Recipient: "pane-ack", Value: []byte("x"), MessageID: "m-1"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	_ = recvNotification(t, stream)

	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-ack", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_SyncboardPushAck{
			SyncboardPushAck: &pibridgepb.SyncboardPushAck{Seq: 1, MessageId: "m-1"},
		},
	}); err != nil {
		t.Fatalf("ack: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if leaseFor(t, s, "pane-ack").pendingPushCount() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("acknowledged push is still retained")
}

// TestSyncboardPushBacklogIsBounded protects memory: a runtime that never
// acknowledges cannot grow the pending map without limit, and the oldest entry
// is the one dropped.
func TestSyncboardPushBacklogIsBounded(t *testing.T) {
	s, sock, cleanup := pushServer(t)
	defer cleanup()
	stream, _, _, cancel := openLeaseStream(t, s, sock, "pane-full", CapabilityLifecycle, CapabilitySyncboardPush)
	defer cancel()
	// Drain the stream so the peer's outbound queue, not the pending map,
	// is not what limits this test.
	go func() {
		for {
			if _, err := stream.Recv(); err != nil {
				return
			}
		}
	}()

	for i := 0; i < maxPendingPushes+5; i++ {
		id := "m-" + string(rune('a'+i))
		if err := s.SendSyncboardPush("pane-full", SyncboardPush{Recipient: "pane-full", Value: []byte("x"), MessageID: id}); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	l := leaseFor(t, s, "pane-full")
	if got := l.pendingPushCount(); got != maxPendingPushes {
		t.Fatalf("pending = %d, want %d", got, maxPendingPushes)
	}
	l.mu.Lock()
	_, keptOldest := l.pendingPushes["m-a"]
	l.mu.Unlock()
	if keptOldest {
		t.Fatal("oldest entry survived overflow; eviction is not oldest-first")
	}
}

// TestSyncboardPushResentAfterReconnect keeps the promise in the contract: an
// unacknowledged message is replayed on a fresh stream instead of lost.
func TestSyncboardPushResentAfterReconnect(t *testing.T) {
	s, sock, cleanup := pushServer(t)
	defer cleanup()
	stream, proc, token, cancel := openLeaseStream(t, s, sock, "pane-resend", CapabilityLifecycle, CapabilitySyncboardPush)

	if err := s.SendSyncboardPush("pane-resend", SyncboardPush{Recipient: "pane-resend", Value: []byte("missed"), MessageID: "m-1"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	_ = recvNotification(t, stream)
	cancel()
	time.Sleep(50 * time.Millisecond)

	stream2, cancel2 := openStream(t, sock, "pane-resend", proc, token)
	defer cancel2()
	if err := stream2.Send(testHello("pane-resend", proc, 1, CapabilityLifecycle, CapabilitySyncboardPush)); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	recvAccepted(t, stream2)

	n := recvNotification(t, stream2)
	if n.GetMessageId() != "m-1" || string(n.GetValue()) != "missed" {
		t.Fatalf("resend = %v, want the unacknowledged message", n)
	}
}

// TestSyncboardPushRejectsBadInput guards the wire bounds.
func TestSyncboardPushRejectsBadInput(t *testing.T) {
	s, sock, cleanup := pushServer(t)
	defer cleanup()
	_, _, _, cancel := openLeaseStream(t, s, sock, "pane-bad", CapabilityLifecycle, CapabilitySyncboardPush)
	defer cancel()

	if err := s.SendSyncboardPush("pane-bad", SyncboardPush{Recipient: "pane-bad", Value: []byte("x")}); err == nil {
		t.Fatal("empty message id accepted")
	}
	big := make([]byte, MaxSyncboardValueBytes+1)
	if err := s.SendSyncboardPush("pane-bad", SyncboardPush{Recipient: "pane-bad", Value: big, MessageID: "m-big"}); err == nil {
		t.Fatal("oversized value accepted")
	}
}

func TestSyncboardPushWithoutServerFlag(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	_, _, _, cancel := openLeaseStream(t, s, sock, "pane-off", CapabilityLifecycle, CapabilitySyncboardPush)
	defer cancel()

	// The capability was advertised but the server never enabled it, so
	// negotiation dropped it and a push stays refused.
	if err := s.SendSyncboardPush("pane-off", SyncboardPush{Recipient: "pane-off", Value: []byte("x"), MessageID: "m-1"}); !errors.Is(err, ErrPushUnavailable) {
		t.Fatalf("err = %v, want ErrPushUnavailable", err)
	}
}
