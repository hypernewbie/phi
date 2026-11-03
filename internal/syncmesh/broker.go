package syncmesh

import (
	"context"
	"sync"
	"time"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

const (
	// subscriberQueue bounds one subscriber's live backlog. A receiver that
	// stops draining is treated as lost rather than allowed to grow memory.
	subscriberQueue = 64
	// replayHistory bounds what a new or reconnecting subscriber can recover.
	// Must be at least subscriberQueue so the snapshot below can never
	// overflow the channel it fills.
	replayHistory = 256
)

// Broker fans one publisher's events out to local subscribers and assigns the
// monotonic per-publisher sequence. It never blocks on a subscriber: a full
// queue is replaced by a gap event, because silent loss is worse than a
// receiver that knows to resynchronize.
type Broker struct {
	mu     sync.Mutex
	seq    uint64
	nextID uint64
	subs   map[uint64]*brokerSub
	// history retains recent events so Subscribe can hand a new subscriber
	// everything it missed. Without it, an event published between the
	// client's call and the server's handler entry is lost with no way to
	// recover, and a reconnect silently skips traffic.
	history []*syncmeshb.SyncEvent
}

type brokerSub struct {
	ch        chan *syncmeshb.SyncEvent
	recipient string
}

// NewBroker returns an empty broker.
func NewBroker() *Broker {
	return &Broker{subs: make(map[uint64]*brokerSub)}
}

// WildcardRecipient accepts every event regardless of its recipient.
const WildcardRecipient = "*"

// Subscribe registers a subscriber and backfills everything it missed.
//
// The snapshot and the registration happen under one lock, so an event is
// either in the replay or arrives live — never in the gap between them.
// sinceSeq 0 replays the whole retained history.
func (b *Broker) Subscribe(_ context.Context, sinceSeq uint64, recipient string) (<-chan *syncmeshb.SyncEvent, func()) {
	b.mu.Lock()
	ch := make(chan *syncmeshb.SyncEvent, subscriberQueue)

	pending := make([]*syncmeshb.SyncEvent, 0, len(b.history))
	for _, ev := range b.history {
		if ev.Seq > sinceSeq && matches(ev, recipient) {
			pending = append(pending, ev)
		}
	}
	// The channel cannot hold more than its capacity; keep the newest and
	// tell the receiver it lost the rest rather than dropping them silently.
	if len(pending) > cap(ch)-1 {
		pending = pending[len(pending)-(cap(ch)-1):]
		ch <- &syncmeshb.SyncEvent{Seq: pending[0].Seq, Recipient: recipient, Gap: true}
	}
	for _, ev := range pending {
		ch <- ev
	}

	id := b.nextID
	b.nextID++
	b.subs[id] = &brokerSub{ch: ch, recipient: recipient}
	b.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			// Close under the same lock Publish holds while fanning out. Sends
			// never block, so holding it here cannot stall a publisher and no
			// send can race ahead of the close.
			b.mu.Lock()
			delete(b.subs, id)
			close(ch)
			b.mu.Unlock()
		})
	}
	return ch, cancel
}

// Publish assigns the next sequence and fans the event out. A caller-supplied
// seq is ignored: only the broker assigns it.
func (b *Broker) Publish(ev *syncmeshb.SyncEvent) uint64 {
	if ev == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()

	b.seq++
	ev.Seq = b.seq
	if ev.UpdatedAtUnixMs == 0 {
		ev.UpdatedAtUnixMs = time.Now().UnixMilli()
	}

	b.history = append(b.history, ev)
	if len(b.history) > replayHistory {
		b.history = append(b.history[:0], b.history[len(b.history)-replayHistory:]...)
	}

	for _, sub := range b.subs {
		if !matches(ev, sub.recipient) {
			continue
		}
		deliver(sub.ch, ev, b.seq)
	}
	return b.seq
}

// matches reports whether a subscriber wants this event. An empty or wildcard
// filter accepts everything; a wildcard event reaches every subscriber.
func matches(ev *syncmeshb.SyncEvent, filter string) bool {
	if filter == "" || filter == WildcardRecipient {
		return true
	}
	return ev.Recipient == filter || ev.Recipient == WildcardRecipient
}

// deliver never blocks. A full queue loses one queued event and receives a gap
// marker in its place, so the receiver resynchronizes instead of silently
// missing data.
func deliver(ch chan *syncmeshb.SyncEvent, ev *syncmeshb.SyncEvent, seq uint64) {
	select {
	case ch <- ev:
		return
	default:
	}
	select {
	case <-ch:
	default:
	}
	select {
	case ch <- &syncmeshb.SyncEvent{Seq: seq, Recipient: ev.Recipient, Gap: true}:
	default:
	}
}
