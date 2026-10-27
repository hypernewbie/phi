package ws

import (
	"context"
	"sync"
)

// AuthFence is the access-authentication snapshot attached to one request by
// the auth middleware. Generation is read under the same lock as the
// authorization decision, so a socket cannot attach at a generation that a
// concurrent password change already retired.
type AuthFence struct {
	Generation uint64
}

type authFenceContextKey struct{}

// WithAuthFence attaches the snapshot to a request context.
func WithAuthFence(ctx context.Context, fence AuthFence) context.Context {
	return context.WithValue(ctx, authFenceContextKey{}, fence)
}

// AuthFenceFrom reports the snapshot attached by the auth middleware.
func AuthFenceFrom(ctx context.Context) (AuthFence, bool) {
	fence, ok := ctx.Value(authFenceContextKey{}).(AuthFence)
	return fence, ok
}

// AuthSocket is the minimal connection handle the fence closes.
// *websocket.Conn satisfies it.
type AuthSocket interface {
	Close() error
}

// authFencer tracks which client-facing sockets were admitted at which access
// generation. The auth layer owns the generation; this type owns connection
// identity and closure.
type authFencer struct {
	mu      sync.Mutex
	current uint64
	sockets map[AuthSocket]uint64
}

// admit records conn at the fence's generation. It returns false when the
// fence is stale: a record change landed between authentication and the
// upgrade, so the socket must not be attached.
func (f *authFencer) admit(conn AuthSocket, fence AuthFence) bool {
	if conn == nil {
		return true
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if fence.Generation != f.current {
		return false
	}
	if f.sockets == nil {
		f.sockets = make(map[AuthSocket]uint64)
	}
	f.sockets[conn] = fence.Generation
	return true
}

// rotate advances the current generation and closes every socket admitted at
// an older one. It returns the number of sockets closed.
func (f *authFencer) rotate(generation uint64) int {
	f.mu.Lock()
	if generation > f.current {
		f.current = generation
	}
	var stale []AuthSocket
	for conn, admitted := range f.sockets {
		if admitted < f.current {
			stale = append(stale, conn)
			delete(f.sockets, conn)
		}
	}
	f.mu.Unlock()
	for _, conn := range stale {
		_ = conn.Close()
	}
	return len(stale)
}

// forget drops a closed socket from the fence.
func (f *authFencer) forget(conn AuthSocket) {
	if conn == nil {
		return
	}
	f.mu.Lock()
	delete(f.sockets, conn)
	f.mu.Unlock()
}

// AdmitAuth records a client-facing socket at the request's auth generation.
// It returns false when that generation is stale; the caller must close the
// connection instead of serving it.
func (h *Hub) AdmitAuth(conn AuthSocket, fence AuthFence) bool {
	return h.auth.admit(conn, fence)
}

// RotateAuth advances the access generation and closes every socket admitted
// at an older one. Sockets that never carried a fence (bridge and sync-board
// paths) are not tracked and stay open.
func (h *Hub) RotateAuth(generation uint64) int {
	return h.auth.rotate(generation)
}

// ForgetAuth drops a closed client-facing socket from the fence.
func (h *Hub) ForgetAuth(conn AuthSocket) {
	h.auth.forget(conn)
}
