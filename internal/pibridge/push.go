package pibridge

import (
	"errors"
	"log/slog"
	"slices"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// ErrPushUnavailable means the target pane cannot accept a push right now:
// no lease, no live stream, or the runtime never negotiated the capability.
// The caller keeps the message pending and retries; nothing was sent.
var ErrPushUnavailable = errors.New("pibridge: push unavailable")

// SyncboardPush is one addressed message ready for injection. It mirrors the
// notification wire message without exposing protobuf to callers that do not
// already depend on it.
type SyncboardPush struct {
	Seq             uint64
	Sender          string
	Recipient       string
	Value           []byte
	UpdatedAtUnixMs int64
	MessageID       string
}

// pendingPush is one unacknowledged notification retained for resend after a
// reconnect. Phi keeps it until the runtime acknowledges the message id.
type pendingPush struct {
	notification *pibridgepb.SyncboardNotification
}

// SendSyncboardPush delivers one addressed message to the pane's current
// runtime. It reports ErrPushUnavailable when the message cannot be handed
// over; the caller then retains it for a later attempt.
func (s *Server) SendSyncboardPush(paneID string, push SyncboardPush) error {
	if s == nil {
		return ErrPushUnavailable
	}
	if push.MessageID == "" || len(push.MessageID) > maxPushMessageIDBytes {
		return errors.New("pibridge: invalid push message id")
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

	notification := &pibridgepb.SyncboardNotification{
		Seq:             push.Seq,
		Sender:          push.Sender,
		Recipient:       push.Recipient,
		Value:           push.Value,
		UpdatedAtUnixMs: push.UpdatedAtUnixMs,
		MessageId:       push.MessageID,
	}

	l.mu.Lock()
	if l.state != leaseLive || l.peer == nil ||
		!slices.Contains(l.caps, CapabilitySyncboardPush) {
		l.mu.Unlock()
		return ErrPushUnavailable
	}
	p := l.peer
	pane, proc, gen := l.paneID, l.processID, l.maxGen
	if l.pendingPushes == nil {
		l.pendingPushes = make(map[string]*pendingPush, maxPendingPushes)
	}
	if _, exists := l.pendingPushes[push.MessageID]; exists {
		// Already retained from an earlier attempt: refresh its payload and
		// keep its original position in the queue.
		l.pendingPushes[push.MessageID] = &pendingPush{notification: notification}
	} else {
		for len(l.pendingOrder) >= maxPendingPushes {
			oldest := l.pendingOrder[0]
			l.pendingOrder = l.pendingOrder[1:]
			delete(l.pendingPushes, oldest)
			slog.Warn("syncboard push backlog full; dropping oldest unacknowledged entry",
				"pane", paneID, "dropped_message_id", oldest)
		}
		l.pendingPushes[push.MessageID] = &pendingPush{notification: notification}
		l.pendingOrder = append(l.pendingOrder, push.MessageID)
	}
	l.mu.Unlock()

	// Retention is the delivery mechanism: the entry is already pending, so a
	// jammed outbound queue delays the message instead of failing it. The
	// resend on reconnect picks it up.
	if !sendPush(p, pane, proc, gen, notification) {
		slog.Debug("syncboard push retained for resend", "pane", paneID, "message_id", push.MessageID)
	}
	return nil
}

// AckSyncboardPush removes one acknowledged entry. An unknown id is a
// duplicate ack and is ignored.
func (l *lease) ackSyncboardPush(messageID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.pendingPushes[messageID]; !ok {
		return false
	}
	delete(l.pendingPushes, messageID)
	for i, id := range l.pendingOrder {
		if id == messageID {
			l.pendingOrder = append(l.pendingOrder[:i], l.pendingOrder[i+1:]...)
			break
		}
	}
	return true
}

// resendPendingPushes replays unacknowledged notifications on a fresh stream.
// Called after a reconnect negotiates the capability, so a message sent while
// the runtime was away is not lost.
func (l *lease) resendPendingPushes() {
	l.mu.Lock()
	p := l.peer
	pane, proc, gen := l.paneID, l.processID, l.maxGen
	if p == nil || l.state != leaseLive ||
		!slices.Contains(l.caps, CapabilitySyncboardPush) {
		l.mu.Unlock()
		return
	}
	pending := make([]*pibridgepb.SyncboardNotification, 0, len(l.pendingOrder))
	for _, id := range l.pendingOrder {
		if entry, ok := l.pendingPushes[id]; ok {
			pending = append(pending, entry.notification)
		}
	}
	l.mu.Unlock()

	for _, notification := range pending {
		if !sendPush(p, pane, proc, gen, notification) {
			return
		}
	}
}

// sendPush enqueues one notification without endangering the lifecycle stream.
func sendPush(p *peer, pane, proc string, gen uint64, notification *pibridgepb.SyncboardNotification) bool {
	return p.sendSyncboardNonfatal(&pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_SyncboardNotification{
			SyncboardNotification: notification,
		},
	})
}

// deliverSyncboardPushAck records one acknowledgement from the runtime.
func (s *Server) deliverSyncboardPushAck(l *lease, p *peer, ack *pibridgepb.SyncboardPushAck) {
	if ack.GetMessageId() == "" || len(ack.GetMessageId()) > maxPushMessageIDBytes {
		return
	}
	l.ackSyncboardPush(ack.GetMessageId())
}

// pendingPushCount reports retained entries; used by tests and stats.
func (l *lease) pendingPushCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.pendingPushes)
}
