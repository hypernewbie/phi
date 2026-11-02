package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/server"
)

// TestGracefulShutdown_DrainsInFlightRequest — gracefulShutdown no longer
// calls os.Exit, so it's directly testable: /readyz must flip to 503 while
// the drain is in progress, a slow in-flight request must still complete
// with 200, and srv.Serve must return http.ErrServerClosed. server.PTY and
// server.Hub are nil'd out for the duration so this stays a pure HTTP-drain test
// — PTY shutdown has its own coverage in pkg/pty/manager_test.go.
func TestGracefulShutdown_DrainsInFlightRequest(t *testing.T) {
	server.ShuttingDown.Store(false)
	t.Cleanup(func() { server.ShuttingDown.Store(false) })

	origPtyManager, origWsHub := server.PTY, server.Hub
	server.PTY, server.Hub = nil, nil
	t.Cleanup(func() { server.PTY, server.Hub = origPtyManager, origWsHub })

	origSyncPath := testSyncPath
	testSyncPath = filepath.Join(t.TempDir(), "syncboard-test.json")
	t.Cleanup(func() { testSyncPath = origSyncPath })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	})
	srv := &http.Server{Handler: mux}

	serveErrCh := make(chan error, 1)
	go func() { serveErrCh <- srv.Serve(ln) }()

	reqDone := make(chan int, 1)
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/slow")
		if err != nil {
			reqDone <- -1
			return
		}
		defer resp.Body.Close()
		reqDone <- resp.StatusCode
	}()

	// Give the in-flight request a moment to actually reach the handler
	// before shutdown starts, so Shutdown(ctx) has something to drain.
	time.Sleep(50 * time.Millisecond)

	shutdownDone := make(chan struct{})
	go func() {
		gracefulShutdown([]*http.Server{srv}, 0, 0, 5*time.Second)
		close(shutdownDone)
	}()

	// Shortly after shutdown starts, /readyz must already be 503 — it
	// flips synchronously, well before the drain finishes.
	time.Sleep(20 * time.Millisecond)
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	w := httptest.NewRecorder()
	server.HandleReadyz(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("/readyz during drain: got %d want 503", w.Code)
	}

	select {
	case code := <-reqDone:
		if code != http.StatusOK {
			t.Errorf("in-flight request: got status %d want 200", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight request did not complete")
	}

	select {
	case err := <-serveErrCh:
		if err != http.ErrServerClosed {
			t.Errorf("srv.Serve returned %v, want http.ErrServerClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("srv.Serve did not return")
	}

	<-shutdownDone
}
