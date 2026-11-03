package syncmesh

import (
	"context"
	"errors"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

func dialWithSecret(t *testing.T, addr, secret string) syncmeshb.SyncMeshClient {
	t.Helper()
	token := "Bearer " + secret
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithUnaryInterceptor(func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
			return invoker(metadata.AppendToOutgoingContext(ctx, authMetadataKey, token), method, req, reply, cc, opts...)
		}),
		grpc.WithStreamInterceptor(func(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
			return streamer(metadata.AppendToOutgoingContext(ctx, authMetadataKey, token), desc, cc, method, opts...)
		}),
	)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return syncmeshb.NewSyncMeshClient(conn)
}

func publishAs(t *testing.T, client syncmeshb.SyncMeshClient, id string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := client.Publish(ctx, &syncmeshb.PublishRequest{MessageId: id, Recipient: "*", Value: []byte("x")})
	return err
}

// TestPeerSecretIsRequired proves a configured peer set turns the mesh into an
// authenticated surface: no credential and a wrong credential are both refused.
func TestPeerSecretIsRequired(t *testing.T) {
	s, addr, cleanup := startServerWithPeers(t, map[string]string{"laptop-a": "s3cret-a"})
	defer cleanup()

	if err := publishAs(t, dial(t, addr), "no-cred"); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated publish code = %v, want Unauthenticated", status.Code(err))
	}
	if err := publishAs(t, dialWithSecret(t, addr, "wrong"), "bad-cred"); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("wrong secret code = %v, want Unauthenticated", status.Code(err))
	}
	if n := s.hub.Len(); n != 0 {
		t.Fatalf("stored %d messages from refused callers, want 0", n)
	}
}

// TestPeerSecretStampsSender is the identity invariant: the sender reported to
// subscribers is the configured label, not anything the caller supplied.
func TestPeerSecretStampsSender(t *testing.T) {
	_, addr, cleanup := startServerWithPeers(t, map[string]string{"laptop-a": "s3cret-a"})
	defer cleanup()

	subscriber := dialWithSecret(t, addr, "s3cret-a")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := subscriber.Subscribe(ctx, &syncmeshb.SubscribeRequest{Recipient: "*"})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := publishAs(t, subscriber, "m-1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	ev, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv: %v", err)
	}
	if ev.GetSender() != "laptop-a" {
		t.Fatalf("sender = %q, want the configured label", ev.GetSender())
	}
}

// TestRevokingPeerClosesOpenStream is the live-revocation invariant: removing a
// peer retires a stream that is already running, not just new calls.
func TestRevokingPeerClosesOpenStream(t *testing.T) {
	s, addr, cleanup := startServerWithPeers(t, map[string]string{"laptop-a": "s3cret-a", "laptop-b": "s3cret-b"})
	defer cleanup()

	stream, err := dialWithSecret(t, addr, "s3cret-a").Subscribe(
		context.Background(), &syncmeshb.SubscribeRequest{Recipient: "*"})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	// Confirm the stream is live before revoking.
	if err := publishAs(t, dialWithSecret(t, addr, "s3cret-b"), "m-1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("recv before revoke: %v", err)
	}

	s.SetPeers(map[string]string{"laptop-b": "s3cret-b"})
	if err := publishAs(t, dialWithSecret(t, addr, "s3cret-b"), "m-2"); err != nil {
		t.Fatalf("publish after revoke: %v", err)
	}
	if _, err := stream.Recv(); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("revoked stream recv code = %v, want Unauthenticated", status.Code(err))
	}
}

// TestAddingPeerKeepsHealthyStream proves a peer-set change does not disturb a
// stream whose own label still exists.
func TestAddingPeerKeepsHealthyStream(t *testing.T) {
	s, addr, cleanup := startServerWithPeers(t, map[string]string{"laptop-a": "s3cret-a"})
	defer cleanup()

	stream, err := dialWithSecret(t, addr, "s3cret-a").Subscribe(
		context.Background(), &syncmeshb.SubscribeRequest{Recipient: "*"})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	s.SetPeers(map[string]string{"laptop-a": "s3cret-a", "laptop-b": "s3cret-b"})
	if err := publishAs(t, dialWithSecret(t, addr, "s3cret-a"), "m-1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("healthy stream was closed by an unrelated peer change: %v", err)
	}
}

// TestLoopbackBindWithoutPeers proves development mode still works locally.
func TestLoopbackBindWithoutPeers(t *testing.T) {
	addr, s := startServer(t)
	defer s.Stop()
	if err := publishAs(t, dial(t, addr), "m-1"); err != nil {
		t.Fatalf("loopback publish without peers: %v", err)
	}
	if s.peerCount() != 0 {
		t.Fatalf("peer count = %d, want 0", s.peerCount())
	}
}

// TestNonLoopbackBindRequiresPeers is the guard that makes "auth before wider
// binding" a property of the code rather than a comment.
func TestNonLoopbackBindRequiresPeers(t *testing.T) {
	s := New()
	err := s.Serve("0.0.0.0:0")
	if !errors.Is(err, ErrNoPeers) {
		t.Fatalf("err = %v, want ErrNoPeers", err)
	}
	// With a peer configured the guard stands down; Stop closes it again.
	s.SetPeers(map[string]string{"laptop-a": "s3cret-a"})
	done := make(chan error, 1)
	go func() { done <- s.Serve("0.0.0.0:0") }()
	waitForAddr(t, s)
	s.Stop()
	<-done
}

func startServerWithPeers(t *testing.T, peers map[string]string) (*Server, string, func()) {
	t.Helper()
	addr, s := startServer(t)
	s.SetPeers(peers)
	return s, addr, func() { s.Stop() }
}

func waitForAddr(t *testing.T, s *Server) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if s.Addr() != "" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("server never bound")
}
