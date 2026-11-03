// Package syncmesh serves the Phi-to-Phi contract defined by
// proto/phi/sync/v1/sync.proto. One Phi listens on a loopback TCP socket and
// another dials it; browser traffic never reaches this listener.
//
// The listener is loopback-only until an auth interceptor exists. Do not bind
// a routable address from this package before that interceptor lands, or the
// mesh becomes an unauthenticated network face.
package syncmesh

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

// maxMessageBytes bounds one mesh frame. It matches the bridge limit so a
// value accepted from a Pi tool call cannot grow past what the bridge can
// carry back.
const maxMessageBytes = 256 * 1024

// maxMetadataBytes bounds request metadata, matching the bridge limit.
const maxMetadataBytes = 8 * 1024

// Server owns the mesh listener and its gRPC server. A nil or stopped Server
// is inert.
type Server struct {
	hub      *Hub
	grpc     *grpc.Server
	mu       sync.Mutex
	listener net.Listener
	addr     string

	// peers maps a peer label to its shared secret. Empty means loopback
	// development mode, which is the only mode allowed without credentials.
	peersMu sync.Mutex
	peers   map[string]string
	// epoch advances whenever the peer set changes so open streams retire.
	epoch atomic.Uint64
}

// New builds a mesh server with bounded frame and metadata limits. It binds
// nothing; call Serve.
func New() *Server {
	s := &Server{hub: NewHub(), peers: map[string]string{}}
	s.grpc = grpc.NewServer(
		grpc.MaxRecvMsgSize(maxMessageBytes),
		grpc.MaxSendMsgSize(maxMessageBytes),
		grpc.MaxHeaderListSize(maxMetadataBytes),
	)
	// Authentication wraps every call. With no peer configured the mesh
	// accepts loopback callers, which Serve refuses to expose beyond this
	// machine.
	s.grpc = grpc.NewServer(
		grpc.MaxRecvMsgSize(maxMessageBytes),
		grpc.MaxSendMsgSize(maxMessageBytes),
		grpc.MaxHeaderListSize(maxMetadataBytes),
		grpc.ChainUnaryInterceptor(s.authUnary),
		grpc.ChainStreamInterceptor(s.authStream),
	)
	syncmeshb.RegisterSyncMeshServer(s.grpc, &service{hub: s.hub})
	return s
}

// Serve binds addr and serves until Stop. A bind failure returns immediately
// so the caller can treat it as a startup error rather than a silent
// unavailable mesh.
func (s *Server) Serve(addr string) error {
	if s == nil || s.grpc == nil {
		return errors.New("syncmesh: server unavailable")
	}
	// A non-loopback listener without credentials would let any reachable
	// host publish into every pane on this machine. Refuse instead.
	if !isLoopbackAddr(addr) && s.peerCount() == 0 {
		return ErrNoPeers
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("syncmesh: listen %s: %w", addr, err)
	}
	s.mu.Lock()
	s.listener = ln
	s.addr = ln.Addr().String()
	s.mu.Unlock()
	slog.Info("sync mesh listening", "addr", s.Addr())
	return s.grpc.Serve(ln)
}

// Addr reports the bound address, or an empty string before Serve binds.
func (s *Server) Addr() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addr
}

// gracefulStopTimeout bounds how long shutdown waits for open streams. A
// subscriber that stays connected must not hold the process open; Publish is
// idempotent by message_id, so dropping an in-flight call is recoverable.
const gracefulStopTimeout = 5 * time.Second

// Stop closes the listener and stops the gRPC server. Safe on a nil Server and
// safe to call twice.
func (s *Server) Stop() {
	if s == nil || s.grpc == nil {
		return
	}
	stopped := make(chan struct{})
	go func() {
		s.grpc.GracefulStop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(gracefulStopTimeout):
		slog.Warn("sync mesh graceful stop timed out; forcing stop")
		s.grpc.Stop()
		<-stopped
	}
	s.mu.Lock()
	listener := s.listener
	s.listener = nil
	s.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
}

// service implements phi.sync.v1 over the local hub.
type service struct {
	syncmeshb.UnimplementedSyncMeshServer
	hub *Hub
}

// compile-time guard: the generated interface is the contract, and a protobuf
// change must break the build rather than drift.
var _ syncmeshb.SyncMeshServer = (*service)(nil)

// Subscribe streams this publisher's events until the peer goes away.
func (s *service) Subscribe(req *syncmeshb.SubscribeRequest, stream grpc.ServerStreamingServer[syncmeshb.SyncEvent]) error {
	ch, cancel := s.hub.broker.Subscribe(stream.Context(), req.GetSinceSeq(), req.GetRecipient())
	defer cancel()
	for {
		select {
		case <-stream.Context().Done():
			return nil
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
	}
}

// Publish stores one addressed message and fans it out. sender is stamped from
// the authenticated peer, never taken from the request.
func (s *service) Publish(ctx context.Context, req *syncmeshb.PublishRequest) (*syncmeshb.PublishResponse, error) {
	seq, duplicate, err := s.hub.Publish(req.GetMessageId(), senderOf(ctx), req.GetRecipient(), req.GetValue(), req.GetHops())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	return &syncmeshb.PublishResponse{Seq: seq, Duplicate: duplicate}, nil
}

// senderOf reports the authenticated peer label. In development mode, where
// no peer secret is configured, it falls back to the connection address: that
// value cannot be chosen by the caller, so it still cannot impersonate another
// agent.
func senderOf(ctx context.Context) string {
	if label, ok := senderFromContext(ctx); ok {
		return label
	}
	p, ok := peer.FromContext(ctx)
	if !ok || p.Addr == nil {
		return "unknown"
	}
	return p.Addr.String()
}

// SubscribePush registers a local subscriber for every addressed message this
// Phi publishes. It is the seam the process uses to route mesh traffic into
// pane runtimes; the returned cancel stops delivery.
func (s *Server) SubscribePush() (<-chan *syncmeshb.SyncEvent, func()) {
	if s == nil || s.hub == nil {
		ch := make(chan *syncmeshb.SyncEvent)
		close(ch)
		return ch, func() {}
	}
	return s.hub.Subscribe(WildcardRecipient)
}
