package pibridge

import (
	"errors"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func TestCoordinatorEpochChangeFencesExistingBindings(t *testing.T) {
	l := &lease{topicEpoch: "e1", topicBinding: 3, topicRetiredThrough: 1,
		pendingTopics: map[string]*pendingTopic{
			"old": {notification: &pibridgepb.SyncboardNotification{CoordinatorEpoch: "e1"}},
		},
		pendingTopicOrder: []string{"old"},
	}
	s := &Server{reg: &registry{
		byProcess: map[string]*lease{"process": l},
		byPane:    map[string]*lease{"pane": l},
	}}
	s.SetSyncboardTopicEpoch("e1")
	if l.topicRetired != nil || l.topicBinding != 3 {
		t.Fatalf("same epoch changed binding: %+v", l)
	}
	s.SetSyncboardTopicEpoch("e2")
	if l.topicBinding != 0 || l.topicEpoch != "" {
		t.Fatalf("replaced epoch kept binding: epoch=%q binding=%d", l.topicEpoch, l.topicBinding)
	}
	if l.topicRetired == nil || l.topicRetired.GetRetiredEpoch() != "e1" ||
		l.topicRetired.GetThroughBindingSeq() != 3 ||
		l.topicRetired.GetReason() != "coordinator-replaced" {
		t.Fatalf("marker = %+v", l.topicRetired)
	}
	if l.topicRetiredThrough != 3 {
		t.Fatalf("retired through = %d", l.topicRetiredThrough)
	}
	if len(l.pendingTopics) != 0 || len(l.pendingTopicOrder) != 0 {
		t.Fatalf("old-epoch work survived the fence: %+v", l.pendingTopics)
	}
}

func TestGenerationFenceReturnsTheRetiredNativeOwner(t *testing.T) {
	l := &lease{
		paneID: "pane", processID: "process", maxGen: 4, runtimeID: "rt", sessionID: "s",
		topicEpoch: "e1", topicBinding: 7, topicRetiredThrough: 2,
		pendingTopics:     map[string]*pendingTopic{"old": {}},
		pendingTopicOrder: []string{"old"},
	}
	info := l.fenceTopicGeneration("generation-replaced", false)
	if info == nil {
		t.Fatal("fence returned no retirement")
	}
	if info.Owner.PaneID != "pane" || info.Owner.ProcessID != "process" || info.Owner.Generation != 4 ||
		info.Owner.RuntimeID != "rt" || info.Owner.SessionID != "s" ||
		info.Epoch != "e1" || info.Reason != "generation-replaced" || info.Through != 7 {
		t.Fatalf("retirement = %+v", info)
	}
	if l.topicBinding != 0 || l.topicEpoch != "" || len(l.pendingTopics) != 0 {
		t.Fatalf("fence retained work: %+v", l)
	}
	if again := l.fenceTopicGeneration("generation-replaced", false); again != nil {
		t.Fatalf("second fence = %+v, want nil", again)
	}
}

func TestSyncTopicRetainsUnderTransportQueuePressure(t *testing.T) {
	bs := newBlockingStream()
	p := newPeer(1, "sess", bs)
	l := &lease{
		paneID: "pane", processID: "proc", state: leaseLive, maxGen: 1,
		runtimeID: "rt", sessionID: "s", caps: []string{CapabilitySyncboardTopics},
		topicEpoch: "epoch-1", topicBinding: 1, peer: p,
	}
	s := &Server{reg: &registry{
		byProcess: map[string]*lease{"proc": l},
		byPane:    map[string]*lease{"pane": l},
	}}
	for i := 0; i < maxQueuedMessages-syncboardLifecycleHeadroomMessages; i++ {
		if !p.sendSyncboardNonfatal(syncboardEnvelope("pane", "proc", 1, &pibridgepb.SyncboardResponse{
			Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN,
			Reason:  SyncboardReasonTimeout,
		})) {
			t.Fatal("reserved Syncboard queue slot rejected")
		}
	}
	owner := SyncboardOwner{PaneID: "pane", ProcessID: "proc", RuntimeID: "rt", SessionID: "s", Generation: 1}
	if err := s.SendSyncboardTopic(SyncboardTopicPush{
		Owner: owner, Seq: 1, Topic: "alerts", Epoch: "epoch-1",
		Value: []byte("complete"), BatchID: "batch-1",
	}); err != nil {
		t.Fatalf("queue pressure dropped the retained topic: %v", err)
	}
	if got := l.pendingTopicCount(); got != 1 {
		t.Fatalf("retained topics = %d, want 1", got)
	}
	l.mu.Lock()
	sent := l.pendingTopics["batch-1"].sentTo
	l.mu.Unlock()
	if sent != nil {
		t.Fatal("topic was marked sent while the transport queue was full")
	}
	// Drain the queue, then the retained head must flush without a new post.
	go p.runWriter()
	close(bs.release)
	deadline := time.Now().Add(2 * time.Second)
	for {
		p.mu.Lock()
		outstanding := p.outstanding
		p.mu.Unlock()
		if outstanding == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("transport queue did not drain")
		}
		time.Sleep(time.Millisecond)
	}
	l.flushPendingTopics(p)
	l.mu.Lock()
	sent = l.pendingTopics["batch-1"].sentTo
	l.mu.Unlock()
	if sent != p {
		t.Fatal("retained topic did not flush after transport pressure cleared")
	}
}

func TestSyncTopicRetireBindingsFiresForPeerRevocationAndFencesGeneration(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	s.EnableSyncboardTopics(true)
	s.SetSyncboardTopicEpoch("epoch-1")
	var retirements []SyncboardTopicRetirement
	s.SetSyncboardTopicRetireHandler(func(r SyncboardTopicRetirement) { retirements = append(retirements, r) })
	stream, proc, token, cancel := openLeaseStream(t, s, sock, "pane-revoke", CapabilityLifecycle, CapabilitySyncboardTopics)
	defer cancel()
	owner, binding, err := s.BindSyncboardTopic(proc, "epoch-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SendSyncboardTopic(SyncboardTopicPush{
		Owner: owner, Seq: 1, Topic: "alerts", Epoch: "epoch-1",
		Value: []byte("pending"), BatchID: "batch-pending",
	}); err != nil {
		t.Fatal(err)
	}
	if n := recvNotification(t, stream); n.GetTopic() != "alerts" {
		t.Fatalf("pending notification = %v", n)
	}
	s.RetireSyncboardTopicBindings("peer-revoked")
	if len(retirements) != 1 || retirements[0].Reason != "peer-revoked" ||
		retirements[0].Through != binding || retirements[0].Epoch != "epoch-1" {
		t.Fatalf("revocation retirements = %+v", retirements)
	}
	if got := leaseFor(t, s, "pane-revoke").pendingTopicCount(); got != 0 {
		t.Fatalf("revocation retained %d batches", got)
	}
	if _, _, err := s.BindSyncboardTopic(proc, "epoch-1"); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatalf("revoked generation rebound: %v", err)
	}
	// A higher native generation may explicitly subscribe again.
	fresh, freshCancel := openStream(t, sock, "pane-revoke", proc, token)
	defer freshCancel()
	if err := fresh.Send(testHello("pane-revoke", proc, 2, CapabilityLifecycle, CapabilitySyncboardTopics)); err != nil {
		t.Fatal(err)
	}
	recvAccepted(t, fresh)
	// A repeated bound-level retirement flag cannot fence the unbound fresh
	// generation; only its own explicit subscribe may bind.
	s.RetireSyncboardTopicBindings("peer-retired")
	if _, next, err := s.BindSyncboardTopic(proc, "epoch-1"); err != nil || next <= binding {
		t.Fatalf("fresh generation bind = %d, %v; want above %d", next, err, binding)
	}
}

func TestSyncTopicCapabilityWithdrawalIsPermanentForGeneration(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	s.EnableSyncboardTopics(true)
	s.SetSyncboardTopicEpoch("epoch-1")
	var retirements []SyncboardTopicRetirement
	s.SetSyncboardTopicRetireHandler(func(r SyncboardTopicRetirement) { retirements = append(retirements, r) })
	stream, proc, token, cancel := openLeaseStream(t, s, sock, "pane-withdraw", CapabilityLifecycle, CapabilitySyncboardTopics)
	defer cancel()
	owner, binding, err := s.BindSyncboardTopic(proc, "epoch-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SendSyncboardTopic(SyncboardTopicPush{
		Owner: owner, Seq: 1, Topic: "alerts", Epoch: "epoch-1",
		Value: []byte("pending"), BatchID: "batch-pending",
	}); err != nil {
		t.Fatal(err)
	}
	if n := recvNotification(t, stream); n.GetTopic() != "alerts" {
		t.Fatalf("pending notification = %v", n)
	}
	// Withdraw the topic capability on a same-generation reconnect.
	withdrawn, withdrawCancel := openStream(t, sock, "pane-withdraw", proc, token)
	defer withdrawCancel()
	if err := withdrawn.Send(testHello("pane-withdraw", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatal(err)
	}
	recvAccepted(t, withdrawn)
	if len(retirements) != 1 || retirements[0].Reason != "capability-withdrawn" ||
		retirements[0].Through != binding || retirements[0].Owner.Generation != 1 {
		t.Fatalf("withdrawal retirements = %+v", retirements)
	}
	if got := leaseFor(t, s, "pane-withdraw").pendingTopicCount(); got != 0 {
		t.Fatalf("withdrawal retained %d batches", got)
	}
	if _, _, err := s.BindSyncboardTopic(proc, "epoch-1"); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatalf("withdrawn generation rebound: %v", err)
	}
	if err := s.SendSyncboardTopic(SyncboardTopicPush{
		Owner: owner, Seq: 2, Topic: "alerts", Epoch: "epoch-1",
		Value: []byte("late"), BatchID: "batch-late",
	}); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatalf("late push err = %v", err)
	}
	// Restoring the capability in the same generation cannot revive it.
	restored, restoreCancel := openStream(t, sock, "pane-withdraw", proc, token)
	defer restoreCancel()
	if err := restored.Send(testHello("pane-withdraw", proc, 1, CapabilityLifecycle, CapabilitySyncboardTopics)); err != nil {
		t.Fatal(err)
	}
	recvAccepted(t, restored)
	if _, _, err := s.BindSyncboardTopic(proc, "epoch-1"); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatalf("restored same generation rebound: %v", err)
	}
	// A new coordinator epoch permits an explicit subscribe by the unchanged
	// owner, but it must not clear the permanent-withdrawal generation fence.
	s.SetSyncboardTopicEpoch("epoch-2")
	if _, _, err := s.BindSyncboardTopic(proc, "epoch-2"); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatalf("withdrawn generation rebound after epoch change: %v", err)
	}
	// A higher native generation is required and gets a fresh binding above
	// the cumulative retirement watermark.
	fresh, freshCancel := openStream(t, sock, "pane-withdraw", proc, token)
	defer freshCancel()
	if err := fresh.Send(testHello("pane-withdraw", proc, 2, CapabilityLifecycle, CapabilitySyncboardTopics)); err != nil {
		t.Fatal(err)
	}
	recvAccepted(t, fresh)
	if marker := recvTopicRetired(t, fresh); marker.GetThroughBindingSeq() != binding || marker.GetReason() != "capability-withdrawn" {
		t.Fatalf("fresh generation marker = %+v", marker)
	}
	owner, next, err := s.BindSyncboardTopic(proc, "epoch-2")
	if err != nil || next <= binding || owner.Generation != 2 {
		t.Fatalf("fresh generation bind = %+v, %d, %v", owner, next, err)
	}
}

func TestSyncTopicDeliveryWaitsForHostACKAndDeduplicates(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	s.EnableSyncboardTopics(true)
	s.SetSyncboardTopicEpoch("epoch-1")
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-topic", CapabilityLifecycle, CapabilitySyncboardTopics)
	defer cancel()
	owner, seq, err := s.BindSyncboardTopic(proc, "epoch-1")
	if err != nil || seq == 0 {
		t.Fatalf("bind = %+v, %d, %v", owner, seq, err)
	}
	push := SyncboardTopicPush{
		Owner: owner, Seq: 9, Topic: "alerts", Epoch: "epoch-1",
		Value: []byte(`{"marker":"topic"}`), BatchID: "batch-1",
	}
	if err := s.SendSyncboardTopic(push); err != nil {
		t.Fatal(err)
	}
	n := recvNotification(t, stream)
	if n.GetTopic() != "alerts" || n.GetCoordinatorEpoch() != "epoch-1" ||
		n.GetMessageId() != "batch-1" || string(n.GetValue()) != `{"marker":"topic"}` {
		t.Fatalf("topic notification = %v", n)
	}
	if got := leaseFor(t, s, "pane-topic").pendingTopicCount(); got != 1 {
		t.Fatalf("pending topics = %d, want 1 before ACK", got)
	}
	// A duplicate batch ID must not add a second retained copy.
	if err := s.SendSyncboardTopic(push); err != nil {
		t.Fatal(err)
	}
	if got := leaseFor(t, s, "pane-topic").pendingTopicCount(); got != 1 {
		t.Fatalf("duplicate batch retained %d entries", got)
	}
	// Wrong epoch/sequence ACKs cannot release the head.
	for _, ack := range []*pibridgepb.SyncboardPushAck{
		{Seq: 9, MessageId: "batch-1", CoordinatorEpoch: "wrong-epoch"},
		{Seq: 10, MessageId: "batch-1", CoordinatorEpoch: "epoch-1"},
		{Seq: 9, MessageId: "wrong-batch", CoordinatorEpoch: "epoch-1"},
	} {
		if err := stream.Send(&pibridgepb.PiToPhi{
			PaneId: "pane-topic", ProcessId: proc, RuntimeGeneration: 1,
			Payload: &pibridgepb.PiToPhi_SyncboardPushAck{SyncboardPushAck: ack},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if got := leaseFor(t, s, "pane-topic").pendingTopicCount(); got != 1 {
		t.Fatalf("wrong ACK released the head: %d", got)
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-topic", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_SyncboardPushAck{SyncboardPushAck: &pibridgepb.SyncboardPushAck{
			Seq: 9, MessageId: "batch-1", CoordinatorEpoch: "epoch-1",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if leaseFor(t, s, "pane-topic").pendingTopicCount() == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("matching host ACK did not release the topic batch")
}

func recvTopicRetired(t *testing.T, stream pibridgepb.Integration_ConnectClient) *pibridgepb.SyncboardTopicRetired {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		type res struct {
			msg *pibridgepb.PhiToPi
			err error
		}
		ch := make(chan res, 1)
		go func() {
			m, e := stream.Recv()
			ch <- res{msg: m, err: e}
		}()
		select {
		case r := <-ch:
			if r.err != nil {
				t.Fatalf("recv: %v", r.err)
			}
			if n := r.msg.GetSyncboardTopicRetired(); n != nil {
				return n
			}
		case <-time.After(time.Until(deadline)):
			t.Fatal("timed out waiting for a topic retirement marker")
		}
	}
	t.Fatal("timed out waiting for a topic retirement marker")
	return nil
}

func TestSyncTopicRetirementMarkerReplaysOnSameOwnerReconnect(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	s.EnableSyncboardTopics(true)
	s.SetSyncboardTopicEpoch("epoch-1")
	stream, proc, token, cancel := openLeaseStream(t, s, sock, "pane-retire", CapabilityLifecycle, CapabilitySyncboardTopics)
	defer cancel()
	owner, seq, err := s.BindSyncboardTopic(proc, "epoch-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SendSyncboardTopic(SyncboardTopicPush{
		Owner: owner, Seq: 1, Topic: "topic", Epoch: "epoch-1",
		Value: []byte("pending"), BatchID: "batch-pending",
	}); err != nil {
		t.Fatal(err)
	}
	if n := recvNotification(t, stream); n.GetTopic() != "topic" {
		t.Fatalf("pending notification = %v", n)
	}
	if got := leaseFor(t, s, "pane-retire").pendingTopicCount(); got != 1 {
		t.Fatalf("pending topics = %d", got)
	}
	if err := s.RetireSyncboardTopics(owner, "epoch-1", "retired", seq); err != nil {
		t.Fatal(err)
	}
	if got := leaseFor(t, s, "pane-retire").pendingTopicCount(); got != 0 {
		t.Fatalf("retirement left %d pending batches", got)
	}
	if err := s.SendSyncboardTopic(SyncboardTopicPush{
		Owner: owner, Seq: 2, Topic: "topic", Epoch: "epoch-1",
		Value: []byte("late"), BatchID: "batch-late",
	}); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatalf("late old-epoch push err = %v", err)
	}
	if _, _, err := s.BindSyncboardTopic(proc, "epoch-1"); !errors.Is(err, ErrTopicUnavailable) {
		t.Fatalf("retired binding rebound in the same epoch: %v", err)
	}
	first := recvTopicRetired(t, stream)
	if first.GetRetiredEpoch() != "epoch-1" || first.GetThroughBindingSeq() != seq || first.GetReason() != "retired" {
		t.Fatalf("first marker = %+v", first)
	}
	reconnect, reconnectCancel := openStream(t, sock, "pane-retire", proc, token)
	defer reconnectCancel()
	if err := reconnect.Send(testHello("pane-retire", proc, 1, CapabilityLifecycle, CapabilitySyncboardTopics)); err != nil {
		t.Fatal(err)
	}
	recvAccepted(t, reconnect)
	second := recvTopicRetired(t, reconnect)
	if second.GetRetiredEpoch() != "epoch-1" || second.GetThroughBindingSeq() != seq {
		t.Fatalf("reconnect marker = %+v", second)
	}
	s.SetSyncboardTopicEpoch("epoch-2")
	replacement, next, err := s.BindSyncboardTopic(proc, "epoch-2")
	if err != nil || next <= second.GetThroughBindingSeq() {
		t.Fatalf("fresh epoch bind = %d, %v; retired through %d", next, err, second.GetThroughBindingSeq())
	}
	if replacement.Generation != owner.Generation {
		t.Fatalf("unchanged owner generation = %d, want %d", replacement.Generation, owner.Generation)
	}
	if err := s.SendSyncboardTopic(SyncboardTopicPush{
		Owner: replacement, Seq: 1, Topic: "topic", Epoch: "epoch-2",
		Value: []byte("fresh"), BatchID: "batch-fresh",
	}); err != nil {
		t.Fatalf("fresh epoch push: %v", err)
	}
	// A delayed retirement for the old binding must not cancel the newer one.
	if err := s.RetireSyncboardTopics(owner, "epoch-1", "retired", seq); err != nil {
		t.Fatal(err)
	}
	if got := leaseFor(t, s, "pane-retire").pendingTopicCount(); got != 1 {
		t.Fatalf("delayed marker cleared fresh work: %d", got)
	}
	if _, again, err := s.BindSyncboardTopic(proc, "epoch-2"); err != nil || again != next {
		t.Fatalf("fresh binding changed after delayed marker: %d, %v", again, err)
	}
	if err := s.SendSyncboardTopic(SyncboardTopicPush{
		Owner: replacement, Seq: 2, Topic: "topic", Epoch: "epoch-2",
		Value: []byte("still-fresh"), BatchID: "batch-fresh-2",
	}); err != nil {
		t.Fatalf("fresh binding rejected after delayed marker: %v", err)
	}
}
