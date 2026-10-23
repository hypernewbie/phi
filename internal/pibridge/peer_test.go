package pibridge

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// blockingStream blocks Sends until released, to exercise queue overflow
// without network timing.
type blockingStream struct {
	ctx     context.Context
	release chan struct{}
	sent    int
	mu      sync.Mutex
}

func newBlockingStream() *blockingStream {
	return &blockingStream{ctx: context.Background(), release: make(chan struct{})}
}

func (b *blockingStream) Send(*pibridgepb.PhiToPi) error {
	b.mu.Lock()
	b.sent++
	b.mu.Unlock()
	<-b.release
	return nil
}

func (b *blockingStream) Recv() (*pibridgepb.PiToPhi, error) {
	<-b.ctx.Done()
	return nil, b.ctx.Err()
}

func (b *blockingStream) Context() context.Context { return b.ctx }

func acceptedMsg(n int) *pibridgepb.PhiToPi {
	return &pibridgepb.PhiToPi{
		PaneId: "pane", ProcessId: "proc", RuntimeGeneration: 1,
		Payload: &pibridgepb.PhiToPi_Accepted{
			Accepted: &pibridgepb.Accepted{RuntimeId: strings.Repeat("r", n)},
		},
	}
}

func TestPeerQueueCountBound(t *testing.T) {
	bs := newBlockingStream()
	p := newPeer(1, "sess", bs)
	go p.runWriter()
	// Let the writer take the first message and block in Send.
	if !p.send(acceptedMsg(4)) {
		t.Fatal("first send rejected")
	}
	time.Sleep(50 * time.Millisecond)
	// Fill the remaining queue slots.
	accepted := 1
	for i := 0; i < maxQueuedMessages; i++ {
		if p.send(acceptedMsg(4)) {
			accepted++
		} else {
			break
		}
	}
	if accepted != maxQueuedMessages {
		t.Fatalf("accepted %d, want %d before overflow", accepted, maxQueuedMessages)
	}
	// Writer still blocked; the queue holds maxQueuedMessages-1 (one in
	// flight). One more must overflow promptly.
	overflowed := false
	for i := 0; i < 4 && !overflowed; i++ {
		if !p.send(acceptedMsg(4)) {
			overflowed = true
		}
	}
	if !overflowed {
		close(bs.release)
		t.Fatal("queue never overflowed")
	}
	if got := status.Code(p.closeErr()); got != codes.ResourceExhausted {
		close(bs.release)
		t.Fatalf("close code %v, want ResourceExhausted", got)
	}
	close(bs.release)
	<-p.writerDone
}

func TestPeerQueueByteBound(t *testing.T) {
	bs := newBlockingStream()
	p := newPeer(1, "sess", bs)
	go p.runWriter()
	if !p.send(acceptedMsg(4)) {
		t.Fatal("first send rejected")
	}
	time.Sleep(50 * time.Millisecond)
	// One message larger than the whole queue must overflow immediately.
	big := acceptedMsg(maxQueuedBytes)
	if p.send(big) {
		close(bs.release)
		t.Fatal("oversized queue payload accepted")
	}
	if got := status.Code(p.closeErr()); got != codes.ResourceExhausted {
		close(bs.release)
		t.Fatalf("close code %v, want ResourceExhausted", got)
	}
	close(bs.release)
	<-p.writerDone
}

func TestPeerSendNonfatalKeepsStream(t *testing.T) {
	bs := newBlockingStream()
	p := newPeer(1, "sess", bs)
	// One message larger than the whole queue overflows; the nonfatal
	// path reports false without closing the peer, and the queue
	// stays usable for lifecycle traffic.
	if p.sendNonfatal(acceptedMsg(maxQueuedBytes)) {
		t.Fatal("oversized nonfatal payload accepted")
	}
	if err := p.closeErr(); err != nil {
		t.Fatalf("nonfatal overflow closed peer: %v", err)
	}
	if !p.send(acceptedMsg(4)) {
		t.Fatal("send after nonfatal overflow rejected")
	}
	if p.sendNonfatal(acceptedMsg(4)) != true {
		t.Fatal("nonfatal send rejected on open peer")
	}
}

func TestPeerCloseIdempotent(t *testing.T) {
	bs := newBlockingStream()
	p := newPeer(1, "sess", bs)
	p.closeWith(codes.Canceled, "first")
	p.closeWith(codes.Internal, "second")
	if err := p.closeErr(); status.Code(err) != codes.Canceled || !strings.Contains(err.Error(), "first") {
		t.Fatalf("close not idempotent: %v", err)
	}
	if p.send(acceptedMsg(1)) {
		t.Fatal("send after close accepted")
	}
}
