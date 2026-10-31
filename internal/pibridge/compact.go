package pibridge

import (
	"context"
	"math"
	"slices"
	"strconv"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// CompactResult is one terminal native-compaction outcome. RequestID is
// the server-allocated monotonic ID, opaque to browsers. Outcome and
// Reason carry only the contract vocabulary: the outcome is one of the
// CompactOutcome enum values and the reason is allowlisted before
// delivery, so neither can carry host or provider text.
type CompactResult struct {
	RequestID string
	Outcome   pibridgepb.CompactOutcome
	Reason    string
}

// CompactRefusal reports a Compact request refused before dispatch: the
// host was never invoked and no ID was allocated. Reason is the fixed
// safe vocabulary (stale, busy, queued, compaction-active, pending).
type CompactRefusal struct {
	Reason string
}

// Error implements error.
func (e *CompactRefusal) Error() string {
	return "pibridge: compact refused: " + e.Reason
}

// CompactUnavailable reports a Compact request that could not dispatch:
// unknown process, no live peer, unnegotiated capability, or a bounded
// send-queue miss. The host was never invoked.
type CompactUnavailable struct {
	msg string
}

// Error implements error.
func (e *CompactUnavailable) Error() string {
	return "pibridge: compact unavailable: " + e.msg
}

// CompactUnknown reports a dispatched Compact request whose outcome is
// unknown: the caller wait expired or aborted, or the dispatch peer
// was lost or replaced. Native work may still run; this is never
// permission to replay. RequestID is the dispatched operation.
type CompactUnknown struct {
	RequestID string
}

// Error implements error.
func (e *CompactUnknown) Error() string {
	return "pibridge: compact outcome unknown"
}

// compactOp is the one process-owned unresolved Compact operation. The
// record outlives its waiter: a timeout, abort, or peer loss clears
// waiter but never the record, so no second invocation starts while
// native work may still run. Only a matching terminal host result, a
// confirmed pending-to-released readiness transition, a new runtime
// generation, or lease revoke releases it.
//
// shortcut: a request whose send was admitted but never reached the
// host (peer died before the writer flushed it) leaves no pending
// evidence to reconcile, so the pane reports pending until Pi restarts.
// Upgrade only with a host-side acknowledgement for admission.
type compactOp struct {
	id string
	// ch carries the terminal result to the waiter exactly once. It
	// is buffered so delivery under the lease lock never blocks.
	ch chan CompactResult
	// waiter is true while the dispatching caller still waits.
	waiter bool
	// releasedObserved records a genuine pending-to-released
	// readiness transition seen while a waiter was still
	// attached. The waiter's departure completes the retirement;
	// expiry alone never sets this flag.
	releasedObserved bool
	// pendingObserved records an explicit bridge-pending sample
	// seen on the current runtime while this operation stayed
	// unresolved. It survives intervening unknown (absent
	// readiness) samples, which are never evidence for or
	// against release and must not erase it.
	pendingObserved bool
}

// maxCompactIdentityChars bounds one expected session/leaf/model
// identity, matching the wire contract.
const maxCompactIdentityChars = 256

// RequestCompact asks the live peer to run one native compaction and
// waits for its terminal result. The browser's generation and
// publication stamps must match the live lease, and the current
// snapshot must show an idle host with no queued messages, no active
// compaction, and no unresolved bridge work; anything else is refused
// before dispatch without invoking the host. Expected host identities
// are captured from the lease under the same admission fence, never
// from the caller. At most one operation runs per process.
//
// A nil error carries the host's terminal result, whatever its
// outcome. A *CompactRefusal or *CompactUnavailable means the host
// was never invoked. A *CompactUnknown means the request dispatched
// but the wait ended first; the operation stays unresolved.
func (s *Server) RequestCompact(ctx context.Context, processID string, generation, pubRev uint64) (CompactResult, error) {
	if err := ctx.Err(); err != nil {
		return CompactResult{}, &CompactUnavailable{msg: "caller done"}
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return CompactResult{}, &CompactUnavailable{msg: "unknown process"}
	}
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return CompactResult{}, &CompactUnavailable{msg: "no live peer"}
	}
	if !slices.Contains(l.caps, CapabilityCompact) {
		l.mu.Unlock()
		return CompactResult{}, &CompactUnavailable{msg: "capability not negotiated"}
	}
	if generation != l.maxGen || pubRev != l.pubRev {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "stale"}
	}
	snap := l.lastState
	if snap == nil {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "stale"}
	}
	// Cross-mutation exclusion: neither native mutation runs
	// while the other remains unresolved.
	if l.compact != nil || l.reload != nil {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "pending"}
	}
	if snap.GetState() == pibridgepb.LogicalState_LOGICAL_STATE_RUNNING {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "busy"}
	}
	ready := snap.GetCompactReadiness()
	if ready == nil {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "busy"}
	}
	if !ready.GetIdle() {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "busy"}
	}
	if ready.GetHasPendingMessages() {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "queued"}
	}
	if ready.GetCompactionActive() {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "compaction-active"}
	}
	if ready.GetBridgePending() {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "pending"}
	}
	session := snap.GetSessionId()
	if session == "" {
		session = l.sessionID
	}
	leaf := snap.GetLeafId()
	if !validCompactIdentity(session) || !validCompactIdentity(leaf) {
		l.mu.Unlock()
		return CompactResult{}, &CompactRefusal{Reason: "stale"}
	}
	var expectedModel *pibridgepb.ModelSnapshot
	if m := snap.GetModel(); m != nil {
		if !validCompactIdentity(m.GetProvider()) || !validCompactIdentity(m.GetModel()) {
			l.mu.Unlock()
			return CompactResult{}, &CompactRefusal{Reason: "stale"}
		}
		expectedModel = &pibridgepb.ModelSnapshot{Provider: m.GetProvider(), Model: m.GetModel()}
	}
	// Absent expected model means the server expects no live model;
	// the host refuses when one is present.
	id, ok := s.allocCompactID()
	if !ok {
		// ID space exhausted: never wrap to "0" or reuse an ID.
		// Every later request fails the same way; nothing dispatches.
		l.mu.Unlock()
		return CompactResult{}, &CompactUnavailable{msg: "id space exhausted"}
	}
	op := &compactOp{id: strconv.FormatUint(id, 10), ch: make(chan CompactResult, 1), waiter: true}
	l.compact = op
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_CompactRequest{
			CompactRequest: &pibridgepb.CompactRequest{
				RequestId:         op.id,
				ExpectedSessionId: session,
				ExpectedLeafId:    leaf,
				ExpectedModel:     expectedModel,
			},
		},
	}
	if !p.sendNonfatal(req) {
		// Never dispatched: release only our own record. A
		// concurrent new generation may already have replaced it.
		l.mu.Lock()
		if l.compact == op {
			l.compact = nil
		}
		l.mu.Unlock()
		return CompactResult{}, &CompactUnavailable{msg: "request not admitted"}
	}
	select {
	case res := <-op.ch:
		if err := ctx.Err(); err != nil {
			return CompactResult{}, &CompactUnknown{RequestID: op.id}
		}
		// Fence delayed results, like RequestSetModel: a
		// replacement between delivery and consumption must not
		// fulfill this caller. The matching terminal result
		// already resolved the operation itself; only this
		// caller is fenced, and no unrelated work is cleared.
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return CompactResult{}, &CompactUnknown{RequestID: op.id}
		}
		return res, nil
	case <-ctx.Done():
		releaseCompactWaiter(l, op)
		return CompactResult{}, &CompactUnknown{RequestID: op.id}
	case <-p.done:
		releaseCompactWaiter(l, op)
		return CompactResult{}, &CompactUnknown{RequestID: op.id}
	}
}

// releaseCompactWaiter detaches a departing waiter from its operation.
// The operation stays unresolved: native work outlives the wait. A
// genuine release transition observed while the waiter was attached
// completes its retirement now; expiry alone never retires.
func releaseCompactWaiter(l *lease, op *compactOp) {
	l.mu.Lock()
	if l.compact == op {
		op.waiter = false
		if op.releasedObserved {
			l.compact = nil
		}
	}
	l.mu.Unlock()
}

// allocCompactID allocates the next monotonic Compact request ID.
// The allocator saturates: once the uint64 space is exhausted every
// later call fails instead of wrapping to zero or reusing an ID.
// Safe for concurrent use; each success yields a unique positive ID.
func (s *Server) allocCompactID() (uint64, bool) {
	for {
		cur := s.compactSeq.Load()
		if cur == math.MaxUint64 {
			return 0, false
		}
		if s.compactSeq.CompareAndSwap(cur, cur+1) {
			return cur + 1, true
		}
	}
}

// reconcileCompactRelease retires an unresolved Compact operation on
// genuine release evidence: an explicit bridge-pending observation on
// the current runtime followed by an explicit released sample. The
// caller must hold the lease lock and have established that the
// snapshot is current (same-generation Hello or current-peer live
// snapshot); anything else leaves the operation untouched. Absent
// readiness is unknown, never termination: it neither retires the
// operation nor erases a prior pending observation, which the
// operation retains across unknown samples (and which may seed from
// valid retained pending evidence). While a waiter is still attached
// the release is only recorded, so an in-flight terminal result
// still reaches it; the waiter's departure completes the
// retirement. Never synthesizes a result.
func reconcileCompactRelease(l *lease, snap *pibridgepb.StateSnapshot) {
	op := l.compact
	if op == nil {
		return
	}
	incoming := snap.GetCompactReadiness()
	if incoming == nil {
		return
	}
	if incoming.GetBridgePending() {
		op.pendingObserved = true
		return
	}
	if !op.pendingObserved {
		if l.lastState == nil || l.lastState.GetCompactReadiness() == nil ||
			!l.lastState.GetCompactReadiness().GetBridgePending() {
			return
		}
		op.pendingObserved = true
	}
	op.releasedObserved = true
	if !op.waiter {
		l.compact = nil
	}
}

func validCompactIdentity(s string) bool {
	return len(s) >= 1 && len(s) <= maxCompactIdentityChars
}

// allowCompactReason coerces one host reason to the contract
// vocabulary. Unknown reasons become empty, never an error.
func allowCompactReason(reason string) string {
	switch reason {
	case "", "duplicate", "stale", "busy", "queued", "compaction-active",
		"pending", "unavailable", "cancelled", "already-compacted",
		"error", "uncertain":
		return reason
	default:
		return ""
	}
}

// deliverCompact routes one CompactResult to its operation. Results
// are replies to our requests, not authoritative state, so anything
// unexpected is dropped, never a protocol error: empty, unknown
// outcome, unsolicited, duplicate, and old-generation ids all land
// here. Only the current peer at the current generation on a live
// lease delivers: an obsolete same-generation peer or an
// older-generation stream never satisfies the waiter or releases
// process work, while a legitimate same-generation reconnect
// recovery (same generation, current peer) still lands. Only the
// matching unresolved operation consumes a result, and only its
// still-waiting caller receives it, exactly once. A terminal result
// releases the operation. UNSPECIFIED keeps the record while no
// release evidence exists, because the host retains its own latch;
// once a pending-to-released transition was observed, the retired
// native work cannot come back, so the record goes too.
func (s *Server) deliverCompact(l *lease, p *peer, res *pibridgepb.CompactResult) {
	if res.GetRequestId() == "" {
		return
	}
	switch res.GetOutcome() {
	case pibridgepb.CompactOutcome_COMPACT_OUTCOME_UNSPECIFIED,
		pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
		pibridgepb.CompactOutcome_COMPACT_OUTCOME_REFUSED,
		pibridgepb.CompactOutcome_COMPACT_OUTCOME_FAILED,
		pibridgepb.CompactOutcome_COMPACT_OUTCOME_CANCELLED:
	default:
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	op := l.compact
	if op == nil || op.id != res.GetRequestId() {
		return
	}
	result := CompactResult{
		RequestID: op.id,
		Outcome:   res.GetOutcome(),
		Reason:    allowCompactReason(res.GetReason()),
	}
	if op.waiter {
		op.waiter = false
		select {
		case op.ch <- result:
		default:
		}
	}
	if res.GetOutcome() != pibridgepb.CompactOutcome_COMPACT_OUTCOME_UNSPECIFIED || op.releasedObserved {
		l.compact = nil
	}
}
