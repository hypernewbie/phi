package pibridge

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"google.golang.org/grpc/codes"
)

// tokenBytes is the per-process credential size.
const tokenBytes = 32

// randomHex returns n cryptographically random bytes, hex-encoded.
func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("pibridge: rand: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// lease is the registered process identity for one provisioned Pi process.
// A lease exists before spawn (pending), becomes live after spawn, and is
// revoked on failure, death, replacement, or shutdown.
//
// mu guards every mutable field. Registry.mu guards only the lookup maps.
// Acquire registry.mu before lease.mu, never the reverse.
type lease struct {
	paneID    string
	processID string
	token     [tokenBytes]byte

	// Serializes state/up and down notifications, including same-generation
	// reconnects. Acquire before mu; no lease lock is held in callbacks.
	notifyMu  sync.Mutex
	mu        sync.Mutex
	state     leaseState
	pubRev    uint64   // latest publication revision (server-owned ordering)
	maxGen    uint64   // highest accepted runtime generation
	runtimeID string   // identity bound at maxGen
	sessionID string   // identity bound at maxGen
	caps      []string // accepted capabilities at maxGen, retained

	jrn       journal
	lastState *pibridgepb.StateSnapshot
	peer      *peer // current active stream, replaced atomically
}

type leaseState int

const (
	leasePending leaseState = iota
	leaseLive
	leaseRevoked
)

// registry owns all leases, keyed by process identity and pane.
type registry struct {
	mu        sync.Mutex
	byProcess map[string]*lease
	byPane    map[string]*lease
}

func newRegistry() *registry {
	return &registry{
		byProcess: map[string]*lease{},
		byPane:    map[string]*lease{},
	}
}

// registerPending creates a lease with a random process nonce and token
// before spawn. Pane identity must not already hold a live or pending lease.
func (r *registry) registerPending(paneID string) (*lease, error) {
	process, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	var token [tokenBytes]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, fmt.Errorf("pibridge: token: %w", err)
	}
	r.mu.Lock()
	if old, ok := r.byPane[paneID]; ok {
		old.mu.Lock()
		revoked := old.state == leaseRevoked
		old.mu.Unlock()
		if !revoked {
			r.mu.Unlock()
			return nil, fmt.Errorf("pibridge: pane %q already has an active lease", paneID)
		}
	}
	l := &lease{
		paneID:    paneID,
		processID: process,
		token:     token,
		state:     leasePending,
	}
	r.byProcess[process] = l
	r.byPane[paneID] = l
	r.mu.Unlock()
	return l, nil
}

// complete marks a pending lease live after a successful spawn.
func (r *registry) complete(processID string) {
	r.mu.Lock()
	l, ok := r.byProcess[processID]
	r.mu.Unlock()
	if !ok {
		return
	}
	l.mu.Lock()
	if l.state == leasePending {
		l.state = leaseLive
	}
	l.mu.Unlock()
}

// revoke removes a lease and closes its active peer. Idempotent.
func (r *registry) revoke(processID string) {
	r.mu.Lock()
	l, ok := r.byProcess[processID]
	if !ok {
		r.mu.Unlock()
		return
	}
	delete(r.byProcess, processID)
	if cur, paneOK := r.byPane[l.paneID]; paneOK && cur == l {
		delete(r.byPane, l.paneID)
	}
	r.mu.Unlock()

	l.mu.Lock()
	l.state = leaseRevoked
	peer := l.peer
	l.peer = nil
	l.mu.Unlock()

	if peer != nil {
		peer.closeWith(codes.Canceled, "lease revoked")
	}
}

// lookupByProcess returns the lease for a process identity.
func (r *registry) lookupByProcess(processID string) (*lease, bool) {
	r.mu.Lock()
	l, ok := r.byProcess[processID]
	r.mu.Unlock()
	if !ok {
		return nil, false
	}
	l.mu.Lock()
	revoked := l.state == leaseRevoked
	l.mu.Unlock()
	return l, !revoked
}

// lookupByPane returns the lease for a pane identity.
func (r *registry) lookupByPane(paneID string) (*lease, bool) {
	r.mu.Lock()
	l, ok := r.byPane[paneID]
	r.mu.Unlock()
	if !ok {
		return nil, false
	}
	l.mu.Lock()
	revoked := l.state == leaseRevoked
	l.mu.Unlock()
	return l, !revoked
}

// authenticateToken compares a hex token against the lease credential in
// constant time. It returns false for malformed input.
func (l *lease) authenticateToken(hexToken string) bool {
	raw, err := hex.DecodeString(strings.ToLower(hexToken))
	if err != nil || len(raw) != tokenBytes {
		return false
	}
	var provided [tokenBytes]byte
	copy(provided[:], raw)
	return subtle.ConstantTimeCompare(provided[:], l.token[:]) == 1
}
