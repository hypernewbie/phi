package syncmesh

import (
	"context"
	"testing"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

func drainN(t *testing.T, ch <-chan *syncmeshb.SyncEvent, n int) []*syncmeshb.SyncEvent {
	t.Helper()
	out := make([]*syncmeshb.SyncEvent, 0, n)
	for i := 0; i < n; i++ {
		select {
		case ev := <-ch:
			out = append(out, ev)
		default:
			t.Fatalf("wanted %d events, got %d", n, len(out))
		}
	}
	return out
}

// TestSubscribeReceivesPublished is the core fan-out invariant: a subscriber
// registered before the write sees it, with a positive ordered sequence.
func TestSubscribeReceivesPublished(t *testing.T) {
	b := NewBroker()
	ch, cancel := b.Subscribe(context.Background(), 0, WildcardRecipient)
	defer cancel()

	seq := b.Publish(&syncmeshb.SyncEvent{Sender: "a", Recipient: "b", Value: []byte("hello")})
	if seq == 0 {
		t.Fatal("Publish returned seq 0; sequence assignment is missing")
	}

	ev := drainN(t, ch, 1)[0]
	if ev.GetSeq() != seq {
		t.Fatalf("event seq = %d, want %d", ev.GetSeq(), seq)
	}
	if string(ev.GetValue()) != "hello" {
		t.Fatalf("event value = %q, want %q", ev.GetValue(), "hello")
	}
	if ev.GetGap() {
		t.Fatal("a delivered event is marked as a gap")
	}
}

// TestSequenceIsMonotonic guards ordering: a receiver resuming from a cursor
// depends on strictly increasing values.
func TestSequenceIsMonotonic(t *testing.T) {
	b := NewBroker()
	ch, cancel := b.Subscribe(context.Background(), 0, WildcardRecipient)
	defer cancel()

	for i := 0; i < 5; i++ {
		b.Publish(&syncmeshb.SyncEvent{Recipient: WildcardRecipient, Value: []byte{byte(i)}})
	}
	evs := drainN(t, ch, 5)
	for i := 1; i < len(evs); i++ {
		if evs[i].GetSeq() <= evs[i-1].GetSeq() {
			t.Fatalf("seq not increasing: %d then %d", evs[i-1].GetSeq(), evs[i].GetSeq())
		}
	}
}

// TestRecipientFilter proves a subscriber only receives addressed traffic it
// asked for. Without this, every pane on a Phi would react to every message.
func TestRecipientFilter(t *testing.T) {
	b := NewBroker()
	mine, cancelMine := b.Subscribe(context.Background(), 0, "agent-b")
	defer cancelMine()
	other, cancelOther := b.Subscribe(context.Background(), 0, "agent-c")
	defer cancelOther()

	b.Publish(&syncmeshb.SyncEvent{Recipient: "agent-b", Value: []byte("for b")})

	drainN(t, mine, 1)
	select {
	case ev := <-other:
		t.Fatalf("subscriber for agent-c received %q addressed to %q", ev.GetValue(), ev.GetRecipient())
	default:
	}
}

// TestSlowSubscriberGetsGap is the backpressure invariant. A full queue must
// not block the publisher and must not lose data silently: the slow receiver
// has to learn that it missed something.
func TestSlowSubscriberGetsGap(t *testing.T) {
	b := NewBroker()
	slow, cancelSlow := b.Subscribe(context.Background(), 0, WildcardRecipient)
	defer cancelSlow()
	fast, cancelFast := b.Subscribe(context.Background(), 0, WildcardRecipient)
	defer cancelFast()

	// Overflow the slow subscriber's queue while draining the fast one.
	for i := 0; i < subscriberQueue+10; i++ {
		b.Publish(&syncmeshb.SyncEvent{Recipient: WildcardRecipient, Value: []byte("x")})
		select {
		case <-fast:
		default:
			t.Fatal("fast subscriber was starved by the slow one")
		}
	}

	sawGap := false
	for len(slow) > 0 {
		if (<-slow).GetGap() {
			sawGap = true
		}
	}
	if !sawGap {
		t.Fatal("slow subscriber lost events without a gap marker")
	}
}

// TestCancelIsIdempotentAndStopsDelivery guards double-cancel, which would
// otherwise close a channel twice and panic the publisher.
func TestCancelIsIdempotentAndStopsDelivery(t *testing.T) {
	b := NewBroker()
	ch, cancel := b.Subscribe(context.Background(), 0, WildcardRecipient)
	cancel()
	cancel()

	b.Publish(&syncmeshb.SyncEvent{Recipient: WildcardRecipient, Value: []byte("after cancel")})

	if _, ok := <-ch; ok {
		t.Fatal("received an event after cancel")
	}
}

// TestSubscribeReplaysBeforeJoining closes the startup race: an event published
// after the client calls Subscribe but before the server registers it must
// still arrive. Without replay it is lost with no way to recover.
func TestSubscribeReplaysBeforeJoining(t *testing.T) {
	b := NewBroker()
	b.Publish(&syncmeshb.SyncEvent{Recipient: "agent-b", Value: []byte("early"), MessageId: "m-early"})

	ch, cancel := b.Subscribe(context.Background(), 0, "agent-b")
	defer cancel()

	ev := drainN(t, ch, 1)[0]
	if string(ev.GetValue()) != "early" {
		t.Fatalf("value = %q, want the pre-subscription event", ev.GetValue())
	}
	if ev.GetMessageId() != "m-early" {
		t.Fatalf("message_id = %q, want m-early", ev.GetMessageId())
	}
}

// TestSubscribeResumesFromCursor proves a reconnecting receiver skips what it
// already handled instead of re-injecting it.
func TestSubscribeResumesFromCursor(t *testing.T) {
	b := NewBroker()
	first := b.Publish(&syncmeshb.SyncEvent{Recipient: "*", Value: []byte("seen")})
	b.Publish(&syncmeshb.SyncEvent{Recipient: "*", Value: []byte("missed")})

	ch, cancel := b.Subscribe(context.Background(), first, WildcardRecipient)
	defer cancel()

	ev := drainN(t, ch, 1)[0]
	if string(ev.GetValue()) != "missed" {
		t.Fatalf("value = %q, want only the event after seq %d", ev.GetValue(), first)
	}
	select {
	case extra := <-ch:
		t.Fatalf("replayed an already-handled event: %q", extra.GetValue())
	default:
	}
}

// TestCursorPredatingRetentionYieldsGap is the replay honesty invariant: a
// receiver resuming from a sequence the publisher no longer retains must be
// told its history is broken, not handed a stream that looks complete.
//
// The retained history here belongs to another recipient so the filtered
// replay stays small; the gap is still raised because the publisher cannot
// prove that nothing addressed to this subscriber was dropped.
func TestCursorPredatingRetentionYieldsGap(t *testing.T) {
	b := NewBroker()
	for i := 0; i < replayHistory+10; i++ {
		b.Publish(&syncmeshb.SyncEvent{Recipient: "elsewhere", Value: []byte("x")})
	}
	oldest := b.history[0].Seq

	ch, cancel := b.Subscribe(context.Background(), 1, "mine")
	defer cancel()

	gap := drainN(t, ch, 1)[0]
	if !gap.GetGap() {
		t.Fatal("cursor older than retention did not produce a gap event")
	}
	if gap.GetSeq() != oldest {
		t.Fatalf("gap seq = %d, want the oldest retained seq %d", gap.GetSeq(), oldest)
	}
}

// TestReplayOverflowGapMarksDeliveryBoundary covers the second way a gap
// arises: the receiver asked for more retained events than its queue holds, so
// the newest are kept and the boundary names the first one actually delivered.
func TestReplayOverflowGapMarksDeliveryBoundary(t *testing.T) {
	b := NewBroker()
	for i := 0; i < subscriberQueue*2; i++ {
		b.Publish(&syncmeshb.SyncEvent{Recipient: WildcardRecipient, Value: []byte("x")})
	}
	ch, cancel := b.Subscribe(context.Background(), 0, WildcardRecipient)
	defer cancel()

	gap := drainN(t, ch, 1)[0]
	if !gap.GetGap() {
		t.Fatal("replay larger than the queue produced no gap event")
	}
	next := drainN(t, ch, 1)[0]
	if next.GetSeq() != gap.GetSeq() {
		t.Fatalf("first delivered seq = %d, want the gap boundary %d", next.GetSeq(), gap.GetSeq())
	}
}

// TestFreshSubscriberOnTrimmedHistoryYieldsGap covers the cursor-0 case: a
// publisher that already dropped events cannot pretend a fresh subscriber saw
// everything.
func TestFreshSubscriberOnTrimmedHistoryYieldsGap(t *testing.T) {
	b := NewBroker()
	for i := 0; i < replayHistory+5; i++ {
		b.Publish(&syncmeshb.SyncEvent{Recipient: WildcardRecipient, Value: []byte("x")})
	}
	ch, cancel := b.Subscribe(context.Background(), 0, WildcardRecipient)
	defer cancel()

	if !drainN(t, ch, 1)[0].GetGap() {
		t.Fatal("fresh subscriber on trimmed history got no gap event")
	}
}

// TestCurrentCursorYieldsNoGap guards against always emitting a gap, which
// would make the signal worthless.
func TestCurrentCursorYieldsNoGap(t *testing.T) {
	b := NewBroker()
	b.Publish(&syncmeshb.SyncEvent{Recipient: "*", Value: []byte("one")})
	second := b.Publish(&syncmeshb.SyncEvent{Recipient: "*", Value: []byte("two")})

	ch, cancel := b.Subscribe(context.Background(), second, WildcardRecipient)
	defer cancel()
	select {
	case ev := <-ch:
		t.Fatalf("up-to-date cursor received %v, want nothing", ev)
	default:
	}

	b.Publish(&syncmeshb.SyncEvent{Recipient: "*", Value: []byte("three")})
	ev := drainN(t, ch, 1)[0]
	if ev.GetGap() || string(ev.GetValue()) != "three" {
		t.Fatalf("live event = %v, want a non-gap new event", ev)
	}
}

// TestReplayIsContiguous proves a mid-range cursor receives exactly the
// missing messages, in order, with no fabricated history.
func TestReplayIsContiguous(t *testing.T) {
	b := NewBroker()
	for i := 0; i < 5; i++ {
		b.Publish(&syncmeshb.SyncEvent{Recipient: "*", Value: []byte{byte('a' + i)}})
	}
	ch, cancel := b.Subscribe(context.Background(), 2, WildcardRecipient)
	defer cancel()

	want := []string{"c", "d", "e"}
	for i, expected := range want {
		ev := drainN(t, ch, 1)[0]
		if ev.GetGap() {
			t.Fatalf("event %d reported a gap on a retained range", i)
		}
		if string(ev.GetValue()) != expected {
			t.Fatalf("event %d = %q, want %q", i, ev.GetValue(), expected)
		}
	}
}
