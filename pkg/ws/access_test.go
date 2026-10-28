package ws

import (
	"sync"
	"testing"
	"time"
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

func TestAccessFencerAdmitsOnlyCurrentGeneration(t *testing.T) {
	var f authFencer
	f.rotate(3)
	if f.admit(&stubAuthSocket{}, AuthFence{Generation: 2}) {
		t.Fatal("stale generation admitted")
	}
	if !f.admit(&stubAuthSocket{}, AuthFence{Generation: 3}) {
		t.Fatal("current generation rejected")
	}
}

func TestAccessFencerForgetsClosedSockets(t *testing.T) {
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

// closeSignal is a stub socket that reports its first close so a test can wait
// for a timer instead of sleeping.
type closeSignal struct {
	closed chan struct{}
	once   sync.Once
}

func newCloseSignal() *closeSignal {
	return &closeSignal{closed: make(chan struct{})}
}

func (s *closeSignal) Close() error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func (s *closeSignal) waitClosed(t *testing.T) {
	t.Helper()
	select {
	case <-s.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("socket was not closed before the deadline")
	}
}

func (s *closeSignal) waitOpen(t *testing.T, window time.Duration) {
	t.Helper()
	select {
	case <-s.closed:
		t.Fatal("socket closed while it should have stayed open")
	case <-time.After(window):
	}
}

// A socket admitted with a deadline closes there, without a revocation.
func TestAccessFencerClosesAtAdmittedDeadline(t *testing.T) {
	var f authFencer
	f.rotate(1)
	socket := newCloseSignal()
	if !f.admit(socket, AuthFence{Generation: 1, Deadline: time.Now().Add(60 * time.Millisecond)}) {
		t.Fatal("admission refused")
	}
	socket.waitClosed(t)
}

// A timer armed for a closed connection must never close the connection that
// replaces it.
func TestAccessFencerStaleTimerLeavesReplacementOpen(t *testing.T) {
	var f authFencer
	f.rotate(1)
	socket := newCloseSignal()
	f.admit(socket, AuthFence{Generation: 1, Deadline: time.Now().Add(40 * time.Millisecond)})
	f.forget(socket)
	if !f.admit(socket, AuthFence{Generation: 1, Deadline: time.Now().Add(time.Hour)}) {
		t.Fatal("replacement admission refused")
	}
	socket.waitOpen(t, 200*time.Millisecond)
	if closed := f.rotate(2); closed != 1 {
		t.Fatalf("rotation closed %d sockets want 1", closed)
	}
	socket.waitClosed(t)
}

// An admission whose deadline already passed is refused rather than attached.
func TestAccessFencerRefusesExpiredAdmission(t *testing.T) {
	var f authFencer
	f.rotate(1)
	socket := newCloseSignal()
	if f.admit(socket, AuthFence{Generation: 1, Deadline: time.Now().Add(-time.Second)}) {
		t.Fatal("expired admission accepted")
	}
	socket.waitOpen(t, 50*time.Millisecond)
}

// A validator that refuses the fence rejects the socket: this is the window
// where a revocation lands between the middleware decision and registration.
func TestAccessFencerValidatorRefusesLateRevocation(t *testing.T) {
	var f authFencer
	f.rotate(1)
	f.setValidator(func(AuthFence) bool { return false })
	socket := newCloseSignal()
	if f.admit(socket, AuthFence{Generation: 1, FamilyID: "family-a"}) {
		t.Fatal("refused fence admitted")
	}
	socket.waitClosed(t)

	f.setValidator(func(AuthFence) bool { return true })
	accepted := newCloseSignal()
	if !f.admit(accepted, AuthFence{Generation: 1, FamilyID: "family-a"}) {
		t.Fatal("accepted fence refused")
	}
	accepted.waitOpen(t, 50*time.Millisecond)
}

// Family retirement closes only that family's sockets; logout-all closes every
// v2 socket and leaves v1 and disabled admissions connected.
func TestAccessFencerRetiresFamiliesWithoutTouchingV1(t *testing.T) {
	var f authFencer
	f.rotate(1)
	v1 := newCloseSignal()
	familyA := newCloseSignal()
	familyB := newCloseSignal()
	f.admit(v1, AuthFence{Generation: 1})
	f.admit(familyA, AuthFence{Generation: 1, FamilyID: "family-a"})
	f.admit(familyB, AuthFence{Generation: 1, FamilyID: "family-b"})

	if closed := f.retire(func(admission authAdmission) bool { return admission.familyID == "family-a" }); closed != 1 {
		t.Fatalf("family retirement closed %d sockets want 1", closed)
	}
	familyA.waitClosed(t)
	familyB.waitOpen(t, 50*time.Millisecond)
	v1.waitOpen(t, 10*time.Millisecond)

	if closed := f.retire(func(admission authAdmission) bool { return admission.familyID != "" }); closed != 1 {
		t.Fatalf("v2 retirement closed %d sockets want 1", closed)
	}
	familyB.waitClosed(t)
	v1.waitOpen(t, 50*time.Millisecond)
}
