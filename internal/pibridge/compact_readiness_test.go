package pibridge

import (
	"testing"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func TestCompactMissingReadinessNeverReleases(t *testing.T) {
	for _, waiter := range []bool{false, true} {
		name := "detached"
		if waiter {
			name = "attached"
		}
		t.Run(name, func(t *testing.T) {
			s, l, p, _ := parentReviewLease(t)
			op := &compactOp{id: "1", ch: make(chan CompactResult, 1), waiter: waiter}
			l.compact = op
			l.lastState.CompactReadiness.BridgePending = true
			// Optional telemetry can disappear. An absent readiness message
			// is unknown, not proof that the native process latch released.
			unknown := idleSnapshotWithReadiness("sess", "leaf", 2, nil)
			if err := s.handleMessage(l, p, &pibridgepb.PiToPhi{
				Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: unknown},
			}); err != nil {
				t.Fatal(err)
			}
			if l.compact != op || op.releasedObserved {
				t.Fatal("missing readiness was treated as confirmed native termination")
			}
			if waiter {
				releaseCompactWaiter(l, op)
			}
			if l.compact != op {
				t.Fatal("waiter expiry after missing readiness released native work")
			}
		})
	}
}

func TestCompactPendingEvidenceSurvivesUnknown(t *testing.T) {
	s, l, p, _ := parentReviewLease(t)
	op := &compactOp{id: "1", ch: make(chan CompactResult, 1), waiter: false}
	l.compact = op
	// Start with no pending sample, then observe pending, unknown, and
	// explicit release on the same current runtime. Unknown must neither
	// release the work nor erase the prior positive pending observation.
	for i, readiness := range []*pibridgepb.CompactReadiness{
		{Idle: true, BridgePending: true}, nil, {Idle: true},
	} {
		snap := idleSnapshotWithReadiness("sess", "leaf", uint64(i+2), readiness)
		if err := s.handleMessage(l, p, &pibridgepb.PiToPhi{
			Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: snap},
		}); err != nil {
			t.Fatal(err)
		}
		if i < 2 && l.compact != op {
			t.Fatalf("step %d released work without explicit termination evidence", i)
		}
	}
	if l.compact != nil {
		t.Fatal("explicit release after unknown telemetry left operation pending")
	}
}
