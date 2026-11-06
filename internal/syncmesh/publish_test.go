package syncmesh

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

func dial(t *testing.T, addr string) syncmeshb.SyncMeshClient {
	t.Helper()
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return syncmeshb.NewSyncMeshClient(conn)
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// streamContext cancels before the deferred server Stop, so shutdown is not
// held open by the test's own subscription.
func streamContext(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	return context.WithTimeout(context.Background(), 10*time.Second)
}

// receiveOne reads one event, failing the test if none arrives in time.
func receiveOne(t *testing.T, stream grpc.ServerStreamingClient[syncmeshb.SyncEvent]) *syncmeshb.SyncEvent {
	t.Helper()
	ev, err := stream.Recv()
	if err != nil {
		t.Fatalf("stream recv: %v", err)
	}
	return ev
}

// TestPublishReachesSubscriber is the end-to-end mesh invariant over a real
// gRPC connection: one addressed message published by one client arrives at a
// subscriber with its value and a caller-visible message id.
func TestPublishReachesSubscriber(t *testing.T) {
	addr, s, _ := startServer(t)
	defer s.Stop()
	client := dial(t, addr)
	ctx, cancel := streamContext(t)
	defer cancel()

	stream, err := client.Subscribe(ctx, &syncmeshb.SubscribeRequest{Recipient: "agent-b"})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	resp, err := client.Publish(ctx, &syncmeshb.PublishRequest{
		MessageId: "m-1",
		Recipient: "agent-b",
		Value:     []byte("hello"),
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if resp.GetSeq() == 0 {
		t.Fatal("publish returned seq 0")
	}

	ev := receiveOne(t, stream)
	if string(ev.GetValue()) != "hello" {
		t.Fatalf("value = %q, want %q", ev.GetValue(), "hello")
	}
	if ev.GetMessageId() != "m-1" {
		t.Fatalf("message_id = %q, want %q; receivers cannot dedupe without it", ev.GetMessageId(), "m-1")
	}
	if ev.GetSeq() != resp.GetSeq() {
		t.Fatalf("event seq %d != publish seq %d", ev.GetSeq(), resp.GetSeq())
	}
	if ev.GetSender() == "" {
		t.Fatal("sender was not stamped by the server")
	}
}

// TestDuplicateMessageIdPublishesOnce is the retry invariant: a sender that
// retries after an unknown outcome must not create a second message or a
// second injection.
func TestDuplicateMessageIdPublishesOnce(t *testing.T) {
	addr, s, _ := startServer(t)
	defer s.Stop()
	client := dial(t, addr)
	ctx := testContext(t)
	events, cancel := s.SubscribePush()
	defer cancel()

	first, err := client.Publish(ctx, &syncmeshb.PublishRequest{
		MessageId: "m-dup", Recipient: "agent-b", Value: []byte("once"),
	})
	if err != nil {
		t.Fatalf("first publish: %v", err)
	}
	if first.GetDuplicate() {
		t.Fatal("first publish reported duplicate")
	}
	select {
	case ev := <-events:
		if ev.GetMessageId() != "m-dup" {
			t.Fatalf("first event id = %q, want m-dup", ev.GetMessageId())
		}
	case <-ctx.Done():
		t.Fatal("first publish did not emit an event")
	}

	second, err := client.Publish(ctx, &syncmeshb.PublishRequest{
		MessageId: "m-dup", Recipient: "agent-b", Value: []byte("once"),
	})
	if err != nil {
		t.Fatalf("second publish: %v", err)
	}
	if !second.GetDuplicate() {
		t.Fatal("second publish did not report duplicate")
	}
	if second.GetSeq() != first.GetSeq() {
		t.Fatalf("duplicate returned seq %d, want original %d", second.GetSeq(), first.GetSeq())
	}
	if n := s.hub.Len(); n != 1 {
		t.Fatalf("stored %d messages, want 1", n)
	}
	select {
	case ev := <-events:
		t.Fatalf("duplicate emitted a second event: %v", ev)
	default:
	}
}

// TestSenderIsStampedNotSupplied proves the request cannot choose its sender.
func TestSenderIsStampedNotSupplied(t *testing.T) {
	addr, s, _ := startServer(t)
	defer s.Stop()
	client := dial(t, addr)
	ctx, cancel := streamContext(t)
	defer cancel()

	stream, err := client.Subscribe(ctx, &syncmeshb.SubscribeRequest{Recipient: "*"})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := client.Publish(ctx, &syncmeshb.PublishRequest{
		MessageId: "m-sender", Recipient: "*", Value: []byte("x"),
	}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	ev := receiveOne(t, stream)
	if ev.GetSender() == "" || !strings.Contains(ev.GetSender(), ":") {
		t.Fatalf("sender = %q, want the peer address stamped by the server", ev.GetSender())
	}
}

// TestPublishRefusals guards the boundary checks: an invalid message must not
// reach the store or the subscribers.
func TestPublishRefusals(t *testing.T) {
	addr, s, _ := startServer(t)
	defer s.Stop()
	client := dial(t, addr)
	ctx := testContext(t)

	cases := []struct {
		name string
		req  *syncmeshb.PublishRequest
		want error
	}{
		{"oversized value", &syncmeshb.PublishRequest{MessageId: "a", Recipient: "*", Value: make([]byte, MaxValueBytes+1)}, ErrValueTooLarge},
		{"hops exceeded", &syncmeshb.PublishRequest{MessageId: "b", Recipient: "*", Value: []byte("v"), Hops: MaxHops + 1}, ErrHopsExceeded},
		{"empty recipient", &syncmeshb.PublishRequest{MessageId: "c", Value: []byte("v")}, ErrRecipientEmpty},
		{"empty message id", &syncmeshb.PublishRequest{Recipient: "*", Value: []byte("v")}, ErrMessageIDEmpty},
		{"oversized id", &syncmeshb.PublishRequest{MessageId: strings.Repeat("x", MaxMessageIDBytes+1), Recipient: "pane"}, ErrMessageIDTooLarge},
		{"oversized recipient", &syncmeshb.PublishRequest{MessageId: "id", Recipient: strings.Repeat("x", MaxRecipientBytes+1)}, ErrRecipientTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := client.Publish(ctx, tc.req)
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("code = %v, want InvalidArgument (err: %v)", status.Code(err), err)
			}
			if !strings.Contains(status.Convert(err).Message(), tc.want.Error()) {
				t.Fatalf("message %q does not name %v", status.Convert(err).Message(), tc.want)
			}
		})
	}
	if n := s.hub.Len(); n != 0 {
		t.Fatalf("stored %d messages after refusals, want 0", n)
	}
}

// TestStoreEvictsOldest bounds memory: retention never grows without limit.
func TestStoreEvictsOldest(t *testing.T) {
	h := NewHub()
	for i := 0; i < MaxStoredMessages+5; i++ {
		if _, _, err := h.Publish(strconv.Itoa(i), "s", "*", []byte("v"), 0); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
	}
	if n := h.Len(); n != MaxStoredMessages {
		t.Fatalf("stored %d messages, want %d", n, MaxStoredMessages)
	}
	latest := strconv.Itoa(MaxStoredMessages + 4)
	if _, duplicate, err := h.Publish(latest, "s", "*", nil, 0); err != nil || !duplicate {
		t.Fatalf("newest message was not retained: duplicate=%v err=%v", duplicate, err)
	}
	if _, duplicate, err := h.Publish("0", "s", "*", nil, 0); err != nil || duplicate {
		t.Fatalf("oldest message was not evicted: duplicate=%v err=%v", duplicate, err)
	}
}
