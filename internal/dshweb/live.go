package dshweb

import (
	"context"
	"net"
	"net/http"
	"sync"
	"time"
)

// Lease is one verified Phi-auth snapshot for DSH work: the auth
// generation that admitted it and its session expiry. It carries no
// credential.
type Lease struct {
	Generation uint64
	ExpiresAt  time.Time
}

// Admit verifies Phi auth for one DSH request using the existing
// token-validation logic. It returns the verified lease, not the cookie.
type Admit func(r *http.Request) (Lease, bool)

// CurrentGeneration reads the live auth generation for staleness checks.
type CurrentGeneration func() uint64

// liveWork is one admitted DSH request or upgraded connection.
// LiveWork is an opaque handle for one admitted carrier request.
type LiveWork = liveWork

type liveWork struct {
	lease  Lease
	cancel context.CancelFunc
	conn   net.Conn
	timer  Timer
}

// liveRegistry tracks admitted DSH work so password enable/change/clear,
// session expiry, and service stop can close it. Registration verifies
// the lease against the current generation after insertion, so work
// admitted just before a revocation still fails closed without sharing
// the auth lock.
type liveRegistry struct {
	mu      sync.Mutex
	clock   Clock
	current CurrentGeneration
	works   map[*liveWork]struct{}
	closed  bool
}

func newLiveRegistry(clock Clock, current CurrentGeneration) *liveRegistry {
	return &liveRegistry{clock: clock, current: current, works: make(map[*liveWork]struct{})}
}

// Register admits one lease. It returns false when the lease is already
// stale; the caller must then fail the request without contacting upstream.
func (reg *liveRegistry) Register(lease Lease) (*liveWork, bool) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if reg.closed || reg.current == nil {
		return nil, false
	}
	if lease.Generation != reg.current() {
		return nil, false
	}
	now := reg.clock.Now()
	if !lease.ExpiresAt.After(now) {
		return nil, false
	}
	w := &liveWork{lease: lease}
	reg.works[w] = struct{}{}
	w.timer = reg.clock.AfterFunc(lease.ExpiresAt.Sub(now), func() {
		reg.closeWork(w)
	})
	return w, true
}

// SetCancel attaches the upstream-leg cancel. It returns false when the
// work was already revoked; the caller must then abandon the request.
func (reg *liveRegistry) SetCancel(w *liveWork, cancel context.CancelFunc) bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if _, ok := reg.works[w]; !ok || reg.staleLocked(w) {
		return false
	}
	w.cancel = cancel
	return true
}

// SetConn attaches a hijacked connection. It returns false when the work
// is gone or stale; the caller must then close the connection at once.
func (reg *liveRegistry) SetConn(w *liveWork, conn net.Conn) bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if _, ok := reg.works[w]; !ok || reg.staleLocked(w) {
		return false
	}
	w.conn = conn
	return true
}

// Stale reports whether the work's lease no longer matches the current
// generation or has expired.
func (reg *liveRegistry) Stale(w *liveWork) bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if _, ok := reg.works[w]; !ok {
		return true
	}
	return reg.staleLocked(w)
}

// Unregister removes normally finished work. It stops the expiry timer;
// the finished exchange already owns its connection lifecycle.
func (reg *liveRegistry) Unregister(w *liveWork) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if _, ok := reg.works[w]; !ok {
		return
	}
	delete(reg.works, w)
	if w.timer != nil {
		w.timer.Stop()
	}
}

// RevokeStale closes work admitted under an older generation or past expiry.
func (reg *liveRegistry) RevokeStale() {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for w := range reg.works {
		if reg.staleLocked(w) {
			reg.closeLocked(w)
		}
	}
}

// CloseAll closes every tracked request and connection.
func (reg *liveRegistry) CloseAll() {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.closed = true
	for w := range reg.works {
		reg.closeLocked(w)
	}
}

func (reg *liveRegistry) staleLocked(w *liveWork) bool {
	return w.lease.Generation != reg.current() || !w.lease.ExpiresAt.After(reg.clock.Now())
}

func (reg *liveRegistry) closeWork(w *liveWork) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.closeLocked(w)
}

func (reg *liveRegistry) closeLocked(w *liveWork) {
	if _, ok := reg.works[w]; !ok {
		return
	}
	delete(reg.works, w)
	if w.timer != nil {
		w.timer.Stop()
	}
	if w.cancel != nil {
		w.cancel()
	}
	if w.conn != nil {
		_ = w.conn.Close()
	}
}
