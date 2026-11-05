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
//
// A gap event carries the first sequence this subscriber is missing. Refetching
// from there (cursor gap.seq-1) recovers the hole; an event before the marker is
// only a hole when history trimmed it, and the marker reports that same point.
func (b *Broker) Subscribe(_ context.Context, sinceSeq uint64, recipient string) (<-chan *syncmeshb.SyncEvent, func()) {
	b.mu.Lock()
	ch := make(chan *syncmeshb.SyncEvent, subscriberQueue)

	pending := make([]*syncmeshb.SyncEvent, 0, len(b.history))
	for _, ev := range b.history {
		if ev.Seq > sinceSeq && matches(ev, recipient) {
			pending = append(pending, ev)
		}
	}
	if sinceSeq > b.seq {
		// A publisher restart resets its sequence; the old cursor is unusable.
		gapSeq := uint64(1)
		if len(b.history) > 0 {
			gapSeq = b.history[0].Seq
		}
		ch <- &syncmeshb.SyncEvent{Seq: gapSeq, Recipient: recipient, Gap: true}
		pending = pending[:0]
	}
	// A cursor older than anything still retained cannot be served
	// continuously. Say so with a gap event instead of handing the receiver a
	// stream that looks complete but silently skips history.
	gapSeq := uint64(0)
	if len(b.history) > 0 {
		oldest := b.history[0].Seq
		if oldest > sinceSeq && oldest-sinceSeq > 1 {
			gapSeq = oldest
		}
	}
	// The channel cannot hold more than its capacity; keep the newest and
	// move the boundary to the first event actually delivered.
	if len(pending) > cap(ch)-1 {
		pending = pending[len(pending)-(cap(ch)-1):]
		gapSeq = pending[0].Seq
	}
	if gapSeq > 0 {
		ch <- &syncmeshb.SyncEvent{Seq: gapSeq, Recipient: recipient, Gap: true}
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
		deliver(sub.ch, ev)
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

// deliver never blocks. A full queue loses its oldest event and receives a gap
// marker in its place. The marker carries the first sequence this subscriber is
// missing, so refetching from that point recovers the hole instead of stepping
// over it. Naming the event being published would sit above the hole and hide
// the dropped events below it.
func deliver(ch chan *syncmeshb.SyncEvent, ev *syncmeshb.SyncEvent) {
	select {
	case ch <- ev:
		return
	default:
	}
	missing := ev.Seq
	select {
	case dropped := <-ch:
		if dropped != nil {
			missing = dropped.Seq
		}
	default:
	}
	select {
	case ch <- &syncmeshb.SyncEvent{Seq: missing, Recipient: ev.Recipient, Gap: true}:
	default:
	}
}
