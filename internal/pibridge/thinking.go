package pibridge

import (
	"context"
	"fmt"
	"slices"
	"strconv"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

var thinkingLevels = [...]string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// ThinkingLevelsResult is one correlated native list read and identifies the
// process generation that answered it.
type ThinkingLevelsResult struct {
	Levels      []string
	Provider    string
	Model       string
	Unavailable bool
	ProcessID   string
	Generation  uint64
}

// SetThinkingResult is one correlated native setter acknowledgement.
type SetThinkingResult struct {
	OK     bool
	Reason string
}

func validThinkingLevel(level string) bool {
	return level == "" || slices.Contains(thinkingLevels[:], level)
}

// IsThinkingLevel reports whether level is one of Pi's exact native levels.
func IsThinkingLevel(level string) bool {
	return level != "" && validThinkingLevel(level)
}

func validThinkingIdentity(provider, model string, allowEmpty bool) bool {
	if len(provider) > maxThinkingField || len(model) > maxThinkingField {
		return false
	}
	if allowEmpty {
		return (provider == "" && model == "") || (provider != "" && model != "")
	}
	return provider != "" && model != ""
}

// RequestThinkingLevels asks one live peer for its supported thinking levels.
// Result origin is captured from that peer and is required by later setters.
func (s *Server) RequestThinkingLevels(ctx context.Context, processID string) (ThinkingLevelsResult, error) {
	if err := ctx.Err(); err != nil {
		return ThinkingLevelsResult{}, err
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return ThinkingLevelsResult{}, fmt.Errorf("pibridge: unknown process")
	}
	id := "t" + strconv.FormatUint(s.thinkingSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return ThinkingLevelsResult{}, fmt.Errorf("pibridge: no live peer")
	}
	if !slices.Contains(l.caps, CapabilityThinking) {
		l.mu.Unlock()
		return ThinkingLevelsResult{}, fmt.Errorf("pibridge: thinking capability not negotiated")
	}
	p.modelsMu.Lock()
	if len(p.thinkingPending) >= maxThinkingPending {
		p.modelsMu.Unlock()
		l.mu.Unlock()
		return ThinkingLevelsResult{}, fmt.Errorf("pibridge: too many pending thinking requests")
	}
	ch := make(chan ThinkingLevelsResult, 1)
	p.thinkingPending[id] = ch
	p.modelsMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_ThinkingLevelsRequest{
			ThinkingLevelsRequest: &pibridgepb.ThinkingLevelsRequest{RequestId: id},
		},
	}
	if !p.sendNonfatal(req) {
		p.modelsMu.Lock()
		delete(p.thinkingPending, id)
		p.modelsMu.Unlock()
		return ThinkingLevelsResult{}, fmt.Errorf("pibridge: thinking request not admitted")
	}
	select {
	case res := <-ch:
		if err := ctx.Err(); err != nil {
			return ThinkingLevelsResult{}, err
		}
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return ThinkingLevelsResult{}, fmt.Errorf("pibridge: thinking peer replaced")
		}
		return res, nil
	case <-ctx.Done():
		p.modelsMu.Lock()
		delete(p.thinkingPending, id)
		p.modelsMu.Unlock()
		return ThinkingLevelsResult{}, fmt.Errorf("pibridge: thinking request: %w", ctx.Err())
	case <-p.done:
		p.modelsMu.Lock()
		delete(p.thinkingPending, id)
		p.modelsMu.Unlock()
		if err := p.closeErr(); err != nil {
			return ThinkingLevelsResult{}, err
		}
		return ThinkingLevelsResult{}, fmt.Errorf("pibridge: thinking peer gone")
	}
}

// RequestSetThinking sets one supported native level only on the peer whose
// process and generation the caller observed. Both identities are checked
// under the lease lock before pending registration or queue admission.
func (s *Server) RequestSetThinking(ctx context.Context, processID string, generation uint64, level, provider, model string) (SetThinkingResult, error) {
	if err := ctx.Err(); err != nil {
		return SetThinkingResult{}, err
	}
	if processID == "" || generation == 0 || len(processID) > maxThinkingField ||
		len(level) == 0 || len(level) > maxThinkingLevel || !validThinkingLevel(level) ||
		!validThinkingIdentity(provider, model, false) {
		return SetThinkingResult{}, fmt.Errorf("pibridge: invalid thinking request")
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return SetThinkingResult{}, fmt.Errorf("pibridge: unknown process")
	}
	id := "q" + strconv.FormatUint(s.setThinkingSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return SetThinkingResult{}, fmt.Errorf("pibridge: no live peer")
	}
	if l.processID != processID || p.generation != generation || l.maxGen != generation {
		l.mu.Unlock()
		return SetThinkingResult{}, fmt.Errorf("pibridge: thinking peer identity changed")
	}
	if !slices.Contains(l.caps, CapabilityThinking) {
		l.mu.Unlock()
		return SetThinkingResult{}, fmt.Errorf("pibridge: thinking capability not negotiated")
	}
	p.modelsMu.Lock()
	if len(p.setThinkingPending) >= maxThinkingPending {
		p.modelsMu.Unlock()
		l.mu.Unlock()
		return SetThinkingResult{}, fmt.Errorf("pibridge: too many pending set-thinking requests")
	}
	ch := make(chan SetThinkingResult, 1)
	p.setThinkingPending[id] = ch
	p.modelsMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_SetThinkingRequest{
			SetThinkingRequest: &pibridgepb.SetThinkingRequest{RequestId: id, Level: level, Provider: provider, Model: model},
		},
	}
	if !p.sendNonfatal(req) {
		p.modelsMu.Lock()
		delete(p.setThinkingPending, id)
		p.modelsMu.Unlock()
		return SetThinkingResult{}, fmt.Errorf("pibridge: set-thinking request not admitted")
	}
	select {
	case res := <-ch:
		if err := ctx.Err(); err != nil {
			return SetThinkingResult{}, err
		}
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return SetThinkingResult{}, fmt.Errorf("pibridge: set-thinking peer replaced")
		}
		return res, nil
	case <-ctx.Done():
		p.modelsMu.Lock()
		delete(p.setThinkingPending, id)
		p.modelsMu.Unlock()
		return SetThinkingResult{}, fmt.Errorf("pibridge: set-thinking request: %w", ctx.Err())
	case <-p.done:
		p.modelsMu.Lock()
		delete(p.setThinkingPending, id)
		p.modelsMu.Unlock()
		if err := p.closeErr(); err != nil {
			return SetThinkingResult{}, err
		}
		return SetThinkingResult{}, fmt.Errorf("pibridge: set-thinking peer gone")
	}
}

func (s *Server) deliverThinkingLevels(l *lease, p *peer, res *pibridgepb.ThinkingLevelsResponse) {
	if res.GetRequestId() == "" || !validThinkingIdentity(res.GetProvider(), res.GetModel(), true) ||
		(!res.GetUnavailable() && (res.GetProvider() == "" || res.GetModel() == "")) {
		return
	}
	levels := res.GetLevels()
	if len(levels) > maxThinkingLevels || (res.GetUnavailable() && len(levels) != 0) {
		return
	}
	seen := make(map[string]struct{}, len(levels))
	for _, level := range levels {
		if len(level) == 0 || len(level) > maxThinkingLevel || !validThinkingLevel(level) {
			return
		}
		if _, ok := seen[level]; ok {
			return
		}
		seen[level] = struct{}{}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.modelsMu.Lock()
	ch, ok := p.thinkingPending[res.GetRequestId()]
	if ok {
		delete(p.thinkingPending, res.GetRequestId())
	}
	p.modelsMu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- ThinkingLevelsResult{
		Levels: append([]string(nil), levels...), Provider: res.GetProvider(), Model: res.GetModel(),
		Unavailable: res.GetUnavailable(), ProcessID: l.processID, Generation: p.generation,
	}:
	default:
	}
}

func (s *Server) deliverSetThinking(l *lease, p *peer, res *pibridgepb.SetThinkingAck) {
	if res.GetRequestId() == "" {
		return
	}
	reason := res.GetReason()
	switch reason {
	case "", "unsupported-level", "model-changed":
	default:
		return
	}
	if res.GetOk() && reason != "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.modelsMu.Lock()
	ch, ok := p.setThinkingPending[res.GetRequestId()]
	if ok {
		delete(p.setThinkingPending, res.GetRequestId())
	}
	p.modelsMu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- SetThinkingResult{OK: res.GetOk(), Reason: reason}:
	default:
	}
}
