package dshweb

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestLiveRegistryRevoke(t *testing.T) {
	t.Parallel()
	clock := newFakeClock(time.Now())
	var generation uint64 = 7
	reg := newLiveRegistry(clock, func() uint64 { return generation })
	expiry := clock.Now().Add(time.Hour)

	w1, ok := reg.Register(Lease{Generation: 7, ExpiresAt: expiry})
	if !ok {
		t.Fatal("current-generation lease must register")
	}
	if _, ok := reg.Register(Lease{Generation: 6, ExpiresAt: expiry}); ok {
		t.Fatal("older-generation lease must fail")
	}
	if _, ok := reg.Register(Lease{Generation: 7, ExpiresAt: clock.Now().Add(-time.Second)}); ok {
		t.Fatal("expired lease must fail")
	}
	_, cancel := context.WithCancel(context.Background())
	cancelled := false
	if !reg.SetCancel(w1, func() { cancelled = true; cancel() }) {
		t.Fatal("SetCancel on live work must succeed")
	}
	generation = 8
	reg.RevokeStale()
	if !cancelled {
		t.Fatal("revocation must cancel old-generation work")
	}
	if _, ok := reg.Register(Lease{Generation: 7, ExpiresAt: expiry}); ok {
		t.Fatal("superseded generation must fail after bump")
	}
	w2, ok := reg.Register(Lease{Generation: 8, ExpiresAt: expiry})
	if !ok {
		t.Fatal("new generation must register")
	}
	reg.Unregister(w2)
	if !reg.Stale(w2) {
		t.Error("unregistered work must read stale")
	}
}

func TestLiveRegistryExpiry(t *testing.T) {
	t.Parallel()
	clock := newFakeClock(time.Now())
	reg := newLiveRegistry(clock, func() uint64 { return 1 })
	expiry := clock.Now().Add(time.Minute)
	w, ok := reg.Register(Lease{Generation: 1, ExpiresAt: expiry})
	if !ok {
		t.Fatal("lease must register")
	}
	fired := make(chan struct{})
	reg.SetCancel(w, func() { close(fired) })
	clock.Advance(2 * time.Minute)
	select {
	case <-fired:
	default:
		t.Fatal("expiry timer must close the work")
	}
	if !reg.Stale(w) {
		t.Error("expired work must read stale")
	}
}

func TestLiveRegistryTwoClients(t *testing.T) {
	t.Parallel()
	clock := newFakeClock(time.Now())
	reg := newLiveRegistry(clock, func() uint64 { return 1 })
	expiry := clock.Now().Add(time.Hour)
	a, ok := reg.Register(Lease{Generation: 1, ExpiresAt: expiry})
	if !ok {
		t.Fatal("first client must register")
	}
	b, ok := reg.Register(Lease{Generation: 1, ExpiresAt: expiry})
	if !ok {
		t.Fatal("second client must register")
	}
	var aFired, bFired bool
	reg.SetCancel(a, func() { aFired = true })
	reg.SetCancel(b, func() { bFired = true })
	reg.Unregister(a)
	if reg.Stale(b) {
		t.Error("closing one client must preserve the other")
	}
	reg.CloseAll()
	if _, ok := reg.Register(Lease{Generation: 1, ExpiresAt: expiry}); ok {
		t.Error("shutdown registry admitted new work")
	}
	if !bFired {
		t.Error("CloseAll must still close the surviving client")
	}
	if aFired {
		t.Error("finished work must not fire on CloseAll")
	}
}

// hijackRecorder is a minimal hijackable writer for WatchHijack tests.
type hijackRecorder struct {
	header http.Header
	conn   net.Conn
}

func (h *hijackRecorder) Header() http.Header         { return h.header }
func (h *hijackRecorder) Write(b []byte) (int, error) { return len(b), nil }
func (h *hijackRecorder) WriteHeader(int)             {}
func (h *hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return h.conn, bufio.NewReadWriter(bufio.NewReader(h.conn), bufio.NewWriter(h.conn)), nil
}

func TestWatchHijackRevokeClosesConn(t *testing.T) {
	t.Parallel()
	clock := newFakeClock(time.Now())
	var generation uint64 = 1
	reg := newLiveRegistry(clock, func() uint64 { return generation })
	w, ok := reg.Register(Lease{Generation: 1, ExpiresAt: clock.Now().Add(time.Hour)})
	if !ok {
		t.Fatal("lease must register")
	}
	upstream, client := net.Pipe()
	defer func() { _ = client.Close() }()
	wrapped := reg.WatchHijack(&hijackRecorder{header: http.Header{}, conn: upstream}, w)
	hj, ok := wrapped.(http.Hijacker)
	if !ok {
		t.Fatal("wrapped writer must stay hijackable")
	}
	if _, _, err := hj.Hijack(); err != nil {
		t.Fatalf("hijack: %v", err)
	}
	// A generation bump after upgrade closes the live connection.
	generation = 2
	reg.RevokeStale()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := client.Read(make([]byte, 1)); err == nil {
		t.Error("revocation must close the hijacked connection")
	}
}

func TestLiveRegistryConnClose(t *testing.T) {
	t.Parallel()
	clock := newFakeClock(time.Now())
	reg := newLiveRegistry(clock, func() uint64 { return 1 })
	w, ok := reg.Register(Lease{Generation: 1, ExpiresAt: clock.Now().Add(time.Hour)})
	if !ok {
		t.Fatal("lease must register")
	}
	a, b := net.Pipe()
	defer func() { _ = b.Close() }()
	if !reg.SetConn(w, a) {
		t.Fatal("SetConn on live work must succeed")
	}
	reg.CloseAll()
	_ = b.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := b.Read(make([]byte, 1)); err == nil {
		t.Error("CloseAll must close the tracked connection")
	}
}
