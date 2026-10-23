package pibridge

import (
	"context"
	"fmt"
	"slices"
	"strconv"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// ModelRef is one selectable catalog entry from the Pi session. Provider
// and Model match the bridge's ModelSnapshot naming; the Phi UI maps
// Model to its own id field at the edge.
type ModelRef struct {
	Provider string
	Model    string
}

// ModelsResult is one fulfilled on-demand model-list read. Models
// honors the session's scoped allowlist when scoping is configured;
// Truncated means the list hit the entry cap and is partial. Callers
// surface errors and unavailable results as an in-picker row and keep
// truncated lists usable: the list is best-effort and never disturbs
// lifecycle state.
type ModelsResult struct {
	Models      []ModelRef
	Truncated   bool
	Unavailable bool
}

// SetModelResult is one fulfilled on-demand model switch. OK means Pi
// accepted the switch; Reason is empty then. Reason is 'no-auth' when
// the provider has no configured credentials, 'unknown-model' when
// the entry is not selectable. Reasons are safe to surface verbatim.
type SetModelResult struct {
	OK     bool
	Reason string
}

// RequestModels asks the live peer for its selectable models and waits
// for the correlated response. It fails fast without a live peer, a
// negotiated models capability, pending-request room, or queue
// admission; it fails on context expiry or peer loss while waiting.
// A response from a replaced peer is rejected: only the peer that is
// still current when its answer arrives can fulfill the request.
func (s *Server) RequestModels(ctx context.Context, processID string) (ModelsResult, error) {
	if err := ctx.Err(); err != nil {
		return ModelsResult{}, err
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return ModelsResult{}, fmt.Errorf("pibridge: unknown process")
	}
	id := "m" + strconv.FormatUint(s.modelsSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return ModelsResult{}, fmt.Errorf("pibridge: no live peer")
	}
	if !slices.Contains(l.caps, CapabilityModels) {
		l.mu.Unlock()
		return ModelsResult{}, fmt.Errorf("pibridge: models capability not negotiated")
	}
	p.modelsMu.Lock()
	if len(p.modelsPending) >= maxModelsPending {
		p.modelsMu.Unlock()
		l.mu.Unlock()
		return ModelsResult{}, fmt.Errorf("pibridge: too many pending models requests")
	}
	ch := make(chan ModelsResult, 1)
	p.modelsPending[id] = ch
	p.modelsMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_ModelsRequest{
			ModelsRequest: &pibridgepb.ModelsRequest{RequestId: id},
		},
	}
	if !p.sendNonfatal(req) {
		p.modelsMu.Lock()
		delete(p.modelsPending, id)
		p.modelsMu.Unlock()
		return ModelsResult{}, fmt.Errorf("pibridge: models request not admitted")
	}
	select {
	case res := <-ch:
		if err := ctx.Err(); err != nil {
			return ModelsResult{}, err
		}
		// Fence delayed answers: a replacement between send and
		// delivery must not fulfill this caller.
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return ModelsResult{}, fmt.Errorf("pibridge: models peer replaced")
		}
		return res, nil
	case <-ctx.Done():
		p.modelsMu.Lock()
		delete(p.modelsPending, id)
		p.modelsMu.Unlock()
		return ModelsResult{}, fmt.Errorf("pibridge: models request: %w", ctx.Err())
	case <-p.done:
		p.modelsMu.Lock()
		delete(p.modelsPending, id)
		p.modelsMu.Unlock()
		if err := p.closeErr(); err != nil {
			return ModelsResult{}, err
		}
		return ModelsResult{}, fmt.Errorf("pibridge: models peer gone")
	}
}

// RequestSetModel asks the live peer to switch the session model and
// waits for the correlated ack. Failure semantics mirror
// RequestModels; an ack from a replaced peer is rejected the same way.
func (s *Server) RequestSetModel(ctx context.Context, processID, provider, model string) (SetModelResult, error) {
	if err := ctx.Err(); err != nil {
		return SetModelResult{}, err
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return SetModelResult{}, fmt.Errorf("pibridge: unknown process")
	}
	id := "s" + strconv.FormatUint(s.setSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return SetModelResult{}, fmt.Errorf("pibridge: no live peer")
	}
	if !slices.Contains(l.caps, CapabilityModels) {
		l.mu.Unlock()
		return SetModelResult{}, fmt.Errorf("pibridge: models capability not negotiated")
	}
	p.modelsMu.Lock()
	if len(p.setPending) >= maxModelsPending {
		p.modelsMu.Unlock()
		l.mu.Unlock()
		return SetModelResult{}, fmt.Errorf("pibridge: too many pending set-model requests")
	}
	ch := make(chan SetModelResult, 1)
	p.setPending[id] = ch
	p.modelsMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_SetModelRequest{
			SetModelRequest: &pibridgepb.SetModelRequest{RequestId: id, Provider: provider, Model: model},
		},
	}
	if !p.sendNonfatal(req) {
		p.modelsMu.Lock()
		delete(p.setPending, id)
		p.modelsMu.Unlock()
		return SetModelResult{}, fmt.Errorf("pibridge: set-model request not admitted")
	}
	select {
	case res := <-ch:
		if err := ctx.Err(); err != nil {
			return SetModelResult{}, err
		}
		// Fence delayed acks: a replacement between send and
		// delivery must not fulfill this caller.
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return SetModelResult{}, fmt.Errorf("pibridge: set-model peer replaced")
		}
		return res, nil
	case <-ctx.Done():
		p.modelsMu.Lock()
		delete(p.setPending, id)
		p.modelsMu.Unlock()
		return SetModelResult{}, fmt.Errorf("pibridge: set-model request: %w", ctx.Err())
	case <-p.done:
		p.modelsMu.Lock()
		delete(p.setPending, id)
		p.modelsMu.Unlock()
		if err := p.closeErr(); err != nil {
			return SetModelResult{}, err
		}
		return SetModelResult{}, fmt.Errorf("pibridge: set-model peer gone")
	}
}

// deliverModels routes one ModelsResponse to its waiter. Responses
// are replies to our requests, not authoritative state, so anything
// unexpected is dropped, never a protocol error: empty, stale,
// unsolicited, mismatched, timed-out, and duplicate ids all land
// here, and only an awaiting caller consumes a response, exactly once.
func (s *Server) deliverModels(l *lease, p *peer, res *pibridgepb.ModelsResponse) {
	if res.GetRequestId() == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.modelsMu.Lock()
	ch, ok := p.modelsPending[res.GetRequestId()]
	if ok {
		delete(p.modelsPending, res.GetRequestId())
	}
	p.modelsMu.Unlock()
	if !ok {
		return
	}
	models := make([]ModelRef, 0, len(res.GetModels()))
	for _, m := range res.GetModels() {
		if m.GetProvider() == "" || m.GetModel() == "" {
			continue
		}
		models = append(models, ModelRef{Provider: m.GetProvider(), Model: m.GetModel()})
	}
	select {
	case ch <- ModelsResult{Models: models, Truncated: res.GetTruncated(), Unavailable: res.GetUnavailable()}:
	default:
	}
}

// deliverSetModel routes one SetModelAck to its waiter. Unexpected
// acks are dropped, never a protocol error, exactly like history and
// models responses. The reason is allowlisted before delivery so only
// the contract vocabulary can reach callers.
func (s *Server) deliverSetModel(l *lease, p *peer, res *pibridgepb.SetModelAck) {
	if res.GetRequestId() == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.modelsMu.Lock()
	ch, ok := p.setPending[res.GetRequestId()]
	if ok {
		delete(p.setPending, res.GetRequestId())
	}
	p.modelsMu.Unlock()
	if !ok {
		return
	}
	reason := res.GetReason()
	switch reason {
	case "", "no-auth", "unknown-model":
	default:
		reason = ""
	}
	select {
	case ch <- SetModelResult{OK: res.GetOk(), Reason: reason}:
	default:
	}
}
