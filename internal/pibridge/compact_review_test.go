package pibridge

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func parentReviewLease(t *testing.T) (*Server, *lease, *peer, string) {
	t.Helper()
	s := NewServer()
	proc, _, err := s.RegisterPending("parent-review")
	if err != nil {
		t.Fatal(err)
	}
	s.Complete(proc)
	l, _ := s.reg.lookupByProcess(proc)
	p := newPeer(1, "sess", newBlockingStream())
	l.peer, l.maxGen, l.runtimeID, l.sessionID = p, 1, "rt", "sess"
	l.caps = []string{CapabilityCompact}
	l.lastState = &pibridgepb.StateSnapshot{
		State:     pibridgepb.LogicalState_LOGICAL_STATE_IDLE,
		SessionId: "sess", LeafId: "leaf",
		CompactReadiness: idleReadiness(),
	}
	return s, l, p, proc
}

func TestCompactRejectsStalePeer(t *testing.T) {
	s, l, _, _ := parentReviewLease(t)
	stale := newPeer(1, "sess", newBlockingStream())
	op := &compactOp{id: "1", ch: make(chan CompactResult, 1), waiter: true}
	l.compact = op
	err := s.handleMessage(l, stale, &pibridgepb.PiToPhi{
		Payload: &pibridgepb.PiToPhi_CompactResult{CompactResult: &pibridgepb.CompactResult{
			RequestId: "1", Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-op.ch:
		t.Fatal("stale peer satisfied the waiter")
	default:
	}
	if l.compact != op {
		t.Fatal("stale peer released process work")
	}
}

func TestCompactRecoversReadiness(t *testing.T) {
	s, l, p, _ := parentReviewLease(t)
	l.compact = &compactOp{id: "1", ch: make(chan CompactResult, 1), waiter: false}
	l.lastState.CompactReadiness.BridgePending = true
	err := s.handleMessage(l, p, &pibridgepb.PiToPhi{
		Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: &pibridgepb.StateSnapshot{
			State:     pibridgepb.LogicalState_LOGICAL_STATE_IDLE,
			SessionId: "sess", LeafId: "leaf-after",
			CompactReadiness: idleReadiness(), StateRevision: 3,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if l.compact != nil {
		t.Fatal("pending-to-released authoritative readiness left the broker permanently pending")
	}
}

func TestCompactSequenceSaturates(t *testing.T) {
	s, l, p, proc := parentReviewLease(t)
	s.compactSeq.Store(math.MaxUint64)
	for i := 0; i < 2; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		_, err := s.RequestCompact(ctx, proc, 1, l.pubRev)
		cancel()
		var unavailable *CompactUnavailable
		if !errors.As(err, &unavailable) {
			t.Fatalf("attempt %d reused exhausted ID space: %v", i+1, err)
		}
	}
	if len(p.sendCh) != 0 {
		t.Fatal("exhausted allocator dispatched a request")
	}
}
