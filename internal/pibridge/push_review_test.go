package pibridge

import (
	"errors"
	"strconv"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"google.golang.org/grpc/codes"
)

type pushRecordingStream struct {
	*blockingStream
	notifications chan *pibridgepb.SyncboardNotification
}

func (s *pushRecordingStream) Send(msg *pibridgepb.PhiToPi) error {
	if err := s.blockingStream.Send(msg); err != nil {
		return err
	}
	s.notifications <- msg.GetSyncboardNotification()
	return nil
}

// Stall the real writer before publishing, rather than relying on the speed
// of a loopback connection to overflow the peer's queue.
func TestPushWriterProgressDrainsBacklogWithoutReconnect(t *testing.T) {
	stream := &pushRecordingStream{newBlockingStream(), make(chan *pibridgepb.SyncboardNotification, maxPendingPushes)}
	p := newPeer(1, "session", stream)
	l := &lease{paneID: "pane", processID: "process", state: leaseLive, peer: p,
		maxGen: 1, caps: []string{CapabilitySyncboardPush}}
	p.onWritable = func() { l.flushPendingPushes(p) }
	s := &Server{reg: newRegistry()}
	s.reg.byPane["pane"] = l
	for i := 0; i < maxPendingPushes; i++ {
		value := []byte("body")
		if err := s.SendSyncboardPush("pane", SyncboardPush{Recipient: "pane", MessageID: strconv.Itoa(i), Value: value}); err != nil {
			t.Fatal(err)
		}
		value[0] = 'x' // Retention must own its bytes, including queued messages.
		if i == 0 {
			if err := s.SendSyncboardPush("pane", SyncboardPush{Recipient: "pane", MessageID: "0", Value: []byte("changed")}); err != nil {
				t.Fatal(err)
			}
			if p.outstanding != 1 {
				t.Fatal("duplicate admission queued another notification")
			}
		}
	}
	if p.outstanding >= maxPendingPushes {
		t.Fatal("test did not exercise a full peer queue")
	}
	close(stream.release)
	go p.runWriter()
	defer func() { p.closeWith(codes.Canceled, "test done"); <-p.writerDone }()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for i := 0; i < maxPendingPushes; i++ {
		select {
		case notification := <-stream.notifications:
			if notification.GetMessageId() != strconv.Itoa(i) || string(notification.GetValue()) != "body" {
				t.Fatalf("notification %d lost order, identity, or immutable value: %v", i, notification)
			}
		case <-timer.C:
			t.Fatalf("writer sent only %d of %d retained pushes without reconnect", i, maxPendingPushes)
		}
	}
}

// TestPushAckWaitsForStatePublication pins the ordering the ack path needs:
// a capability change is published under notifyMu, so an acknowledgement that
// lands mid-publication must wait rather than retire work the about-to-be
// published stream state has not accounted for.
func TestPushAckWaitsForStatePublication(t *testing.T) {
	p := newPeer(1, "session", nil)
	l := &lease{state: leaseLive, maxGen: 1, peer: p, caps: []string{CapabilitySyncboardPush},
		pendingPushes: map[string]*pendingPush{"message": {notification: &pibridgepb.SyncboardNotification{Seq: 7, MessageId: "message"}, sentTo: p}},
		pendingOrder:  []string{"message"}}
	s := &Server{}
	l.notifyMu.Lock() // A state change is being published.
	done := make(chan struct{})
	go func() {
		s.deliverSyncboardPushAck(l, p, &pibridgepb.SyncboardPushAck{Seq: 7, MessageId: "message"})
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	if l.pendingPushCount() != 1 {
		t.Fatal("acknowledgement retired work during state publication")
	}
	l.notifyMu.Unlock()
	<-done
	if l.pendingPushCount() != 0 {
		t.Fatal("acknowledgement did not retire work after publication")
	}
}

// TestPushBacklogAdmitsKnownIDAtCapacity is the retry-under-pressure
// invariant: a full backlog refuses new work, but a repeat of an already
// retained message is a retry, not new work, and must still be accepted.
func TestPushBacklogAdmitsKnownIDAtCapacity(t *testing.T) {
	p := newPeer(1, "session", nil)
	l := &lease{paneID: "pane", processID: "process", state: leaseLive, peer: p,
		maxGen: 1, caps: []string{CapabilitySyncboardPush}}
	s := &Server{reg: newRegistry()}
	s.reg.byPane["pane"] = l
	for i := 0; i < maxPendingPushes; i++ {
		if err := s.SendSyncboardPush("pane", SyncboardPush{Recipient: "pane", MessageID: strconv.Itoa(i), Value: []byte("body")}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SendSyncboardPush("pane", SyncboardPush{Recipient: "pane", MessageID: "new", Value: []byte("body")}); !errors.Is(err, ErrPushBacklogFull) {
		t.Fatalf("new work at capacity: %v, want ErrPushBacklogFull", err)
	}
	if err := s.SendSyncboardPush("pane", SyncboardPush{Recipient: "pane", MessageID: "0", Value: []byte("body")}); err != nil {
		t.Fatalf("retry of retained work refused at capacity: %v", err)
	}
	if got := l.pendingPushCount(); got != maxPendingPushes {
		t.Fatalf("pending = %d, want %d: a retry must not consume a slot", got, maxPendingPushes)
	}
}

func TestPushAckIsFencedToCurrentPeerAndSequence(t *testing.T) {
	current := newPeer(2, "session", nil)
	old := newPeer(1, "session", nil)
	l := &lease{state: leaseLive, maxGen: 2, peer: current, caps: []string{CapabilitySyncboardPush},
		pendingPushes: map[string]*pendingPush{"message": {notification: &pibridgepb.SyncboardNotification{Seq: 7, MessageId: "message"}, sentTo: current}},
		pendingOrder:  []string{"message"}}
	s := &Server{}
	s.deliverSyncboardPushAck(l, old, &pibridgepb.SyncboardPushAck{Seq: 7, MessageId: "message"})
	s.deliverSyncboardPushAck(l, current, &pibridgepb.SyncboardPushAck{Seq: 6, MessageId: "message"})
	if l.pendingPushCount() != 1 {
		t.Fatal("stale acknowledgement cleared current work")
	}
	s.deliverSyncboardPushAck(l, current, &pibridgepb.SyncboardPushAck{Seq: 7, MessageId: "message"})
	if l.pendingPushCount() != 0 {
		t.Fatal("current acknowledgement did not clear work")
	}
}
