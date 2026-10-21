package pibridge

import (
	"strings"
	"testing"
)

func TestRegisterPendingUnique(t *testing.T) {
	r := newRegistry()
	a, err := r.registerPending("pane-a")
	if err != nil {
		t.Fatalf("register a: %v", err)
	}
	b, err := r.registerPending("pane-b")
	if err != nil {
		t.Fatalf("register b: %v", err)
	}
	if a.processID == b.processID {
		t.Fatal("process nonces collided")
	}
	if a.token == b.token {
		t.Fatal("tokens collided")
	}
}

func TestRegisterPendingDuplicatePane(t *testing.T) {
	r := newRegistry()
	if _, err := r.registerPending("pane"); err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := r.registerPending("pane"); err == nil {
		t.Fatal("duplicate pane accepted")
	}
}

func TestCompleteAndRevoke(t *testing.T) {
	r := newRegistry()
	l, err := r.registerPending("pane")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	r.complete(l.processID)
	l.mu.Lock()
	st := l.state
	l.mu.Unlock()
	if st != leaseLive {
		t.Fatalf("state %d, want live", st)
	}
	if _, ok := r.lookupByProcess(l.processID); !ok {
		t.Fatal("live lease not found")
	}
	r.revoke(l.processID)
	if _, ok := r.lookupByProcess(l.processID); ok {
		t.Fatal("revoked lease still visible")
	}
	if _, ok := r.lookupByPane("pane"); ok {
		t.Fatal("revoked pane still visible")
	}
	// Idempotent.
	r.revoke(l.processID)
	// Pane reusable after revoke.
	if _, err := r.registerPending("pane"); err != nil {
		t.Fatalf("pane reuse after revoke: %v", err)
	}
}

func TestAuthenticateToken(t *testing.T) {
	r := newRegistry()
	l, err := r.registerPending("pane")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	hexTok := ""
	for _, b := range l.token {
		hexTok += string("0123456789abcdef"[b>>4]) + string("0123456789abcdef"[b&15])
	}
	if !l.authenticateToken(hexTok) {
		t.Fatal("valid token rejected")
	}
	if !l.authenticateToken(strings.ToUpper(hexTok)) {
		t.Fatal("uppercase hex rejected")
	}
	if l.authenticateToken(strings.Repeat("0", 64)) {
		t.Fatal("wrong token accepted")
	}
	if l.authenticateToken("short") {
		t.Fatal("malformed token accepted")
	}
	if l.authenticateToken(strings.Repeat("0", 63) + "g") {
		t.Fatal("non-hex token accepted")
	}
}
