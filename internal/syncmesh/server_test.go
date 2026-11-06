package syncmesh

import (
	"context"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

// startServer binds an ephemeral loopback port and returns a dial target plus a
// stop function. A bind failure fails the test: a mesh that silently fails to
// bind is exactly the failure this package must not have.
func startServer(t *testing.T) (string, *Server, <-chan error) {
	t.Helper()
	s := New()
	errCh := make(chan error, 1)
	go func() { errCh <- s.Serve("127.0.0.1:0") }()

	deadline := time.Now().Add(5 * time.Second)
	for s.Addr() == "" {
		if time.Now().After(deadline) {
			t.Fatalf("mesh listener did not bind within 5s")
		}
		select {
		case err := <-errCh:
			t.Fatalf("mesh serve failed before binding: %v", err)
		case <-time.After(10 * time.Millisecond):
		}
	}
	return s.Addr(), s, errCh
}

// TestStopReleasesPort proves shutdown frees the port. A leaked listener would
// survive a server restart and block the next bind.
func TestStopReleasesPort(t *testing.T) {
	addr, s, _ := startServer(t)
	s.Stop()

	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	stream, err := syncmeshb.NewSyncMeshClient(conn).Subscribe(ctx, &syncmeshb.SubscribeRequest{})
	if err == nil {
		_, err = stream.Recv()
	}
	if err == nil {
		t.Fatal("Subscribe received events after Stop; the listener was not released")
	}
}

func TestStopWithLingeringSubscriberIsBounded(t *testing.T) {
	addr, s, served := startServer(t)
	defer s.Stop()
	client := dial(t, addr)
	ctx, cancel := streamContext(t)
	defer cancel()

	if _, err := client.Publish(ctx, &syncmeshb.PublishRequest{MessageId: "seed", Recipient: "mine"}); err != nil {
		t.Fatal(err)
	}
	stream, err := client.Subscribe(ctx, &syncmeshb.SubscribeRequest{Recipient: "mine"})
	if err != nil {
		t.Fatal(err)
	}
	receiveOne(t, stream) // Replay proves the subscriber registered.

	stopped := make(chan struct{})
	go func() {
		s.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(gracefulStopTimeout + 2*time.Second):
		t.Fatal("Stop was held open by a lingering subscriber")
	}
	select {
	case <-served:
	case <-time.After(time.Second):
		t.Fatal("Serve did not return after Stop")
	}
}

// TestServeReportsBindFailure proves a taken port surfaces as an error instead
// of a silently missing mesh.
func TestServeReportsBindFailure(t *testing.T) {
	addr, first, _ := startServer(t)
	defer first.Stop()

	second := New()
	err := second.Serve(addr)
	if err == nil {
		second.Stop()
		t.Fatalf("Serve on an occupied address %s returned nil", addr)
	}
}
