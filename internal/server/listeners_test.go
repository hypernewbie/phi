package server

import (
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

// Both listeners use the same application, not the process default mux.
func TestServeAll_TwoListeners(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	app := testServer
	app.Handler()
	app.mux.HandleFunc("/hi-test", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "hello "+r.Host)
	})
	var listeners []net.Listener
	for i := 0; i < 2; i++ {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ln.Close() })
		listeners = append(listeners, ln)
	}
	servers, errCh := app.serveAll(listeners)
	t.Cleanup(func() {
		for _, srv := range servers {
			_ = srv.Close()
		}
	})
	client := &http.Client{Timeout: 2 * time.Second}
	for _, ln := range listeners {
		addr := ln.Addr().String()
		response, err := client.Get("http://" + addr + "/hi-test")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK || string(body) != "hello "+addr {
			t.Fatalf("listener %s: %d %q, err=%v", addr, response.StatusCode, body, err)
		}
	}
	for _, srv := range servers {
		_ = srv.Close()
	}
	for range servers {
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("listener did not stop")
		}
	}
}
