package pibridge

import (
	"context"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func recvStateRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) string {
	t.Helper()
	done := make(chan *pibridgepb.PhiToPi, 1)
	go func() { msg, _ := stream.Recv(); done <- msg }()
	select {
	case msg := <-done:
		if msg.GetStateRequest().GetRequestId() == "" {
			t.Fatalf("expected state request, got %v", msg)
		}
		return msg.GetStateRequest().GetRequestId()
	case <-time.After(5 * time.Second):
		t.Fatal("no state request")
		return ""
	}
}

func TestRefreshStateCorrelatesAfterApplyingLiveSnapshot(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-state", CapabilityLifecycle, CapabilityState)
	defer cancel()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- s.RefreshState(ctx, proc) }()
	id := recvStateRequest(t, stream)
	send := func(requestID, leaf string) {
		t.Helper()
		msg := testState("pane-state", proc, 1, "p", "m")
		msg.GetStateSnapshot().RequestId = requestID
		msg.GetStateSnapshot().LeafId = leaf
		if err := stream.Send(msg); err != nil {
			t.Fatal(err)
		}
	}
	// Ordinary snapshots and unmatched replies cannot fulfill the read.
	send("", "unsolicited")
	send("unmatched", "unmatched-leaf")
	select {
	case err := <-done:
		t.Fatalf("unmatched snapshot fulfilled refresh: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	send(id, "metadata-leaf")
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
		view, ok := s.PaneState(proc)
		if !ok || view.LeafID != "metadata-leaf" {
			t.Fatalf("refresh completed before state applied: %+v", view)
		}
	case <-ctx.Done():
		t.Fatal("refresh hung")
	}
}

func TestRefreshStateMissingCapabilityAndPeer(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	_, proc, _, cancel := openLeaseStream(t, s, sock, "pane-legacy-state", CapabilityLifecycle)
	defer cancel()
	if err := s.RefreshState(context.Background(), proc); err == nil {
		t.Fatal("refresh succeeded without capability")
	}
	if err := s.RefreshState(context.Background(), "missing"); err == nil {
		t.Fatal("refresh succeeded without process")
	}
}

func TestRefreshStateDropsWaitersOnTimeoutAndPeerLoss(t *testing.T) {
	for _, loss := range []string{"timeout", "disconnect", "replacement"} {
		t.Run(loss, func(t *testing.T) {
			s, sock, cleanup := testServer(t)
			defer cleanup()
			stream, proc, token, cancel := openLeaseStream(t, s, sock, "pane-state-loss", CapabilityLifecycle, CapabilityState)
			defer cancel()
			ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			done := make(chan error, 1)
			go func() { done <- s.RefreshState(ctx, proc) }()
			recvStateRequest(t, stream)
			l, _ := s.reg.lookupByProcess(proc)
			l.mu.Lock()
			p := l.peer
			l.mu.Unlock()
			newDone := make(chan error, 1)
			switch loss {
			case "timeout":
				stop()
			case "disconnect":
				cancel()
			case "replacement":
				next, closeNext := openStream(t, sock, "pane-state-loss", proc, token)
				defer closeNext()
				if err := next.Send(testHello("pane-state-loss", proc, 2, CapabilityLifecycle, CapabilityState)); err != nil {
					t.Fatal(err)
				}
				recvAccepted(t, next)
				// The new peer still supports an independent refresh.
				go func() { newDone <- s.RefreshState(ctx, proc) }()
				id := recvStateRequest(t, next)
				msg := testState("pane-state-loss", proc, 2, "p", "m")
				msg.GetStateSnapshot().RequestId = id
				if err := next.Send(msg); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("lost peer fulfilled old refresh")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("refresh hung")
			}
			if loss == "replacement" {
				select {
				case err := <-newDone:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("replacement refresh hung")
				}
			}
			p.stateMu.Lock()
			pending := len(p.statePending)
			p.stateMu.Unlock()
			if pending != 0 {
				t.Fatalf("leaked %d pending reads", pending)
			}
		})
	}
}
