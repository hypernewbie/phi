package pibridge

import (
	"context"
	"fmt"
	"slices"
	"strconv"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// SkillRef is one skill the Pi session knows. Name is the bare skill
// name without the "skill:" command prefix; Description is the host's
// own text. Both are bounded by the bridge wire limits, not by Pi:
// Pi validates character counts and only warns, so a loaded skill can
// still be unrepresentable here.
type SkillRef struct {
	Name        string
	Description string
}

// SkillsResult is one fulfilled on-demand skill-list read. Truncated
// means the list hit the entry cap and is partial; Unavailable means
// the answer cannot be represented on the wire. Callers surface both
// as an in-picker row: the list is best-effort and never disturbs
// lifecycle state.
type SkillsResult struct {
	Skills      []SkillRef
	Truncated   bool
	Unavailable bool
}

// InvokeSkillResult is one fulfilled on-demand skill invocation. OK
// means the request was dispatched to the Pi host; it never means the
// agent accepted or completed it. Reason is empty then, or one of
// 'unknown-skill', 'unavailable', 'error'. Reasons are safe to surface
// verbatim.
type InvokeSkillResult struct {
	OK     bool
	Reason string
}

// RequestSkills asks the live peer for the session's skills and waits
// for the correlated response. It fails fast without a live peer, a
// negotiated skills capability, pending-request room, or queue
// admission; it fails on context expiry or peer loss while waiting.
// A response from a replaced peer is rejected: only the peer that is
// still current when its answer arrives can fulfill the request.
func (s *Server) RequestSkills(ctx context.Context, processID string) (SkillsResult, error) {
	if err := ctx.Err(); err != nil {
		return SkillsResult{}, err
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return SkillsResult{}, fmt.Errorf("pibridge: unknown process")
	}
	id := "k" + strconv.FormatUint(s.skillsSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return SkillsResult{}, fmt.Errorf("pibridge: no live peer")
	}
	if !slices.Contains(l.caps, CapabilitySkills) {
		l.mu.Unlock()
		return SkillsResult{}, fmt.Errorf("pibridge: skills capability not negotiated")
	}
	p.skillsMu.Lock()
	if len(p.skillsPending) >= maxSkillsPending {
		p.skillsMu.Unlock()
		l.mu.Unlock()
		return SkillsResult{}, fmt.Errorf("pibridge: too many pending skills requests")
	}
	ch := make(chan SkillsResult, 1)
	p.skillsPending[id] = ch
	p.skillsMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_SkillsRequest{
			SkillsRequest: &pibridgepb.SkillsRequest{RequestId: id},
		},
	}
	if !p.sendNonfatal(req) {
		p.skillsMu.Lock()
		delete(p.skillsPending, id)
		p.skillsMu.Unlock()
		return SkillsResult{}, fmt.Errorf("pibridge: skills request not admitted")
	}
	select {
	case res := <-ch:
		if err := ctx.Err(); err != nil {
			return SkillsResult{}, err
		}
		// Fence delayed answers: a replacement between send and
		// delivery must not fulfill this caller.
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return SkillsResult{}, fmt.Errorf("pibridge: skills peer replaced")
		}
		return res, nil
	case <-ctx.Done():
		p.skillsMu.Lock()
		delete(p.skillsPending, id)
		p.skillsMu.Unlock()
		return SkillsResult{}, fmt.Errorf("pibridge: skills request: %w", ctx.Err())
	case <-p.done:
		p.skillsMu.Lock()
		delete(p.skillsPending, id)
		p.skillsMu.Unlock()
		if err := p.closeErr(); err != nil {
			return SkillsResult{}, err
		}
		return SkillsResult{}, fmt.Errorf("pibridge: skills peer gone")
	}
}

// RequestInvokeSkill asks the live peer to send one skill to Pi and
// waits for the correlated ack. Failure semantics mirror
// RequestSkills; an ack from a replaced peer is rejected the same way.
// The name is bounded here, so an oversized name never reaches the peer.
func (s *Server) RequestInvokeSkill(ctx context.Context, processID, name string) (InvokeSkillResult, error) {
	if err := ctx.Err(); err != nil {
		return InvokeSkillResult{}, err
	}
	if name == "" || len(name) > maxSkillNameBytes {
		return InvokeSkillResult{}, fmt.Errorf("pibridge: invalid skill name")
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return InvokeSkillResult{}, fmt.Errorf("pibridge: unknown process")
	}
	id := "i" + strconv.FormatUint(s.invokeSkillSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return InvokeSkillResult{}, fmt.Errorf("pibridge: no live peer")
	}
	if !slices.Contains(l.caps, CapabilitySkills) {
		l.mu.Unlock()
		return InvokeSkillResult{}, fmt.Errorf("pibridge: skills capability not negotiated")
	}
	p.skillsMu.Lock()
	if len(p.invokeSkillPending) >= maxSkillsPending {
		p.skillsMu.Unlock()
		l.mu.Unlock()
		return InvokeSkillResult{}, fmt.Errorf("pibridge: too many pending skill invocations")
	}
	ch := make(chan InvokeSkillResult, 1)
	p.invokeSkillPending[id] = ch
	p.skillsMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	req := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_InvokeSkillRequest{
			InvokeSkillRequest: &pibridgepb.InvokeSkillRequest{RequestId: id, Name: name},
		},
	}
	if !p.sendNonfatal(req) {
		p.skillsMu.Lock()
		delete(p.invokeSkillPending, id)
		p.skillsMu.Unlock()
		return InvokeSkillResult{}, fmt.Errorf("pibridge: invoke-skill request not admitted")
	}
	select {
	case res := <-ch:
		if err := ctx.Err(); err != nil {
			return InvokeSkillResult{}, err
		}
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return InvokeSkillResult{}, fmt.Errorf("pibridge: invoke-skill peer replaced")
		}
		return res, nil
	case <-ctx.Done():
		p.skillsMu.Lock()
		delete(p.invokeSkillPending, id)
		p.skillsMu.Unlock()
		return InvokeSkillResult{}, fmt.Errorf("pibridge: invoke-skill request: %w", ctx.Err())
	case <-p.done:
		p.skillsMu.Lock()
		delete(p.invokeSkillPending, id)
		p.skillsMu.Unlock()
		if err := p.closeErr(); err != nil {
			return InvokeSkillResult{}, err
		}
		return InvokeSkillResult{}, fmt.Errorf("pibridge: invoke-skill peer gone")
	}
}

// deliverSkills routes one SkillsResponse to its waiter. Responses are
// replies to our requests, not authoritative state, so anything
// unexpected is dropped, never a protocol error. Entries that break
// the wire bounds make the whole list unavailable: a partial list must
// never look like the session's complete skill set.
func (s *Server) deliverSkills(l *lease, p *peer, res *pibridgepb.SkillsResponse) {
	if res.GetRequestId() == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.skillsMu.Lock()
	ch, ok := p.skillsPending[res.GetRequestId()]
	if ok {
		delete(p.skillsPending, res.GetRequestId())
	}
	p.skillsMu.Unlock()
	if !ok {
		return
	}
	result := SkillsResult{Truncated: res.GetTruncated(), Unavailable: res.GetUnavailable()}
	if !result.Unavailable {
		skills := make([]SkillRef, 0, len(res.GetSkills()))
		for _, s := range res.GetSkills() {
			if !representableSkill(s.GetName(), s.GetDescription()) {
				result.Unavailable = true
				result.Skills = nil
				break
			}
			skills = append(skills, SkillRef{Name: s.GetName(), Description: s.GetDescription()})
		}
		if !result.Unavailable {
			if len(skills) > maxSkillEntries {
				skills = skills[:maxSkillEntries]
				result.Truncated = true
			}
			result.Skills = skills
		}
	}
	select {
	case ch <- result:
	default:
	}
}

// deliverInvokeSkill routes one InvokeSkillAck to its waiter.
// Unexpected acks are dropped, never a protocol error, exactly like
// models and set-model acks. The reason is allowlisted before
// delivery so only the contract vocabulary can reach callers.
func (s *Server) deliverInvokeSkill(l *lease, p *peer, ack *pibridgepb.InvokeSkillAck) {
	if ack.GetRequestId() == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
		return
	}
	p.skillsMu.Lock()
	ch, ok := p.invokeSkillPending[ack.GetRequestId()]
	if ok {
		delete(p.invokeSkillPending, ack.GetRequestId())
	}
	p.skillsMu.Unlock()
	if !ok {
		return
	}
	reason := ack.GetReason()
	switch reason {
	case "", "unknown-skill", "unavailable", "error":
	default:
		reason = ""
	}
	select {
	case ch <- InvokeSkillResult{OK: ack.GetOk(), Reason: reason}:
	default:
	}
}

// representableSkill reports whether one skill entry fits the wire
// bounds. The bounds are UTF-8 byte limits, and Go string length is
// the UTF-8 byte count.
func representableSkill(name, description string) bool {
	if name == "" || len(name) > maxSkillNameBytes {
		return false
	}
	return len(description) <= maxSkillDescriptionBytes
}
