package pibridge

import (
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func TestAvailabilityCallbacksOrderSameGenerationReconnect(t *testing.T) {
	s := NewServer()
	old := newPeer(1, "sess", newBlockingStream())
	next := newPeer(1, "sess", newBlockingStream())
	l := &lease{paneID: "pane", processID: "proc", state: leaseLive, maxGen: 1, peer: old}
	events := make(chan string, 4)
	entered, release, detached := make(chan struct{}), make(chan struct{}), make(chan struct{})
	s.SetOnPeerDown(func(_, _ string, _ uint64) {
		close(entered)
		<-release
		events <- "down"
	})
	s.SetOnState(func(_, _ string, _, _ uint64, _, _ bool, _, _ string, _ []string) { events <- "up" })
	go func() { s.detachPeer(l, old); close(detached) }()
	<-entered
	l.mu.Lock()
	l.peer = next
	l.mu.Unlock()
	notified := make(chan struct{})
	go func() {
		s.fireState(l, next, 1, &pibridgepb.StateSnapshot{}, nil)
		close(notified)
	}()
	// A delayed down notification must finish before the reconnect's up.
	select {
	case got := <-events:
		close(release)
		<-detached
		<-notified
		t.Fatalf("reconnect overtook the disconnect callback: %s", got)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	<-detached
	<-notified
	if got := <-events; got != "down" {
		t.Fatalf("first event %q", got)
	}
	if got := <-events; got != "up" {
		t.Fatalf("last event %q", got)
	}
	// A late state notification for the replaced peer must stay silent.
	s.fireState(l, old, 2, &pibridgepb.StateSnapshot{}, nil)
	select {
	case got := <-events:
		t.Fatalf("replaced peer published %q", got)
	default:
	}
}
