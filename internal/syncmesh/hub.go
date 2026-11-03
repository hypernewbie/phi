package syncmesh

import (
	"context"
	"errors"
	"sync"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

const (
	// MaxValueBytes bounds one addressed message. It matches the bridge value
	// limit so a message the mesh accepts can also be delivered to a Pi pane.
	MaxValueBytes = 64 * 1024
	// MaxHops bounds relay depth. A message past this limit is a loop, not
	// traffic, and is refused before it is stored.
	MaxHops = 3
	// maxStoredMessages bounds retention. Oldest entries are evicted first, so
	// a retry older than the window is treated as new: at that point the
	// sender has long since stopped retrying.
	maxStoredMessages = 1024
)

// ErrValueTooLarge and friends are validation refusals. They map to
// InvalidArgument at the gRPC boundary and never store anything.
var (
	ErrValueTooLarge  = errors.New("syncmesh: value exceeds limit")
	ErrHopsExceeded   = errors.New("syncmesh: hops exceed limit")
	ErrRecipientEmpty = errors.New("syncmesh: recipient required")
	ErrMessageIDEmpty = errors.New("syncmesh: message_id required")
)

// Hub owns the addressed-message store and the subscriber fan-out. Publish is
// serialized so a duplicate message_id can never consume a second sequence.
type Hub struct {
	mu     sync.Mutex
	broker *Broker
	byID   map[string]*syncmeshb.SyncEvent
	order  []string
}

// NewHub returns an empty hub.
func NewHub() *Hub {
	return &Hub{broker: NewBroker(), byID: make(map[string]*syncmeshb.SyncEvent)}
}

// Subscribe registers a live subscriber filtered by recipient.
func (h *Hub) Subscribe(recipient string) (<-chan *syncmeshb.SyncEvent, func()) {
	return h.broker.Subscribe(context.Background(), 0, recipient)
}

// Publish validates, deduplicates, stores, and fans out one message. sender is
// supplied by the caller from the authenticated peer, never by the request.
// The returned duplicate flag means messageID was already stored; the original
// sequence is returned and no second event is emitted.
func (h *Hub) Publish(messageID, sender, recipient string, value []byte, hops uint32) (seq uint64, duplicate bool, err error) {
	if len(value) > MaxValueBytes {
		return 0, false, ErrValueTooLarge
	}
	if hops > MaxHops {
		return 0, false, ErrHopsExceeded
	}
	if recipient == "" {
		return 0, false, ErrRecipientEmpty
	}
	if messageID == "" {
		return 0, false, ErrMessageIDEmpty
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if existing, ok := h.byID[messageID]; ok {
		return existing.Seq, true, nil
	}

	ev := &syncmeshb.SyncEvent{
		Sender:    sender,
		Recipient: recipient,
		Value:     value,
		MessageId: messageID,
	}
	seq = h.broker.Publish(ev)

	h.byID[messageID] = ev
	h.order = append(h.order, messageID)
	for len(h.order) > maxStoredMessages {
		oldest := h.order[0]
		h.order = h.order[1:]
		delete(h.byID, oldest)
	}
	return seq, false, nil
}

// Len reports the stored message count. Used by bound tests.
func (h *Hub) Len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.byID)
}
