package pibridge

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"slices"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// ErrTopicUnavailable means no live, capable runtime owns the pane.
// ErrTopicBacklogFull means nothing new was retained.
var (
	ErrTopicUnavailable = errors.New("pibridge: topic unavailable")
	ErrTopicBacklogFull = errors.New("pibridge: topic backlog full")
)

const (
	CapabilitySyncboardTopics = "pi.syncboard.topics.v1"
	maxPendingTopics          = 32
	maxTopicIDBytes           = 128
)

// SyncboardOwner is the immutable process identity a topic subscription is
// bound to. A replacement runtime never inherits it.
type SyncboardOwner struct {
	PaneID     string
	ProcessID  string
	RuntimeID  string
	SessionID  string
	Generation uint64
}

func (o SyncboardOwner) equal(other SyncboardOwner) bool {
	return o == other
}

// SyncboardTopicPush is one immutable batch delivery.
type SyncboardTopicRetirement struct {
	Owner   SyncboardOwner
	Epoch   string
	Reason  string
	Through uint64
}

type SyncboardTopicPush struct {
	Owner     SyncboardOwner
	Seq       uint64
	Topic     string
	Epoch     string
	Value     []byte
	BatchID   string
	UpdatedAt int64
}

type pendingTopic struct {
	notification *pibridgepb.SyncboardNotification
	sentTo       *peer
}

// EnableSyncboardTopics allows the topic subscription capability to be
// negotiated. Call before serving.
func (s *Server) EnableSyncboardTopics(enabled bool) {
	s.syncboardTopics = enabled
}

// SetSyncboardTopicAckHandler installs the host callback for checked topic
// acknowledgements. It runs outside every bridge lock and must not call back
// into the Server.
func (s *Server) SetSyncboardTopicAckHandler(fn func(SyncboardOwner, string, uint64, string)) {
	s.onTopicAck = fn
}

// SetSyncboardTopicRetireHandler installs the native generation fence
// callback. It runs under the lease lock and must only enqueue work; it must
// not call back into the bridge.
func (s *Server) SetSyncboardTopicRetireHandler(fn func(SyncboardTopicRetirement)) {
	s.onTopicRetired = fn
}

// SetSyncboardTopicEpoch publishes this coordinator RAM instance identity.
// A later different epoch fences bindings created under the previous epoch.
func (s *Server) SetSyncboardTopicEpoch(epoch string) {
	s.topicEpochMu.Lock()
	previous := s.syncboardTopicEpoch
	s.syncboardTopicEpoch = epoch
	if previous != "" && previous != epoch {
		s.fenceSyncboardTopicEpoch(previous, "coordinator-replaced", false)
	}
	s.topicEpochMu.Unlock()
}

// fenceSyncboardTopicEpoch retires every binding created under a replaced
// coordinator epoch. The cumulative marker is retained for replay. A
// permanent fence also blocks the current native generation from rebinding.
func (s *Server) fenceSyncboardTopicEpoch(epoch, reason string, permanent bool) {
	s.reg.mu.Lock()
	leases := make([]*lease, 0, len(s.reg.byProcess))
	seen := make(map[*lease]struct{})
	for _, l := range s.reg.byProcess {
		if _, ok := seen[l]; ok {
			continue
		}
		seen[l] = struct{}{}
		leases = append(leases, l)
	}
	s.reg.mu.Unlock()
	for _, l := range leases {
		l.mu.Lock()
		if l.topicEpoch != epoch || l.topicBinding == 0 {
			l.mu.Unlock()
			continue
		}
		retirement := l.fenceTopicGeneration(reason, permanent)
		p := l.peer
		if retirement != nil && s.onTopicRetired != nil {
			s.onTopicRetired(*retirement)
		}
		l.mu.Unlock()
		if p != nil {
			l.flushPendingTopics(p)
		}
	}
}

// RetireSyncboardTopicBindings fences all bindings under the current epoch.
// The reason is retained in the retirement marker. Callers use it when peer
// authority or the native generation is revoked.
func (s *Server) RetireSyncboardTopicBindings(reason string) {
	s.topicEpochMu.Lock()
	epoch := s.syncboardTopicEpoch
	if epoch != "" {
		s.fenceSyncboardTopicEpoch(epoch, reason, true)
	}
	s.topicEpochMu.Unlock()
}

// SyncboardTopicEpoch returns the current coordinator RAM instance identity.
func (s *Server) SyncboardTopicEpoch() string {
	s.topicEpochMu.RLock()
	defer s.topicEpochMu.RUnlock()
	return s.syncboardTopicEpoch
}

// BindSyncboardTopic captures the live owner and returns the cumulative
// native binding sequence for owner+epoch. Repeating a subscribe in the same
// epoch reuses the sequence; a new epoch always advances it.
func (s *Server) BindSyncboardTopic(processID, epoch string) (SyncboardOwner, uint64, error) {
	if s == nil || processID == "" || epoch == "" || len(epoch) > maxTopicIDBytes {
		return SyncboardOwner{}, 0, ErrTopicUnavailable
	}
	s.topicEpochMu.RLock()
	defer s.topicEpochMu.RUnlock()
	if s.syncboardTopicEpoch != epoch {
		return SyncboardOwner{}, 0, ErrTopicUnavailable
	}
	s.reg.mu.Lock()
	l := s.reg.byProcess[processID]
	s.reg.mu.Unlock()
	if l == nil {
		return SyncboardOwner{}, 0, ErrTopicUnavailable
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state != leaseLive || l.peer == nil || l.maxGen == 0 ||
		!slices.Contains(l.caps, CapabilitySyncboardTopics) ||
		l.topicWithdrawnGen == l.maxGen {
		return SyncboardOwner{}, 0, ErrTopicUnavailable
	}
	owner := SyncboardOwner{
		PaneID: l.paneID, ProcessID: l.processID,
		RuntimeID: l.runtimeID, SessionID: l.sessionID,
		Generation: l.maxGen,
	}
	if l.topicEpoch != epoch {
		if l.topicNextBinding == math.MaxUint64 {
			return SyncboardOwner{}, 0, ErrTopicBacklogFull
		}
		l.topicNextBinding++
		l.topicBinding = l.topicNextBinding
		l.topicEpoch = epoch
	}
	if l.topicBinding == 0 || l.topicBinding <= l.topicRetiredThrough {
		return SyncboardOwner{}, 0, ErrTopicUnavailable
	}
	return owner, l.topicBinding, nil
}

// SendSyncboardTopic retains one immutable batch for the current runtime.
// Queue pressure never evicts an unacknowledged batch.
func (s *Server) SendSyncboardTopic(push SyncboardTopicPush) error {
	if s == nil {
		return ErrTopicUnavailable
	}
	if push.BatchID == "" || len(push.BatchID) > maxTopicIDBytes ||
		push.Topic == "" || len(push.Topic) > 256 ||
		push.Epoch == "" || len(push.Epoch) > maxTopicIDBytes {
		return errors.New("pibridge: invalid topic push")
	}
	if len(push.Value) > MaxSyncboardValueBytes {
		return errors.New("pibridge: topic value too large")
	}
	s.reg.mu.Lock()
	l := s.reg.byPane[push.Owner.PaneID]
	s.reg.mu.Unlock()
	if l == nil {
		return ErrTopicUnavailable
	}
	l.mu.Lock()
	if l.state != leaseLive || l.peer == nil ||
		!slices.Contains(l.caps, CapabilitySyncboardTopics) ||
		l.topicEpoch != push.Epoch || l.topicBinding == 0 ||
		l.topicBinding <= l.topicRetiredThrough ||
		l.processID != push.Owner.ProcessID || l.maxGen != push.Owner.Generation ||
		l.runtimeID != push.Owner.RuntimeID || l.sessionID != push.Owner.SessionID {
		l.mu.Unlock()
		return ErrTopicUnavailable
	}
	p := l.peer
	if l.pendingTopics == nil {
		l.pendingTopics = make(map[string]*pendingTopic, maxPendingTopics)
	}
	if _, exists := l.pendingTopics[push.BatchID]; !exists {
		if len(l.pendingTopicOrder) >= maxPendingTopics {
			l.mu.Unlock()
			return ErrTopicBacklogFull
		}
		l.pendingTopics[push.BatchID] = &pendingTopic{notification: &pibridgepb.SyncboardNotification{
			Seq: push.Seq, Sender: push.Owner.PaneID, Recipient: push.Owner.PaneID,
			Value: bytes.Clone(push.Value), UpdatedAtUnixMs: push.UpdatedAt,
			MessageId: push.BatchID, Topic: push.Topic, CoordinatorEpoch: push.Epoch,
		}}
		l.pendingTopicOrder = append(l.pendingTopicOrder, push.BatchID)
	}
	l.mu.Unlock()
	l.flushPendingTopics(p)
	return nil
}

// RetireSyncboardTopics retains one cumulative invalidation marker. It is
// replayed on every same-owner reconnect, even after a successful enqueue.
func (s *Server) RetireSyncboardTopics(owner SyncboardOwner, epoch, reason string, through uint64) error {
	if s == nil || through == 0 || epoch == "" || len(epoch) > maxTopicIDBytes {
		return ErrTopicUnavailable
	}
	s.reg.mu.Lock()
	l := s.reg.byPane[owner.PaneID]
	s.reg.mu.Unlock()
	if l == nil {
		return ErrTopicUnavailable
	}
	l.mu.Lock()
	if l.processID != owner.ProcessID {
		l.mu.Unlock()
		return ErrTopicUnavailable
	}
	if through > l.topicRetiredThrough {
		l.topicRetiredThrough = through
	}
	// A delayed marker may only cancel work covered by its binding. A newer
	// explicit subscribe keeps its pending batches. The binding itself stays
	// recorded so the same native generation cannot resubscribe in this epoch;
	// a fresh epoch or generation advances past the retained fence.
	if l.topicBinding == 0 || through >= l.topicBinding {
		l.pendingTopics = nil
		l.pendingTopicOrder = nil
	}
	l.topicRetired = &pibridgepb.SyncboardTopicRetired{
		RetiredEpoch: epoch, Reason: reason, ThroughBindingSeq: l.topicRetiredThrough,
	}
	l.topicRetiredSentTo = nil
	p := l.peer
	l.mu.Unlock()
	if p != nil {
		l.flushPendingTopics(p)
	}
	return nil
}

func (l *lease) flushPendingTopics(p *peer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if p == nil || l.peer != p || l.state != leaseLive ||
		!slices.Contains(l.caps, CapabilitySyncboardTopics) {
		return
	}
	if l.topicRetired != nil && l.topicRetiredSentTo != p {
		if !sendTopicRetired(p, l.paneID, l.processID, l.maxGen, l.topicRetired) {
			return
		}
		l.topicRetiredSentTo = p
	}
	for _, id := range l.pendingTopicOrder {
		entry := l.pendingTopics[id]
		if entry.sentTo == p {
			continue
		}
		if !sendTopicPush(p, l.paneID, l.processID, l.maxGen, entry.notification) {
			return
		}
		entry.sentTo = p
	}
}

func sendTopicPush(p *peer, pane, proc string, gen uint64, notification *pibridgepb.SyncboardNotification) bool {
	return p.sendSyncboardNonfatal(&pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_SyncboardNotification{SyncboardNotification: notification},
	})
}

func sendTopicRetired(p *peer, pane, proc string, gen uint64, retired *pibridgepb.SyncboardTopicRetired) bool {
	return p.sendSyncboardNonfatal(&pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_SyncboardTopicRetired{SyncboardTopicRetired: retired},
	})
}

func (s *Server) deliverSyncboardTopicAck(l *lease, p *peer, ack *pibridgepb.SyncboardPushAck) {
	l.notifyMu.Lock()
	defer l.notifyMu.Unlock()
	l.mu.Lock()
	if l.peer != p || l.state != leaseLive || p.generation != l.maxGen ||
		!slices.Contains(l.caps, CapabilitySyncboardTopics) {
		l.mu.Unlock()
		return
	}
	id := ack.GetMessageId()
	entry := l.pendingTopics[id]
	if entry == nil || entry.sentTo != p || entry.notification.GetSeq() != ack.GetSeq() ||
		entry.notification.GetCoordinatorEpoch() != ack.GetCoordinatorEpoch() {
		l.mu.Unlock()
		return
	}
	delete(l.pendingTopics, id)
	l.pendingTopicOrder = slices.DeleteFunc(l.pendingTopicOrder, func(pendingID string) bool { return pendingID == id })
	owner := SyncboardOwner{PaneID: l.paneID, ProcessID: l.processID, RuntimeID: l.runtimeID,
		SessionID: l.sessionID, Generation: l.maxGen}
	epoch, seq := ack.GetCoordinatorEpoch(), ack.GetSeq()
	l.mu.Unlock()
	if s.onTopicAck != nil {
		s.onTopicAck(owner, epoch, seq, id)
	}
}

func (l *lease) pendingTopicCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.pendingTopics)
}

// fenceTopicGeneration retains a cumulative marker and cancels the current
// binding. A permanent fence records the native generation so a same-generation
// reconnect cannot bind again; only a higher generation can.
func (l *lease) fenceTopicGeneration(reason string, permanent bool) *SyncboardTopicRetirement {
	if permanent {
		l.topicWithdrawnGen = l.maxGen
	}
	if l.topicBinding == 0 {
		return nil
	}
	if l.topicBinding > l.topicRetiredThrough {
		l.topicRetiredThrough = l.topicBinding
	}
	info := &SyncboardTopicRetirement{
		Owner: SyncboardOwner{
			PaneID: l.paneID, ProcessID: l.processID, RuntimeID: l.runtimeID,
			SessionID: l.sessionID, Generation: l.maxGen,
		},
		Epoch: l.topicEpoch, Reason: reason, Through: l.topicRetiredThrough,
	}
	l.topicRetired = &pibridgepb.SyncboardTopicRetired{
		RetiredEpoch: l.topicEpoch, Reason: reason,
		ThroughBindingSeq: l.topicRetiredThrough,
	}
	l.topicEpoch = ""
	l.topicBinding = 0
	l.topicRetiredSentTo = nil
	l.pendingTopics = nil
	l.pendingTopicOrder = nil
	return info
}

func (o SyncboardOwner) String() string {
	return fmt.Sprintf("%s/%s/%d", o.PaneID, o.ProcessID, o.Generation)
}
