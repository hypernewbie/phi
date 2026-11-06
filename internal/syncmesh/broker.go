package syncmesh

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"

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
	epoch  string
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
	return &Broker{subs: make(map[uint64]*brokerSub), epoch: uuid.NewString()}
}

// WildcardRecipient accepts every event regardless of its recipient.
const WildcardRecipient = "*"

// Subscribe registers a subscriber and backfills everything it missed.
//
// The snapshot and the registration happen under one lock, so an event is
// either in the replay or arrives live — never in the gap between them.
// sinceSeq 0 replays the whole retained history. A nonzero sinceSeq must
// include the publisher epoch from the last received event. An empty or
// mismatched epoch forces a gap and replay from zero, including for older
// clients that do not send an epoch.
//
// A gap event requires a full state resync. Its seq is a diagnostic boundary,
// not a resume cursor; replay windows and live queues can have different holes.
func (b *Broker) Subscribe(_ context.Context, sinceSeq uint64, recipient, publisherEpoch string) (<-chan *syncmeshb.SyncEvent, func()) {
	b.mu.Lock()
	ch := make(chan *syncmeshb.SyncEvent, subscriberQueue)

	// A sequence proves continuity only within one publisher lifetime.
	resync := sinceSeq > b.seq || (sinceSeq > 0 && publisherEpoch != b.epoch)
	if resync {
		sinceSeq = 0
	}
	pending := make([]*syncmeshb.SyncEvent, 0, len(b.history))
	for _, ev := range b.history {
		if ev.Seq > sinceSeq && matches(ev, recipient) {
			pending = append(pending, ev)
		}
	}
	gapSeq := uint64(0)
	if resync {
		gapSeq = 1
		if len(b.history) > 0 {
			gapSeq = b.history[0].Seq
		}
	}
	// A cursor older than anything still retained cannot be served
	// continuously. Say so with a gap event instead of handing the receiver a
	// stream that looks complete but silently skips history.
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
		ch <- &syncmeshb.SyncEvent{Seq: gapSeq, Recipient: recipient, Gap: true, PublisherEpoch: b.epoch}
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
	ev.PublisherEpoch = b.epoch
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
// marker in its place. The dropped sequence is a diagnostic boundary; the
// receiver must resync full state rather than treating it as a resume cursor.
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
	case ch <- &syncmeshb.SyncEvent{Seq: missing, Recipient: ev.Recipient, Gap: true, PublisherEpoch: ev.GetPublisherEpoch()}:
	default:
	}
}
