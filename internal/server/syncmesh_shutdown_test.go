package server

import (
	"net"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/syncmesh"
)

// TestGracefulShutdownStopsMesh guards the shutdown ordering: the mesh Serve
// goroutine only reports through the listener error channel once gRPC stops, so
// stopping it after the drain deadlocks the process on SIGTERM. This asserts
// the stop happens inside gracefulShutdown and releases the port.
func TestGracefulShutdownStopsMesh(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	app := testServer
	app.Handler()

	mesh := syncmesh.New()
	app.syncMesh = mesh
	served := make(chan error, 1)
	go func() { served <- mesh.Serve("127.0.0.1:0") }()

	deadline := time.Now().Add(5 * time.Second)
	for mesh.Addr() == "" {
		if time.Now().After(deadline) {
			t.Fatal("mesh listener did not bind within 5s")
		}
		time.Sleep(10 * time.Millisecond)
	}
	addr := mesh.Addr()

	done := make(chan struct{})
	go func() {
		app.gracefulShutdown(nil, 0, 0, 2*time.Second)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("gracefulShutdown did not return; the mesh listener deadlocks shutdown")
	}

	if conn, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
		_ = conn.Close()
		t.Fatalf("mesh listener %s still accepting connections after shutdown", addr)
	}

	// Serve must have returned rather than leaking its goroutine.
	select {
	case <-served:
	case <-time.After(5 * time.Second):
		t.Fatal("mesh Serve did not return after shutdown")
	}
}
