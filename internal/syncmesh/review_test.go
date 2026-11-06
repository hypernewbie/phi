package syncmesh

import (
	"context"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

func TestUnauthenticatedMeshRefusesRoutableAndAmbiguousBind(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", ":0", "[::]:0", "192.0.2.1:0", "localhost:0"} {
		t.Run(addr, func(t *testing.T) {
			s := New()
			defer s.Stop()
			if err := s.Serve(addr); err == nil {
				t.Fatal("unauthenticated mesh allowed a non-literal-loopback bind")
			}
			if s.Addr() != "" {
				t.Fatalf("listener was opened before refusal: %s", s.Addr())
			}
		})
	}
}

func TestMeshSubscriberAdmissionIsGloballyBounded(t *testing.T) {
	addr, s, _ := startServer(t)
	defer s.Stop()
	client := dial(t, addr)
	ctx, cancel := streamContext(t)
	defer cancel()
	if _, err := client.Publish(ctx, &syncmeshb.PublishRequest{MessageId: "seed", Recipient: "mine"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxSubscribers; i++ {
		stream, err := client.Subscribe(ctx, &syncmeshb.SubscribeRequest{Recipient: "mine"})
		if err != nil {
			t.Fatal(err)
		}
		// Receiving replay proves server-side registration completed.
		if _, err := stream.Recv(); err != nil {
			t.Fatal(err)
		}
	}
	stream, err := client.Subscribe(ctx, &syncmeshb.SubscribeRequest{Recipient: "mine"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Recv(); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("subscriber overflow: %v", err)
	}
}

func TestSubscribePublisherEpochOverGRPC(t *testing.T) {
	addr, s, _ := startServer(t)
	defer s.Stop()
	client := dial(t, addr)
	ctx, cancel := streamContext(t)
	defer cancel()

	if _, err := client.Publish(ctx, &syncmeshb.PublishRequest{MessageId: "new-lifetime", Recipient: "mine"}); err != nil {
		t.Fatal(err)
	}
	stream, err := client.Subscribe(ctx, &syncmeshb.SubscribeRequest{
		SinceSeq: 1, Recipient: "mine", PublisherEpoch: "previous-lifetime",
	})
	if err != nil {
		t.Fatal(err)
	}
	gap := receiveOne(t, stream)
	if !gap.GetGap() || gap.GetPublisherEpoch() == "" || gap.GetPublisherEpoch() == "previous-lifetime" {
		t.Fatalf("epoch mismatch did not produce a new-lifetime gap: %v", gap)
	}
	if ev := receiveOne(t, stream); ev.GetSeq() != 1 || ev.GetMessageId() != "new-lifetime" {
		t.Fatalf("resync did not replay from the new lifetime's start: %v", ev)
	}

	matching, err := client.Subscribe(ctx, &syncmeshb.SubscribeRequest{
		SinceSeq: 1, Recipient: "mine", PublisherEpoch: gap.GetPublisherEpoch(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Publish(ctx, &syncmeshb.PublishRequest{MessageId: "same-lifetime", Recipient: "mine"}); err != nil {
		t.Fatal(err)
	}
	if ev := receiveOne(t, matching); ev.GetGap() || ev.GetSeq() != 2 || ev.GetMessageId() != "same-lifetime" {
		t.Fatalf("matching epoch did not resume at the cursor: %v", ev)
	}
}

func TestCursorFromPreviousPublisherLifetimeRequiresResync(t *testing.T) {
	previous := NewBroker()
	for i := 0; i < 5; i++ {
		previous.Publish(&syncmeshb.SyncEvent{Recipient: "mine"})
	}

	for _, tc := range []struct {
		name      string
		newEvents int
	}{{"below old cursor", 1}, {"equal to old cursor", 5}, {"above old cursor", 8}} {
		t.Run(tc.name, func(t *testing.T) {
			b := NewBroker()
			for i := 0; i < tc.newEvents; i++ {
				b.Publish(&syncmeshb.SyncEvent{Recipient: "mine"})
			}
			ch, cancel := b.Subscribe(context.Background(), 5, "mine", previous.epoch)
			defer cancel()

			gap := drainN(t, ch, 1)[0]
			if !gap.GetGap() {
				t.Fatal("old lifetime cursor silently skipped new publisher history")
			}
			if gap.GetPublisherEpoch() != b.epoch {
				t.Fatal("gap does not identify the new publisher lifetime")
			}
			for i, ev := range drainN(t, ch, tc.newEvents) {
				if ev.GetSeq() != uint64(i+1) {
					t.Fatalf("replayed seq = %d, want %d", ev.GetSeq(), i+1)
				}
			}
		})
	}
}

func TestCursorWithoutPublisherEpochRequiresResync(t *testing.T) {
	b := NewBroker()
	b.Publish(&syncmeshb.SyncEvent{Recipient: "mine"})
	ch, cancel := b.Subscribe(context.Background(), 1, "mine", "")
	defer cancel()

	if !drainN(t, ch, 1)[0].GetGap() {
		t.Fatal("an unverifiable cursor did not force resync")
	}
	if ev := drainN(t, ch, 1)[0]; ev.GetSeq() != 1 {
		t.Fatalf("replayed seq = %d, want full replay from 1", ev.GetSeq())
	}
}
