package ws

import (
	"context"
	"sync"
	"time"
)

// AuthFence is the access-authentication snapshot attached to one request by
// the auth middleware. Every field is read under the same lock as the
// authorization decision, so a socket cannot attach at a generation, family, or
// expiry that a concurrent revocation already retired.
type AuthFence struct {
	Generation uint64
	// FamilyID is the v2 family that authorized the upgrade. It stays empty for
	// v1, disabled, and bridge admissions, which have no family deadline.
	FamilyID string
	// ExpiresAt is the admitted access token's exp. A socket closes exactly
	// there: unlike HTTP, no clock allowance applies.
	ExpiresAt time.Time
	// Deadline is the earliest close deadline known at admission: the admitted
	// exp or the family's idle/absolute deadline, whichever comes first. Zero
	// means the admission has no scheduled close.
	Deadline time.Time
}

// AuthFenceValidator re-checks a fence against live auth state. Registration
// runs it after recording the socket, which closes the window where a
// revocation lands between the middleware decision and the upgrade.
type AuthFenceValidator func(AuthFence) bool

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

// authAdmission is one registered socket. seq identifies the registration so a
// timer armed for a closed socket can never close a later one.
type authAdmission struct {
	generation uint64
	familyID   string
	deadline   time.Time
	seq        uint64
	timer      *time.Timer
}

// authFencer tracks which client-facing sockets were admitted at which access
// generation. The auth layer owns the generation and the family state; this
// type owns connection identity, scheduled closure, and revocation closure.
type authFencer struct {
	mu       sync.Mutex
	current  uint64
	seq      uint64
	validate AuthFenceValidator
	sockets  map[AuthSocket]authAdmission
}

// SetAuthValidator installs the fence validator. It must read auth state
// without taking this lock: revocations hold the auth lock while closing
// sockets, so nesting the two locks the other way would deadlock.
func (f *authFencer) setValidator(validate AuthFenceValidator) {
	f.mu.Lock()
	f.validate = validate
	f.mu.Unlock()
}

// admit records conn for the fence and arms its close timer. It returns false
// when the admission is stale or no longer authorized: the caller must close the
// connection instead of serving it.
func (f *authFencer) admit(conn AuthSocket, fence AuthFence) bool {
	if conn == nil {
		return true
	}
	f.mu.Lock()
	if fence.Generation != f.current {
		f.mu.Unlock()
		return false
	}
	if !fence.Deadline.IsZero() && !fence.Deadline.After(time.Now()) {
		f.mu.Unlock()
		return false
	}
	validate := f.validate
	f.seq++
	admission := authAdmission{
		generation: fence.Generation,
		familyID:   fence.FamilyID,
		deadline:   fence.Deadline,
		seq:        f.seq,
	}
	if f.sockets == nil {
		f.sockets = make(map[AuthSocket]authAdmission)
	}
	f.sockets[conn] = admission
	f.mu.Unlock()

	if validate != nil && !validate(fence) {
		// A revocation landed before this registration was visible: the
		// revocation scan already ran, so nothing else would close it.
		f.drop(conn, admission.seq)
		f.closeSocket(conn)
		return false
	}
	f.arm(conn, admission)
	return true
}

// arm schedules closure at the admission deadline. A refreshed token never
// extends an existing admission: the deadline is fixed at registration.
func (f *authFencer) arm(conn AuthSocket, admission authAdmission) {
	if admission.deadline.IsZero() {
		return
	}
	delay := time.Until(admission.deadline)
	if delay < 0 {
		delay = 0
	}
	timer := time.AfterFunc(delay, func() { f.expire(conn, admission.seq) })
	f.mu.Lock()
	current, ok := f.sockets[conn]
	if ok && current.seq == admission.seq {
		current.timer = timer
		f.sockets[conn] = current
		f.mu.Unlock()
		return
	}
	f.mu.Unlock()
	timer.Stop()
}

// expire closes the registration identified by seq. A timer whose registration
// is gone, or was replaced by a newer admission on the same connection, does
// nothing.
func (f *authFencer) expire(conn AuthSocket, seq uint64) {
	if !f.drop(conn, seq) {
		return
	}
	f.closeSocket(conn)
}

// drop removes a registration and stops its timer. It reports whether the
// registration identified by seq was still current.
func (f *authFencer) drop(conn AuthSocket, seq uint64) bool {
	f.mu.Lock()
	admission, ok := f.sockets[conn]
	if !ok || admission.seq != seq {
		f.mu.Unlock()
		return false
	}
	delete(f.sockets, conn)
	if admission.timer != nil {
		admission.timer.Stop()
	}
	f.mu.Unlock()
	return true
}

// closeSocket closes one connection outside the fence lock: Close can block on
// a write, and holding the lock through it would stall every other socket.
func (f *authFencer) closeSocket(conn AuthSocket) {
	_ = conn.Close()
}

// retire closes every registration matching drop and returns how many it closed.
func (f *authFencer) retire(drop func(authAdmission) bool) int {
	f.mu.Lock()
	var stale []AuthSocket
	for conn, admission := range f.sockets {
		if !drop(admission) {
			continue
		}
		delete(f.sockets, conn)
		if admission.timer != nil {
			admission.timer.Stop()
		}
		stale = append(stale, conn)
	}
	f.mu.Unlock()
	for _, conn := range stale {
		f.closeSocket(conn)
	}
	return len(stale)
}

// rotate advances the current generation and closes every socket admitted at an
// older one. It returns the number of sockets closed.
func (f *authFencer) rotate(generation uint64) int {
	f.mu.Lock()
	if generation > f.current {
		f.current = generation
	}
	current := f.current
	f.mu.Unlock()
	return f.retire(func(admission authAdmission) bool {
		return admission.generation < current
	})
}

// forget drops a closed socket from the fence.
func (f *authFencer) forget(conn AuthSocket) {
	if conn == nil {
		return
	}
	f.mu.Lock()
	admission, ok := f.sockets[conn]
	if ok {
		delete(f.sockets, conn)
		if admission.timer != nil {
			admission.timer.Stop()
		}
	}
	f.mu.Unlock()
}

// AdmitAuth records a client-facing socket at the request's auth generation and
// arms its close deadline. It returns false when the admission is stale or
// already revoked; the caller must close the connection instead of serving it.
func (h *Hub) AdmitAuth(conn AuthSocket, fence AuthFence) bool {
	return h.auth.admit(conn, fence)
}

// SetAuthValidator installs the function that re-checks a fence against live
// auth state at registration time.
func (h *Hub) SetAuthValidator(validate AuthFenceValidator) {
	h.auth.setValidator(validate)
}

// RotateAuth advances the access generation and closes every socket admitted
// at an older one. Sockets that never carried a fence (bridge and sync-board
// paths) are not tracked and stay open.
func (h *Hub) RotateAuth(generation uint64) int {
	return h.auth.rotate(generation)
}

// RetireAuthFamily closes the sockets admitted by one v2 family. A v1 or
// disabled admission carries no family and is unaffected.
func (h *Hub) RetireAuthFamily(familyID string) int {
	if familyID == "" {
		return 0
	}
	return h.auth.retire(func(admission authAdmission) bool {
		return admission.familyID == familyID
	})
}

// RetireAuthV2 closes every socket admitted by a v2 family, leaving v1 and
// disabled admissions open.
func (h *Hub) RetireAuthV2() int {
	return h.auth.retire(func(admission authAdmission) bool {
		return admission.familyID != ""
	})
}

// ForgetAuth drops a closed client-facing socket from the fence.
func (h *Hub) ForgetAuth(conn AuthSocket) {
	h.auth.forget(conn)
}
