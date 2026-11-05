package pibridge

import (
	"context"
	"slices"
	"strconv"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// TerminalRefreshResult is one terminal-repaint dispatch receipt.
// RequestID is the server-allocated monotonic ID, opaque to callers.
// DISPATCHED reports that the host ran its repaint; it never means the
// emitted bytes reached a viewer. Reason carries only the contract
// vocabulary and is empty for DISPATCHED.
type TerminalRefreshResult struct {
	RequestID string
	Outcome   pibridgepb.TerminalRefreshOutcome
	Reason    string
}

// terminalRefreshOp is the one in-flight repaint awaiting its receipt.
// The channel is buffered so delivery under the lease lock never blocks.
type terminalRefreshOp struct {
	id string
	ch chan TerminalRefreshResult
}

// refreshReason is the fixed receipt vocabulary. Anything else from the
// host is reported as "error" so no arbitrary string reaches a client.
func refreshReason(outcome pibridgepb.TerminalRefreshOutcome, reason string) string {
	if outcome == pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED {
		return ""
	}
	switch reason {
	case "unavailable", "pending", "stale", "queue-full", "resize-failed", "error":
		return reason
	default:
		return "error"
	}
}

// notSent builds a receipt for work that never reached the host.
func notSent(reason string) TerminalRefreshResult {
	return TerminalRefreshResult{
		Outcome: pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT,
		Reason:  refreshReason(pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT, reason),
	}
}

// unknown builds a receipt for admitted work without a trustworthy answer.
func unknown() TerminalRefreshResult {
	return TerminalRefreshResult{
		Outcome: pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_UNKNOWN,
		Reason:  "error",
	}
}

// RequestTerminalRefresh asks the live peer to repaint its TUI in place
// and waits up to one second for the receipt. It never submits a prompt,
// touches the editor draft, or waits for model work: a streaming turn
// must not block a repaint.
//
// At most one request is outstanding per peer; a second caller is
// refused as NOT_SENT/pending instead of queueing. Anything that fails
// before admission is NOT_SENT. After admission, a timeout, peer loss,
// or replaced peer is UNKNOWN: the repaint may still run, so callers
// must not retry it automatically.
func (s *Server) RequestTerminalRefresh(ctx context.Context, processID string) TerminalRefreshResult {
	if err := ctx.Err(); err != nil {
		return notSent("unavailable")
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return notSent("unavailable")
	}
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return notSent("unavailable")
	}
	if !slices.Contains(l.caps, CapabilityTerminalRefresh) {
		l.mu.Unlock()
		return notSent("unavailable")
	}
	// Positive canonical decimal, like every other server-allocated
	// request ID on this wire.
	id := strconv.FormatUint(s.refreshSeq.Add(1), 10)
	op := &terminalRefreshOp{id: id, ch: make(chan TerminalRefreshResult, 1)}
	p.refreshMu.Lock()
	if p.refreshOp != nil {
		p.refreshMu.Unlock()
		l.mu.Unlock()
		return notSent("pending")
	}
	p.refreshOp = op
	p.refreshMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_TerminalRefreshRequest{
			TerminalRefreshRequest: &pibridgepb.TerminalRefreshRequest{RequestId: id},
		},
	}
	// The reservation keeps lifecycle traffic ahead of a repaint, like the
	// other on-demand callers; a repaint must never displace an edge.
	if !p.enqueue(req, false, true) {
		p.clearRefresh(op)
		return notSent("queue-full")
	}
	timer := time.NewTimer(terminalRefreshDeadline)
	defer timer.Stop()
	select {
	case res := <-op.ch:
		if ctx.Err() != nil {
			return unknown()
		}
		// A receipt can be buffered before its peer is replaced or revoked.
		// Recheck at consumption, like the other bridge mutation receipts.
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return unknown()
		}
		return res
	case <-timer.C:
		p.clearRefresh(op)
		return unknown()
	case <-ctx.Done():
		p.clearRefresh(op)
		return unknown()
	case <-p.done:
		p.clearRefresh(op)
		return unknown()
	}
}

// clearRefresh releases op unless a receipt already retired it.
func (p *peer) clearRefresh(op *terminalRefreshOp) {
	if p == nil || op == nil {
		return
	}
	p.refreshMu.Lock()
	if p.refreshOp == op {
		p.refreshOp = nil
	}
	p.refreshMu.Unlock()
}

// deliverTerminalRefresh routes one ack to its waiter. Acks are replies,
// not authoritative state: empty, unsolicited, mismatched, late, and
// duplicate IDs are dropped, and only the waiter that sent the matching
// ID consumes the receipt exactly once.
func (s *Server) deliverTerminalRefresh(l *lease, p *peer, ack *pibridgepb.TerminalRefreshAck) {
	if ack.GetRequestId() == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.refreshMu.Lock()
	op := p.refreshOp
	if op == nil || op.id != ack.GetRequestId() {
		p.refreshMu.Unlock()
		return
	}
	p.refreshOp = nil
	p.refreshMu.Unlock()
	outcome := pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_UNKNOWN
	switch ack.GetOutcome() {
	case pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED:
		outcome = pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED
	case pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT:
		outcome = pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT
	}
	select {
	case op.ch <- TerminalRefreshResult{
		RequestID: op.id,
		Outcome:   outcome,
		Reason:    refreshReason(outcome, ack.GetReason()),
	}:
	default:
	}
}
