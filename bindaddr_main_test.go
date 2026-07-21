package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/bindaddr"
)

// captureStdout redirects os.Stdout for the duration of fn so we can
// inspect what printWelcomeBanner actually writes. Restored via
// t.Cleanup so a panic in fn doesn't leave stdout pointing at a
// closed file.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = orig })

	done := make(chan string)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		done <- buf.String()
	}()

	fn()
	_ = w.Close()
	return <-done
}

// TestServeAll_TwoListeners — two real 127.0.0.1 listeners, both must
// serve. Each one is bound via net.Listen (no BindWithRetry needed —
// these are ephemeral test ports), and serveAll is launched in a
// goroutine so the test can probe them.
func TestServeAll_TwoListeners(t *testing.T) {
	// serveAll uses http.DefaultServeMux (nil handler). Register a
	// /hi handler there for the test and remove it on cleanup so other
	// tests aren't affected.
	http.HandleFunc("/hi-test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("hello " + r.Host))
	})
	t.Cleanup(func() { http.DefaultServeMux = http.NewServeMux() })

	ln1, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen 1: %v", err)
	}
	ln2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen 2: %v", err)
	}
	listeners := []net.Listener{ln1, ln2}

	// serveAll exits only when all listeners close. Run it async and
	// close the listeners from the test to drive the shutdown.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = serveAll(listeners) // error path is logged inside; ignore
	}()

	for i, ln := range listeners {
		addr := ln.Addr().String()
		client := &http.Client{}
		hostPort := strings.TrimPrefix(addr, "127.0.0.1:")
		// Replace the client transport so the Host header matches the
		// listener's bound port (httptest patterns).
		transport := &http.Transport{
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "tcp", addr)
			},
		}
		req, _ := http.NewRequest("GET", "http://example.invalid/hi-test", nil)
		req.Host = "127.0.0.1:" + hostPort
		resp, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatalf("listener %d (%s): %v", i, addr, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if !bytes.Contains(body, []byte("hello 127.0.0.1:"+hostPort)) {
			t.Errorf("listener %d: unexpected body %q", i, body)
		}
		_ = client
	}

	// Close the listeners; serveAll should exit cleanly. Use a
	// watchdog so a hang in serveAll doesn't lock up the test.
	for _, ln := range listeners {
		_ = ln.Close()
	}
	waitDone(&wg, t, "serveAll did not return after listeners closed")
}

// waitDone waits on wg up to a hard cap. If we exceed it, the test
// fails. Saves writing the same select-default idiom per test.
func waitDone(wg *sync.WaitGroup, t *testing.T, msg string) {
	t.Helper()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal(msg)
	}
}

// TestPrintWelcomeBanner_MultiAddr — three addresses (loopback + one
// LAN + one Tailnet). Every URL must appear in the rendered banner
// with the correct label. Also verifies the loopback line uses
// "local" and the others use the kind label.
func TestPrintWelcomeBanner_MultiAddr(t *testing.T) {
	// activeCWD is package-level; setting it via the test helper path
	// would require deep plumbing. We accept whatever value the test
	// environment has and only assert on the bind summary lines.
	prevActiveCWD := activeCWD
	activeCWD = "/test/cwd"
	t.Cleanup(func() { activeCWD = prevActiveCWD })

	addrs := []bindaddr.Addr{
		{IP: net.IPv4(127, 0, 0, 1), Kind: bindaddr.Loopback},
		{IP: net.IPv4(192, 168, 1, 42), Kind: bindaddr.LAN},
		{IP: net.IPv4(100, 100, 50, 25), Kind: bindaddr.Tailnet},
	}

	out := captureStdout(t, func() {
		printWelcomeBanner(Config{ThemeColor: "purple"}, addrs, 7070)
	})

	// Every URL must appear, in this order.
	wantSubstrings := []string{
		"http://127.0.0.1:7070",
		"local",
		"http://192.168.1.42:7070",
		"LAN:",
		"http://100.100.50.25:7070",
		"Tailnet:",
	}
	for _, want := range wantSubstrings {
		if !strings.Contains(out, want) {
			t.Errorf("banner missing %q\n--- banner ---\n%s", want, out)
		}
	}

	// Sanity: the URLs appear in the expected order (loopback first,
	// then LAN, then Tailnet) so the user can scan top-to-bottom.
	idxLoopback := strings.Index(out, "http://127.0.0.1:7070")
	idxLAN := strings.Index(out, "http://192.168.1.42:7070")
	idxTail := strings.Index(out, "http://100.100.50.25:7070")
	if !(idxLoopback < idxLAN && idxLAN < idxTail) {
		t.Errorf("URL order wrong: loopback=%d lan=%d tail=%d", idxLoopback, idxLAN, idxTail)
	}
}

// TestPrintWelcomeBanner_ExplicitZero — explicit 0.0.0.0 bind must
// surface the "public reachable" warning so the user knows the
// server is exposed on every interface.
func TestPrintWelcomeBanner_ExplicitZero(t *testing.T) {
	prevActiveCWD := activeCWD
	activeCWD = "/test/cwd"
	t.Cleanup(func() { activeCWD = prevActiveCWD })

	out := captureStdout(t, func() {
		printWelcomeBanner(Config{ThemeColor: "purple"},
			[]bindaddr.Addr{{IP: net.IPv4zero, Kind: bindaddr.LAN}}, 7070)
	})

	if !strings.Contains(out, "public reachable") {
		t.Errorf("0.0.0.0 banner missing public-reachable warning:\n%s", out)
	}
	if !strings.Contains(out, "http://localhost:7070") {
		t.Errorf("0.0.0.0 banner missing localhost hint:\n%s", out)
	}
}

// TestPrintWelcomeBanner_LoopbackOnly — fallback when no LAN/Tailnet
// interfaces are detected. Banner should still render and advertise
// the loopback URL.
func TestPrintWelcomeBanner_LoopbackOnly(t *testing.T) {
	prevActiveCWD := activeCWD
	activeCWD = "/test/cwd"
	t.Cleanup(func() { activeCWD = prevActiveCWD })

	out := captureStdout(t, func() {
		printWelcomeBanner(Config{ThemeColor: "purple"},
			[]bindaddr.Addr{{IP: net.IPv4(127, 0, 0, 1), Kind: bindaddr.Loopback}}, 7070)
	})
	if !strings.Contains(out, "http://127.0.0.1:7070") {
		t.Errorf("loopback-only banner missing loopback URL:\n%s", out)
	}
}
