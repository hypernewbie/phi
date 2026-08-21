package rpc

import (
	"sync"
	"sync/atomic"
)

// Event is the outbound sequenced frame.
type Event struct {
	Type string `json:"t"`
	Evt  string `json:"evt,omitempty"`
	Sid  string `json:"sid"`
	Seq  uint64 `json:"seq"`
	Data any    `json:"data,omitempty"`
}

// SubscriberSet fans out Events; a slow subscriber is dropped (must rehydrate).
type SubscriberSet struct {
	mu     sync.Mutex
	closed bool
	subs   map[*Subscriber]struct{}
}

// Subscriber is one subscription channel.
type Subscriber struct {
	set     *SubscriberSet
	ch      chan Event
	drop    atomic.Bool
	onClose func()
}

func newSubscriberSet() *SubscriberSet {
	return &SubscriberSet{subs: map[*Subscriber]struct{}{}}
}

// Subscribe returns a new Subscriber (chan cap 256).
func (s *SubscriberSet) Subscribe() *Subscriber {
	return s.SubscribeWithCallback(nil)
}

// SubscribeWithCallback registers a subscriber and invokes callback exactly
// once when its channel closes, including overflow and CloseAll paths.
func (s *SubscriberSet) SubscribeWithCallback(callback func()) *Subscriber {
	sub := &Subscriber{set: s, ch: make(chan Event, 256), onClose: callback}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.closeSubscriber(sub)
		return sub
	}
	s.subs[sub] = struct{}{}
	s.mu.Unlock()
	return sub
}

func (s *SubscriberSet) closeSubscriber(sub *Subscriber) {
	if sub.drop.CompareAndSwap(false, true) {
		close(sub.ch)
		if sub.onClose != nil {
			sub.onClose()
		}
	}
}

// Close detaches one subscriber.
func (s *SubscriberSet) Close(sub *Subscriber) {
	if sub == nil {
		return
	}
	s.mu.Lock()
	delete(s.subs, sub)
	s.mu.Unlock()
	s.closeSubscriber(sub)
}

// CloseThis detaches this subscriber from its set.
func (sub *Subscriber) CloseThis() {
	if sub.set != nil {
		sub.set.Close(sub)
	}
}

// Broadcast delivers to every subscriber; overflow drops that subscriber.
func (s *SubscriberSet) Broadcast(e Event) {
	var dropped []*Subscriber
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	for sub := range s.subs {
		if sub.drop.Load() {
			continue
		}
		select {
		case sub.ch <- e:
		default:
			delete(s.subs, sub)
			dropped = append(dropped, sub)
		}
	}
	s.mu.Unlock()
	for _, sub := range dropped {
		s.closeSubscriber(sub)
	}
}

// CloseAll closes every subscriber.
func (s *SubscriberSet) CloseAll() {
	s.mu.Lock()
	s.closed = true
	subs := make([]*Subscriber, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.subs = map[*Subscriber]struct{}{}
	s.mu.Unlock()
	for _, sub := range subs {
		s.closeSubscriber(sub)
	}
}

func (sub *Subscriber) isClosed() bool {
	return sub == nil || sub.drop.Load()
}

// Channel returns the receive side.
func (sub *Subscriber) Channel() <-chan Event { return sub.ch }
