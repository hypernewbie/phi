package pibridge

import (
	"fmt"
	"slices"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// RequestReload admits one native Pi reload control to the current peer.
// Admission is one-way: reload replaces the runtime, so there is no reply.
func (s *Server) RequestReload(processID string) error {
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return fmt.Errorf("pibridge: unknown process")
	}
	l.mu.Lock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		l.mu.Unlock()
		return fmt.Errorf("pibridge: no live peer")
	}
	if !slices.Contains(l.caps, CapabilityReload) {
		l.mu.Unlock()
		return fmt.Errorf("pibridge: reload capability not negotiated")
	}
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()

	msg := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload:           &pibridgepb.PhiToPi_ReloadRequest{ReloadRequest: &pibridgepb.ReloadRequest{}},
	}
	if !p.sendNonfatal(msg) {
		return fmt.Errorf("pibridge: reload request not admitted")
	}
	return nil
}
