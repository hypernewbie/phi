package pibridge

import (
	"context"
	"fmt"
	"slices"
	"strconv"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// RefreshState waits until the current peer has published a correlated live
// snapshot. Event-time state is not sufficient: extensions can append entries
// while idle without emitting any lifecycle event. This read never sends input.
func (s *Server) RefreshState(ctx context.Context, processID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return fmt.Errorf("pibridge: unknown process")
	}
	id := "s" + strconv.FormatUint(s.stateSeq.Add(1), 10)
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked || !slices.Contains(l.caps, CapabilityState) {
		l.mu.Unlock()
		return fmt.Errorf("pibridge: live state unavailable")
	}
	p.stateMu.Lock()
	if len(p.statePending) >= maxStatePending {
		p.stateMu.Unlock()
		l.mu.Unlock()
		return fmt.Errorf("pibridge: too many pending state requests")
	}
	ch := make(chan struct{}, 1)
	p.statePending[id] = ch
	p.stateMu.Unlock()
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()
	defer func() {
		p.stateMu.Lock()
		delete(p.statePending, id)
		p.stateMu.Unlock()
	}()
	if !p.sendNonfatal(&pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_StateRequest{StateRequest: &pibridgepb.StateRequest{RequestId: id}},
	}) {
		return fmt.Errorf("pibridge: state request not admitted")
	}
	select {
	case <-ch:
		if err := ctx.Err(); err != nil {
			return err
		}
		l.mu.Lock()
		current := l.peer == p && p.generation == l.maxGen && l.state != leaseRevoked
		l.mu.Unlock()
		if !current {
			return fmt.Errorf("pibridge: state peer replaced")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-p.done:
		return fmt.Errorf("pibridge: state peer gone")
	}
}
