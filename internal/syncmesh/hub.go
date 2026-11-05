package syncmesh

import (
	"bytes"
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
	// MaxStoredMessages bounds retention and the deduplication window.
	// Retrying an ID after its entry expires is treated as a new message.
	MaxStoredMessages = 1024
	// Mesh admission must fit the bridge notification's identity bounds.
	MaxMessageIDBytes = 128
	MaxRecipientBytes = 128
)

// ErrValueTooLarge and friends are validation refusals. They map to
// InvalidArgument at the gRPC boundary and never store anything.
var (
	ErrValueTooLarge     = errors.New("syncmesh: value exceeds limit")
	ErrHopsExceeded      = errors.New("syncmesh: hops exceed limit")
	ErrRecipientEmpty    = errors.New("syncmesh: recipient required")
	ErrMessageIDEmpty    = errors.New("syncmesh: message_id required")
	ErrMessageIDTooLarge = errors.New("syncmesh: message_id exceeds limit")
	ErrRecipientTooLarge = errors.New("syncmesh: recipient exceeds limit")
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
	return h.broker.Subscribe(context.Background(), 0, recipient, "")
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
	if len(messageID) > MaxMessageIDBytes {
		return 0, false, ErrMessageIDTooLarge
	}
	if len(recipient) > MaxRecipientBytes {
		return 0, false, ErrRecipientTooLarge
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if existing, ok := h.byID[messageID]; ok {
		return existing.Seq, true, nil
	}

	ev := &syncmeshb.SyncEvent{
		Sender:    sender,
		Recipient: recipient,
		Value:     bytes.Clone(value),
		MessageId: messageID,
	}
	seq = h.broker.Publish(ev)

	h.byID[messageID] = ev
	h.order = append(h.order, messageID)
	for len(h.order) > MaxStoredMessages {
		oldest := h.order[0]
		h.order = h.order[1:]
		delete(h.byID, oldest)
	}
	return seq, false, nil
}

// Recent returns up to limit stored messages, newest last, so the browser can
// render what was addressed on this Phi. The value is copied: a caller must
// never be able to mutate stored state.
func (h *Hub) Recent(limit int) []*syncmeshb.SyncEvent {
	if limit <= 0 {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	start := 0
	if len(h.order) > limit {
		start = len(h.order) - limit
	}
	out := make([]*syncmeshb.SyncEvent, 0, len(h.order)-start)
	for _, messageID := range h.order[start:] {
		ev, ok := h.byID[messageID]
		if !ok {
			continue
		}
		copied := &syncmeshb.SyncEvent{
			Seq:             ev.GetSeq(),
			Sender:          ev.GetSender(),
			Recipient:       ev.GetRecipient(),
			Value:           append([]byte(nil), ev.GetValue()...),
			UpdatedAtUnixMs: ev.GetUpdatedAtUnixMs(),
			MessageId:       ev.GetMessageId(),
		}
		out = append(out, copied)
	}
	return out
}

// Len reports the stored message count. Used by bound tests.
func (h *Hub) Len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.byID)
}
