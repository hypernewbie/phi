package pibridge

import (
	"bytes"
	"errors"
	"slices"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// ErrPushUnavailable means no live, capable runtime can accept the push.
// ErrPushBacklogFull means nothing new was retained. Both permit a later
// attempt by the caller; an accepted push stays pending until acknowledged.
var (
	ErrPushUnavailable = errors.New("pibridge: push unavailable")
	ErrPushBacklogFull = errors.New("pibridge: push backlog full")
)

type SyncboardPush struct {
	Seq             uint64
	Sender          string
	Recipient       string
	Value           []byte
	UpdatedAtUnixMs int64
	MessageID       string
}

// sentTo distinguishes never queued from sent but not yet acknowledged.
// Only a new stream replays the latter; the runtime deduplicates that replay.
type pendingPush struct {
	notification *pibridgepb.SyncboardNotification
	sentTo       *peer
}

// SendSyncboardPush retains one notification for the current pane runtime.
// Queue pressure never evicts unacknowledged work or closes the peer.
func (s *Server) SendSyncboardPush(paneID string, push SyncboardPush) error {
	if s == nil {
		return ErrPushUnavailable
	}
	if push.MessageID == "" || len(push.MessageID) > maxPushMessageIDBytes {
		return errors.New("pibridge: invalid push message id")
	}
	if push.Recipient != paneID {
		return errors.New("pibridge: push recipient mismatch")
	}
	if len(push.Value) > MaxSyncboardValueBytes {
		return errors.New("pibridge: push value too large")
	}

	s.reg.mu.Lock()
	l := s.reg.byPane[paneID]
	s.reg.mu.Unlock()
	if l == nil {
		return ErrPushUnavailable
	}

	l.mu.Lock()
	if l.state != leaseLive || l.peer == nil ||
		!slices.Contains(l.caps, CapabilitySyncboardPush) {
		l.mu.Unlock()
		return ErrPushUnavailable
	}
	p := l.peer
	if l.pendingPushes == nil {
		l.pendingPushes = make(map[string]*pendingPush, maxPendingPushes)
	}
	if _, exists := l.pendingPushes[push.MessageID]; !exists {
		if len(l.pendingOrder) >= maxPendingPushes {
			l.mu.Unlock()
			return ErrPushBacklogFull
		}
		l.pendingPushes[push.MessageID] = &pendingPush{notification: &pibridgepb.SyncboardNotification{
			Seq: push.Seq, Sender: push.Sender, Recipient: push.Recipient,
			Value: bytes.Clone(push.Value), UpdatedAtUnixMs: push.UpdatedAtUnixMs,
			MessageId: push.MessageID,
		}}
		l.pendingOrder = append(l.pendingOrder, push.MessageID)
	}
	l.mu.Unlock()
	l.flushPendingPushes(p)
	return nil
}

// flushPendingPushes runs on admission, reconnect, and writer progress. Never
// resend on the same stream: queue admission is not an acknowledgement.
func (l *lease) flushPendingPushes(p *peer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if p == nil || l.peer != p || l.state != leaseLive ||
		!slices.Contains(l.caps, CapabilitySyncboardPush) {
		return
	}
	for _, id := range l.pendingOrder {
		entry := l.pendingPushes[id]
		if entry.sentTo == p {
			continue
		}
		if !sendPush(p, l.paneID, l.processID, l.maxGen, entry.notification) {
			return
		}
		entry.sentTo = p
	}
}

func sendPush(p *peer, pane, proc string, gen uint64, notification *pibridgepb.SyncboardNotification) bool {
	return p.sendSyncboardNonfatal(&pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_SyncboardNotification{SyncboardNotification: notification},
	})
}

// A replaced peer must not retire work belonging to the new stream.
// notifyMu serializes retirement with state and peer-down callbacks: an
// acknowledgement that arrives while a capability change is being published
// must not clear retention for work the new stream never accepted.
func (s *Server) deliverSyncboardPushAck(l *lease, p *peer, ack *pibridgepb.SyncboardPushAck) {
	l.notifyMu.Lock()
	defer l.notifyMu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.peer != p || l.state != leaseLive || p.generation != l.maxGen ||
		!slices.Contains(l.caps, CapabilitySyncboardPush) {
		return
	}
	id := ack.GetMessageId()
	entry := l.pendingPushes[id]
	if entry == nil || entry.sentTo != p || entry.notification.GetSeq() != ack.GetSeq() {
		return
	}
	delete(l.pendingPushes, id)
	l.pendingOrder = slices.DeleteFunc(l.pendingOrder, func(pendingID string) bool { return pendingID == id })
}

func (l *lease) pendingPushCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.pendingPushes)
}
