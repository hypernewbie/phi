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
	addr, s := startServer(t)
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

func TestCursorFromPreviousPublisherLifetimeRequiresResync(t *testing.T) {
	b := NewBroker()
	b.Publish(&syncmeshb.SyncEvent{Recipient: "mine", Value: []byte("after restart")})
	ch, cancel := b.Subscribe(context.Background(), 500, "mine")
	defer cancel()
	gap := drainN(t, ch, 1)[0]
	if !gap.GetGap() {
		t.Fatal("old lifetime cursor silently skipped new publisher history")
	}
	b.Publish(&syncmeshb.SyncEvent{Recipient: "mine", Value: []byte("live")})
	if ev := drainN(t, ch, 1)[0]; string(ev.GetValue()) != "live" {
		t.Fatalf("live stream did not recover: %v", ev)
	}
}
