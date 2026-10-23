package pibridge

import (
	"context"
	"fmt"
	"slices"
	"strconv"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// HistoryResult is one fulfilled on-demand editor-history read. Entries
// is newest-first; it is empty when Unavailable is set. Callers treat
// every error and every unavailable result as "fall back to pre-bridge
// behavior": history is best-effort and never disturbs lifecycle state.
type HistoryResult struct {
	Entries     []string
	Unavailable bool
}

// RequestHistory asks the live peer for its editor history and waits
// for the correlated response. It fails fast without a live peer, a
// negotiated history capability, pending-request room, or queue
// admission; it fails on context expiry or peer loss while waiting.
// A response from a replaced peer is rejected: only the peer that is
// still current when its answer arrives can fulfill the request.
func (s *Server) RequestHistory(ctx context.Context, processID string) (HistoryResult, error) {
	if err := ctx.Err(); err != nil {
		return HistoryResult{}, err
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return HistoryResult{}, fmt.Errorf("pibridge: unknown process")
	}
	id := "h" + strconv.FormatUint(s.histSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return HistoryResult{}, fmt.Errorf("pibridge: no live peer")
	}
	if !slices.Contains(l.caps, CapabilityHistory) {
		l.mu.Unlock()
		return HistoryResult{}, fmt.Errorf("pibridge: history capability not negotiated")
	}
	p.histMu.Lock()
	if len(p.histPending) >= maxHistoryPending {
		p.histMu.Unlock()
		l.mu.Unlock()
		return HistoryResult{}, fmt.Errorf("pibridge: too many pending history requests")
	}
	ch := make(chan HistoryResult, 1)
	p.histPending[id] = ch
	p.histMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_HistoryRequest{
			HistoryRequest: &pibridgepb.HistoryRequest{RequestId: id},
		},
	}
	if !p.sendNonfatal(req) {
		p.histMu.Lock()
		delete(p.histPending, id)
		p.histMu.Unlock()
		return HistoryResult{}, fmt.Errorf("pibridge: history request not admitted")
	}
	select {
	case res := <-ch:
		if err := ctx.Err(); err != nil {
			return HistoryResult{}, err
		}
		// Fence delayed answers: a replacement between send and
		// delivery must not fulfill this caller.
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return HistoryResult{}, fmt.Errorf("pibridge: history peer replaced")
		}
		return res, nil
	case <-ctx.Done():
		p.histMu.Lock()
		delete(p.histPending, id)
		p.histMu.Unlock()
		return HistoryResult{}, fmt.Errorf("pibridge: history request: %w", ctx.Err())
	case <-p.done:
		p.histMu.Lock()
		delete(p.histPending, id)
		p.histMu.Unlock()
		if err := p.closeErr(); err != nil {
			return HistoryResult{}, err
		}
		return HistoryResult{}, fmt.Errorf("pibridge: history peer gone")
	}
}

// deliverHistory routes one HistoryResponse to its waiter. Responses
// are replies to our requests, not authoritative state, so anything
// unexpected is dropped, never a protocol error: empty, stale,
// unsolicited, mismatched, timed-out, and duplicate ids all land
// here, and only an awaiting caller consumes a response, exactly once.
func (s *Server) deliverHistory(l *lease, p *peer, res *pibridgepb.HistoryResponse) {
	if res.GetRequestId() == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.histMu.Lock()
	ch, ok := p.histPending[res.GetRequestId()]
	if ok {
		delete(p.histPending, res.GetRequestId())
	}
	p.histMu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- HistoryResult{Entries: res.GetEntries(), Unavailable: res.GetUnavailable()}:
	default:
	}
}
