package ws

import (
	"context"
	"sync"
	"testing"
)

type stubAuthSocket struct {
	mu     sync.Mutex
	closed bool
}

func (s *stubAuthSocket) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

func TestAuthFenceCarriesGenerationThroughContext(t *testing.T) {
	ctx := WithAuthFence(context.Background(), AuthFence{Generation: 7})
	fence, ok := AuthFenceFrom(ctx)
	if !ok || fence.Generation != 7 {
		t.Fatalf("fence = %+v ok=%v", fence, ok)
	}
	if _, ok := AuthFenceFrom(context.Background()); ok {
		t.Fatal("unfenced context reported a fence")
	}
}

func TestAuthFencerAdmitsOnlyCurrentGeneration(t *testing.T) {
	var f authFencer
	f.rotate(3)
	if f.admit(&stubAuthSocket{}, AuthFence{Generation: 2}) {
		t.Fatal("stale generation admitted")
	}
	if !f.admit(&stubAuthSocket{}, AuthFence{Generation: 3}) {
		t.Fatal("current generation rejected")
	}
}

func TestAuthFencerForgetsClosedSockets(t *testing.T) {
	var f authFencer
	f.rotate(1)
	socket := &stubAuthSocket{}
	f.admit(socket, AuthFence{Generation: 1})
	f.forget(socket)
	if closed := f.rotate(2); closed != 0 {
		t.Fatalf("forgotten socket was closed: %d", closed)
	}
	if socket.closed {
		t.Fatal("forgotten socket was closed")
	}
}
