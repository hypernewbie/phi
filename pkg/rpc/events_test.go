package rpc

import (
	"testing"
	"time"
)

func TestSubscriberBroadcastOrder(t *testing.T) {
	s := newSubscriberSet()
	sub := s.Subscribe()
	defer sub.CloseThis()
	for i := uint64(1); i <= 5; i++ {
		s.Broadcast(Event{Evt: "stateChanged", Seq: i})
	}
	for i := uint64(1); i <= 5; i++ {
		select {
		case e := <-sub.Channel():
			if e.Seq != i {
				t.Fatalf("want %d got %d", i, e.Seq)
			}
		case <-time.After(time.Second):
			t.Fatalf("timeout waiting for seq %d", i)
		}
	}
}

func TestSubscriberCloseThis(t *testing.T) {
	s := newSubscriberSet()
	sub := s.Subscribe()
	sub.CloseThis()
	s.Broadcast(Event{Evt: "x"}) // must not panic
	if _, ok := <-sub.Channel(); ok {
		t.Fatal("closed sub must yield nothing")
	}
}

func TestSubscriberSlowIsDropped(t *testing.T) {
	s := newSubscriberSet()
	sub := s.Subscribe()
	for i := 0; i < 256; i++ { // saturate
		s.Broadcast(Event{Evt: "fill", Seq: uint64(i)})
	}
	s.Broadcast(Event{Evt: "dropme", Seq: 9999})
	done := make(chan struct{})
	go func() {
		for range sub.Channel() {
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("slow subscriber was not dropped")
	}
}

func TestSubscriberSetCloseAll(t *testing.T) {
	s := newSubscriberSet()
	a := s.Subscribe()
	b := s.Subscribe()
	s.CloseAll()
	if _, ok := <-a.Channel(); ok {
		t.Fatal("a must be closed")
	}
	if _, ok := <-b.Channel(); ok {
		t.Fatal("b must be closed")
	}
}
