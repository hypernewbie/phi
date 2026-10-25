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
	defer l.mu.Unlock()
	p := l.peer
	if p == nil || l.state == leaseRevoked {
		return fmt.Errorf("pibridge: no live peer")
	}
	if !slices.Contains(l.caps, CapabilityReload) {
		return fmt.Errorf("pibridge: reload capability not negotiated")
	}
	msg := &pibridgepb.PhiToPi{
		PaneId:            l.paneID,
		ProcessId:         l.processID,
		RuntimeGeneration: p.generation,
		Payload:           &pibridgepb.PhiToPi_ReloadRequest{ReloadRequest: &pibridgepb.ReloadRequest{}},
	}
	if !p.sendNonfatal(msg) {
		return fmt.Errorf("pibridge: reload request not admitted")
	}
	return nil
}
