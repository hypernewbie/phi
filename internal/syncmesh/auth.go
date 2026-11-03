package syncmesh

import (
	"context"
	"crypto/subtle"
	"errors"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// authMetadataKey carries the peer credential. The value is
// "Bearer <secret>" so a standard gRPC credential helper can supply it.
const authMetadataKey = "authorization"

// ErrNoPeers is returned when a non-loopback bind is requested while no peer
// secret is configured. Without it, exposing the mesh would create an
// unauthenticated write path into every pane.
var ErrNoPeers = errors.New("syncmesh: refusing a non-loopback bind without peer secrets")

type senderKey struct{}

// senderFromContext returns the peer label stamped by the interceptor.
func senderFromContext(ctx context.Context) (string, bool) {
	label, ok := ctx.Value(senderKey{}).(string)
	return label, ok && label != ""
}

// SetPeers replaces the accepted peer secrets and invalidates every open
// stream. The label is the identity reported as sender, so a secret is
// personal to one peer and can be revoked without disturbing the others.
//
// An empty map means no authentication: acceptable only because such a server
// refuses to bind a non-loopback address.
func (s *Server) SetPeers(peers map[string]string) {
	if s == nil {
		return
	}
	s.peersMu.Lock()
	s.peers = make(map[string]string, len(peers))
	for label, secret := range peers {
		if label == "" || secret == "" {
			continue
		}
		s.peers[label] = secret
	}
	s.peersMu.Unlock()
	// Bumping the epoch is what retires already-open streams: an interceptor
	// alone only guards new calls.
	s.epoch.Add(1)
}

// labelFor reports which peer secret matches. Every configured secret is
// compared so the work does not reveal which label a guess was close to.
func (s *Server) labelFor(secret string) (string, bool) {
	s.peersMu.Lock()
	defer s.peersMu.Unlock()
	label := ""
	found := 0
	for candidate, expected := range s.peers {
		if subtle.ConstantTimeCompare([]byte(secret), []byte(expected)) == 1 {
			label = candidate
			found = 1
		}
	}
	return label, found == 1
}

// authenticate validates the caller metadata. When no peer is configured the
// mesh is in loopback development mode and every caller is accepted.
func (s *Server) authenticate(ctx context.Context) (context.Context, error) {
	s.peersMu.Lock()
	configured := len(s.peers) > 0
	s.peersMu.Unlock()
	if !configured {
		return ctx, nil
	}
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "missing credentials")
	}
	values := md.Get(authMetadataKey)
	if len(values) != 1 {
		return nil, status.Error(codes.Unauthenticated, "missing credentials")
	}
	secret, ok := bearerToken(values[0])
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "malformed credentials")
	}
	label, ok := s.labelFor(secret)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "unknown peer")
	}
	return context.WithValue(ctx, senderKey{}, label), nil
}

// bearerToken extracts the token from an "Bearer <token>" value.
func bearerToken(value string) (string, bool) {
	const prefix = "Bearer "
	if len(value) <= len(prefix) || value[:len(prefix)] != prefix {
		return "", false
	}
	return value[len(prefix):], true
}

// authUnary validates every unary call.
func (s *Server) authUnary(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	ctx, err := s.authenticate(ctx)
	if err != nil {
		return nil, err
	}
	return handler(ctx, req)
}

// authStream validates a stream at open time and re-checks the epoch on every
// message, so replacing the peer set retires a running subscription instead of
// letting a revoked peer keep receiving.
func (s *Server) authStream(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
	ctx, err := s.authenticate(ss.Context())
	if err != nil {
		return err
	}
	epoch := s.epoch.Load()
	return handler(srv, &fencedStream{ServerStream: ss, ctx: ctx, epoch: epoch, server: s})
}

// fencedStream re-checks the peer-set epoch before every send and receive.
type fencedStream struct {
	grpc.ServerStream
	ctx    context.Context
	epoch  uint64
	server *Server
}

func (f *fencedStream) Context() context.Context { return f.ctx }

func (f *fencedStream) retired() bool {
	if f.server.epoch.Load() == f.epoch {
		return false
	}
	// Re-authenticate against the current peer set: a retired label stays
	// out, while an unrelated change (adding another peer) does not kill a
	// healthy stream.
	sender, ok := senderFromContext(f.ctx)
	if !ok {
		// Unauthenticated development mode; the peer set appeared while the
		// stream was open, so the stream must present credentials it does not
		// have.
		return true
	}
	f.server.peersMu.Lock()
	_, stillAllowed := f.server.peers[sender]
	f.server.peersMu.Unlock()
	return !stillAllowed
}

func (f *fencedStream) RecvMsg(m any) error {
	if f.retired() {
		return status.Error(codes.Unauthenticated, "peer retired")
	}
	return f.ServerStream.RecvMsg(m)
}

func (f *fencedStream) SendMsg(m any) error {
	if f.retired() {
		return status.Error(codes.Unauthenticated, "peer retired")
	}
	return f.ServerStream.SendMsg(m)
}

// isLoopbackAddr reports whether a listen address stays on this machine.
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "" {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// peerCount reports the configured peer count.
func (s *Server) peerCount() int {
	s.peersMu.Lock()
	defer s.peersMu.Unlock()
	return len(s.peers)
}
