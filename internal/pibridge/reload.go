package pibridge

import (
	"context"
	"math"
	"slices"
	"strconv"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// ReloadResult is one native-reload dispatch receipt. RequestID is the
// server-allocated monotonic ID, opaque to browsers. A DISPATCHED
// outcome reports native callback entry only, never reload
// completion. Reason carries only the contract vocabulary.
type ReloadResult struct {
	RequestID string
	Outcome   pibridgepb.ReloadDispatchOutcome
	Reason    string
}

// ReloadRefusal reports a Reload request refused before dispatch: the
// host was never invoked and no ID was allocated. Reason is the fixed
// safe vocabulary (stale, busy, queued, compaction-active,
// pending, duplicate, unavailable).
type ReloadRefusal struct {
	Reason string
}

// Error implements error.
func (e *ReloadRefusal) Error() string {
	return "pibridge: reload refused: " + e.Reason
}

// ReloadUnavailable reports a Reload request that could not dispatch:
// unknown process, no live peer, unnegotiated capability, or a bounded
// send-queue miss. The host was never invoked.
type ReloadUnavailable struct {
	msg string
}

// Error implements error.
func (e *ReloadUnavailable) Error() string {
	return "pibridge: reload unavailable: " + e.msg
}

// Reason maps the miss to the safe HTTP vocabulary. An unknown
// process means the browser's target moved on; every other miss
// means the host cannot act right now.
func (e *ReloadUnavailable) Reason() string {
	if e.msg == "unknown process" {
		return "stale"
	}
	return "unavailable"
}

// ReloadUnknown reports a dispatched Reload request without a
// trustworthy receipt: the caller wait expired or aborted, or the
// dispatch peer was lost or replaced. Native work may still run;
// this is never permission to replay. RequestID is the dispatched
// operation.
type ReloadUnknown struct {
	RequestID string
}

// Error implements error.
func (e *ReloadUnknown) Error() string {
	return "pibridge: reload outcome unknown"
}

// reloadOp is the one process-owned unresolved Reload operation. The
// record outlives its waiter and runtime replacement: a timeout,
// abort, peer loss, or new generation clears waiter but never the
// record, so no second invocation starts while native work may still
// run. Only a matching host refusal or fresh same-process readiness
// whose high-water mark covers the ID with explicit no-pending
// Reload retires it. A returned receipt never retires a dispatched
// operation: callback entry is not release.
//
// shortcut: a request whose send was admitted but never reached the
// host (peer died before the writer flushed it) leaves no pending
// evidence to reconcile, so the pane reports pending until Pi
// restarts. Retirement needs an explicit host-side release signal;
// generation change, timeout, and disconnect are not release.
type reloadOp struct {
	id string
	// ch carries the dispatch receipt to the waiter exactly once.
	// It is buffered so delivery under the lease lock never blocks.
	ch chan ReloadResult
	// waiter is true while the dispatching caller still waits.
	waiter bool
}

// RequestReload asks the live peer to run Pi's fixed native /reload
// command and waits for its dispatch receipt. The browser's
// generation, publication, run, and context stamps must match the
// live lease, and the current snapshot must show an idle host with
// no queued messages, no active compaction, and no unresolved bridge
// work; anything else is refused before dispatch without invoking
// the host. Expected host identities are captured from the lease
// under the same admission fence, never from the caller. At most one
// operation runs per process, and Reload refuses while a Compact is
// unresolved, like Compact refuses while a Reload is unresolved.
//
// A nil error carries the host's dispatch receipt, whatever its
// outcome. A *ReloadRefusal or *ReloadUnavailable means the host was
// never invoked. A *ReloadUnknown means the request dispatched but
// no trustworthy receipt reached the caller; the operation stays
// unresolved.
func (s *Server) RequestReload(ctx context.Context, processID string, generation, pubRev, runID, contextRev uint64) (ReloadResult, error) {
	if err := ctx.Err(); err != nil {
		return ReloadResult{}, &ReloadUnavailable{msg: "caller done"}
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return ReloadResult{}, &ReloadUnavailable{msg: "unknown process"}
	}
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadUnavailable{msg: "no live peer"}
	}
	if !slices.Contains(l.caps, CapabilityReload) {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadUnavailable{msg: "capability not negotiated"}
	}
	if generation != l.maxGen || pubRev != l.pubRev {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "stale"}
	}
	snap := l.lastState
	if snap == nil {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "stale"}
	}
	if l.reload != nil || l.compact != nil || l.attachment != nil {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "pending"}
	}
	if snap.GetState() == pibridgepb.LogicalState_LOGICAL_STATE_RUNNING {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "busy"}
	}
	ready := snap.GetReloadReadiness()
	if ready == nil {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "busy"}
	}
	// Missing counters invalidate the Reload sample. Absence is
	// unknown, never an implicit zero.
	if ready.RunId == nil || ready.ContextRevision == nil {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "busy"}
	}
	if *ready.RunId != runID || *ready.ContextRevision != contextRev {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "stale"}
	}
	if !ready.GetIdle() {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "busy"}
	}
	if ready.GetHasPendingMessages() {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "queued"}
	}
	if ready.GetCompactionActive() {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "compaction-active"}
	}
	if ready.GetCompactPending() || ready.GetReloadPending() {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "pending"}
	}
	session := snap.GetSessionId()
	if session == "" {
		session = l.sessionID
	}
	leaf := snap.GetLeafId()
	// A new empty session reads a null leaf, mapped to the known
	// empty value on both sides. Only the upper bound applies.
	if !validCompactIdentity(session) || len(leaf) > maxCompactIdentityChars {
		l.mu.Unlock()
		return ReloadResult{}, &ReloadRefusal{Reason: "stale"}
	}
	var expectedModel *pibridgepb.ModelSnapshot
	if m := snap.GetModel(); m != nil {
		if !validCompactIdentity(m.GetProvider()) || !validCompactIdentity(m.GetModel()) {
			l.mu.Unlock()
			return ReloadResult{}, &ReloadRefusal{Reason: "stale"}
		}
		expectedModel = &pibridgepb.ModelSnapshot{Provider: m.GetProvider(), Model: m.GetModel()}
	}
	// Absent expected model means the server expects no live model;
	// the host refuses when one is present.
	id, ok := s.allocReloadID()
	if !ok {
		// ID space exhausted: never wrap to "0" or reuse an ID.
		// Every later request fails the same way; nothing dispatches.
		l.mu.Unlock()
		return ReloadResult{}, &ReloadUnavailable{msg: "id space exhausted"}
	}
	op := &reloadOp{id: strconv.FormatUint(id, 10), ch: make(chan ReloadResult, 1), waiter: true}
	l.reload = op
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_ReloadRequest{
			ReloadRequest: &pibridgepb.ReloadRequest{
				RequestId:               op.id,
				ExpectedSessionId:       session,
				ExpectedLeafId:          leaf,
				ExpectedModel:           expectedModel,
				ExpectedRunId:           &runID,
				ExpectedContextRevision: &contextRev,
			},
		},
	}
	if !p.sendNonfatal(req) {
		// Never dispatched: release only our own record. A
		// concurrent new generation may already have retired it.
		l.mu.Lock()
		if l.reload == op {
			l.reload = nil
		}
		l.mu.Unlock()
		return ReloadResult{}, &ReloadUnavailable{msg: "request not admitted"}
	}
	select {
	case res := <-op.ch:
		if err := ctx.Err(); err != nil {
			return ReloadResult{}, &ReloadUnknown{RequestID: op.id}
		}
		// deliverReload accepted this receipt under the lease lock
		// from the current peer. A later replacement cannot revoke
		// that evidence for the original operation.
		return res, nil
	case <-ctx.Done():
		releaseReloadWaiter(l, op)
		return ReloadResult{}, &ReloadUnknown{RequestID: op.id}
	case <-p.done:
		return reloadResultAfterPeerLoss(l, op)
	}
}

// reloadResultAfterPeerLoss prefers a receipt already accepted under
// the lease lock before the peer closed. A missing receipt remains
// unknown and leaves the operation unresolved.
func reloadResultAfterPeerLoss(l *lease, op *reloadOp) (ReloadResult, error) {
	select {
	case res := <-op.ch:
		return res, nil
	default:
		releaseReloadWaiter(l, op)
		return ReloadResult{}, &ReloadUnknown{RequestID: op.id}
	}
}

// releaseReloadWaiter detaches a departing waiter from its operation.
// The operation stays unresolved: native work outlives the wait.
// Only release evidence retires it; expiry alone never does.
func releaseReloadWaiter(l *lease, op *reloadOp) {
	l.mu.Lock()
	if l.reload == op {
		op.waiter = false
	}
	l.mu.Unlock()
}

// allocReloadID allocates the next monotonic Reload request ID. The
// allocator saturates: once the uint64 space is exhausted every
// later call fails instead of wrapping to zero or reusing an ID.
// Safe for concurrent use; each success yields a unique positive ID.
func (s *Server) allocReloadID() (uint64, bool) {
	for {
		cur := s.reloadSeq.Load()
		if cur == math.MaxUint64 {
			return 0, false
		}
		if s.reloadSeq.CompareAndSwap(cur, cur+1) {
			return cur + 1, true
		}
	}
}

// reconcileReloadRetirement retires an unresolved Reload operation on
// genuine release evidence: fresh same-process readiness whose
// high-water mark covers the operation with explicit no-pending
// Reload. The caller must hold the lease lock and have established
// that the snapshot is current (Hello or current-peer live
// snapshot); anything else leaves the operation untouched. Absent
// readiness, absent counters, or an uncovered ID never retires.
// Retirement needs no waiter: release proves the native work ended,
// so a departed or waiting caller changes nothing. Never synthesizes
// a receipt.
func reconcileReloadRetirement(l *lease, snap *pibridgepb.StateSnapshot) {
	op := l.reload
	if op == nil {
		return
	}
	incoming := snap.GetReloadReadiness()
	if incoming == nil || incoming.HighWater == nil {
		return
	}
	want, err := strconv.ParseUint(op.id, 10, 64)
	if err != nil || *incoming.HighWater < want {
		return
	}
	if incoming.GetReloadPending() {
		return
	}
	l.reload = nil
}

// allowReloadReason coerces one host reason to the contract
// vocabulary. Unknown reasons become empty, never an error.
func allowReloadReason(reason string) string {
	switch reason {
	case "", "duplicate", "stale", "busy", "queued", "compaction-active",
		"pending", "unavailable":
		return reason
	default:
		return ""
	}
}

// deliverReload routes one ReloadAck to its operation. Receipts are
// replies to our requests, not authoritative state, so anything
// unexpected is dropped, never a protocol error: empty, unknown
// outcome, unsolicited, duplicate, and old-generation ids all land
// here. Only the current peer at the current generation on a live
// lease delivers: an obsolete same-generation peer or an
// older-generation stream never satisfies the waiter, while a
// legitimate same-generation reconnect recovery (same generation,
// current peer) still lands. Only the matching unresolved operation
// consumes a receipt, and only its still-waiting caller receives it,
// exactly once. A host refusal retires the operation: the host was
// never invoked. A dispatch receipt never retires: callback entry
// is not release, and only later readiness evidence releases the
// record. An UNSPECIFIED outcome is dropped, never delivered: it is
// unknown, never a refusal that permits replay.
func (s *Server) deliverReload(l *lease, p *peer, res *pibridgepb.ReloadAck) {
	if res.GetRequestId() == "" {
		return
	}
	switch res.GetOutcome() {
	case pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
		pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED:
	default:
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	op := l.reload
	if op == nil || op.id != res.GetRequestId() {
		return
	}
	result := ReloadResult{
		RequestID: op.id,
		Outcome:   res.GetOutcome(),
		Reason:    allowReloadReason(res.GetReason()),
	}
	if op.waiter {
		op.waiter = false
		select {
		case op.ch <- result:
		default:
		}
	}
	if res.GetOutcome() == pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED {
		l.reload = nil
	}
}
