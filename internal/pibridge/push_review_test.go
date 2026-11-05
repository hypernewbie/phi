package pibridge

import (
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
