package diagnostics

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"runtime/pprof"
)

func TestParseCPUProfileQuery(t *testing.T) {
	for _, tc := range []struct {
		query string
		want  int
		ok    bool
	}{
		{query: "", want: defaultCPUProfileSeconds, ok: true},
		{query: "seconds=1", want: 1, ok: true},
		{query: "seconds=120", want: 120, ok: true},
		{query: "seconds=0"},
		{query: "seconds=121"},
		{query: "seconds=-1"},
		{query: "seconds=nope"},
		{query: "seconds="},
		{query: "seconds=1&seconds=2"},
		{query: "unknown=1"},
		{query: "seconds=1;unknown=2"},
	} {
		t.Run(tc.query, func(t *testing.T) {
			got, err := parseCPUProfileQuery(tc.query)
			if (err == nil) != tc.ok || (err == nil && got != tc.want) {
				t.Fatalf("parseCPUProfileQuery(%q) = %d, %v; want %d, ok=%t", tc.query, got, err, tc.want, tc.ok)
			}
		})
	}
}

func TestParseHeapProfileQuery(t *testing.T) {
	for _, tc := range []struct {
		query string
		want  bool
		ok    bool
	}{
		{query: "", want: false, ok: true},
		{query: "gc=0", want: false, ok: true},
		{query: "gc=1", want: true, ok: true},
		{query: "gc=2"},
		{query: "gc="},
		{query: "gc=1&gc=0"},
		{query: "unknown=1"},
	} {
		t.Run(tc.query, func(t *testing.T) {
			got, err := parseHeapProfileQuery(tc.query)
			if (err == nil) != tc.ok || (err == nil && got != tc.want) {
				t.Fatalf("parseHeapProfileQuery(%q) = %t, %v; want %t, ok=%t", tc.query, got, err, tc.want, tc.ok)
			}
		})
	}
}

func TestParseEmptyProfileQuery(t *testing.T) {
	if err := parseEmptyProfileQuery(""); err != nil {
		t.Fatalf("empty query: %v", err)
	}
	for _, query := range []string{"?debug=1", "debug=1", "gc=1"} {
		if err := parseEmptyProfileQuery(query); err == nil {
			t.Errorf("query %q was accepted", query)
		}
	}
}

func TestLimitingWriterEnforcesMaximum(t *testing.T) {
	var out bytes.Buffer
	writer := newLimitingWriter(&out, 4)
	if n, err := writer.Write([]byte("1234")); n != 4 || err != nil {
		t.Fatalf("first write = %d, %v", n, err)
	}
	if n, err := writer.Write([]byte("5")); n != 0 || !errors.Is(err, errProfileTooLarge) {
		t.Fatalf("oversize write = %d, %v", n, err)
	}
	if got := out.String(); got != "1234" {
		t.Fatalf("output = %q", got)
	}
	select {
	case <-writer.failed:
	default:
		t.Fatal("size-limit signal was not sent")
	}
	if !errors.Is(writer.Err(), errProfileTooLarge) {
		t.Fatalf("stored error = %v", writer.Err())
	}
}

func TestProfileEndpointsReturnCompressedProfiles(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	client := profileClient(t)

	for _, tc := range []struct {
		path string
		code int
	}{
		{path: "/debug/pprof/heap?gc=1", code: http.StatusOK},
		{path: "/debug/pprof/goroutine", code: http.StatusOK},
		{path: "/debug/pprof/profile?seconds=1", code: http.StatusOK},
	} {
		t.Run(tc.path, func(t *testing.T) {
			resp := authorizedProfileRequest(t, client, s, tc.path)
			defer resp.Body.Close()
			if resp.StatusCode != tc.code {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
			}
			if resp.Header.Get("Content-Type") != "application/octet-stream" {
				t.Fatalf("Content-Type = %q", resp.Header.Get("Content-Type"))
			}
			data, err := io.ReadAll(io.LimitReader(resp.Body, (64<<20)+1))
			if err != nil {
				t.Fatal(err)
			}
			if len(data) == 0 || len(data) > 64<<20 {
				t.Fatalf("profile size = %d", len(data))
			}
			assertGzipProfile(t, data)
		})
	}
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestProfileEndpointsRejectInvalidRequests(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	client := profileClient(t)

	for _, tc := range []struct {
		method string
		path   string
		code   int
	}{
		{method: http.MethodGet, path: "/debug/pprof/profile?seconds=121", code: http.StatusBadRequest},
		{method: http.MethodGet, path: "/debug/pprof/heap?gc=2", code: http.StatusBadRequest},
		{method: http.MethodGet, path: "/debug/pprof/goroutine?debug=1", code: http.StatusBadRequest},
		{method: http.MethodPost, path: "/debug/pprof/heap", code: http.StatusMethodNotAllowed},
	} {
		resp := authorizedProfileMethod(t, client, s, tc.method, tc.path)
		resp.Body.Close()
		if resp.StatusCode != tc.code {
			t.Errorf("%s %s status = %d, want %d", tc.method, tc.path, resp.StatusCode, tc.code)
		}
	}
	resp := profileRequest(t, client, s.URL()+"/debug/pprof/heap")
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthorized heap profile status = %d", resp.StatusCode)
	}
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestProfileSizeLimitPreventsResponseAndCleansFile(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	s.maxProfileSize = 1
	resp := authorizedProfileRequest(t, profileClient(t), s, "/debug/pprof/heap")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestCPUProfileConflictAndClientCancellationAllowRetry(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	var startedOnce sync.Once
	var stoppedOnce sync.Once
	s := startTestServer(t, currentProcessReaders())
	s.onCPUStarted = func() { startedOnce.Do(func() { close(started) }) }
	s.onCPUStopped = func() { stoppedOnce.Do(func() { close(stopped) }) }
	client := profileClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.URL()+"/debug/pprof/profile?seconds=30", nil)
		if err != nil {
			firstDone <- err
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.token)
		resp, err := client.Do(req)
		if resp != nil {
			_ = resp.Body.Close()
		}
		firstDone <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("CPU profile did not start")
	}

	busy := authorizedProfileRequest(t, client, s, "/debug/pprof/heap")
	busy.Body.Close()
	if busy.StatusCode != http.StatusConflict {
		t.Fatalf("overlapping profile status = %d, want 409", busy.StatusCode)
	}
	cancel()
	select {
	case err := <-firstDone:
		if err == nil {
			t.Fatal("canceled profile request returned without error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled CPU profile did not stop")
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("server did not release the canceled CPU profile")
	}

	retry := authorizedProfileRequest(t, client, s, "/debug/pprof/profile?seconds=1")
	defer retry.Body.Close()
	if retry.StatusCode != http.StatusOK {
		t.Fatalf("retry status = %d", retry.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(retry.Body, (64<<20)+1))
	if err != nil {
		t.Fatal(err)
	}
	assertGzipProfile(t, data)
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestCPUProfileConflictWithExternalCPUProfiler(t *testing.T) {
	var out bytes.Buffer
	if err := pprof.StartCPUProfile(&out); err != nil {
		t.Fatalf("start external profiler: %v", err)
	}
	defer pprof.StopCPUProfile()

	s := startTestServer(t, currentProcessReaders())
	resp := authorizedProfileRequest(t, profileClient(t), s, "/debug/pprof/profile?seconds=1")
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp.StatusCode)
	}
	var probe bytes.Buffer
	if err := pprof.StartCPUProfile(&probe); err == nil {
		pprof.StopCPUProfile()
		t.Fatal("HTTP request stopped the external CPU profiler")
	}
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestServerCloseCancelsCPUProfileAndRemovesOwnedDirectory(t *testing.T) {
	started := make(chan struct{})
	var startedOnce sync.Once
	s := startTestServer(t, currentProcessReaders())
	s.onCPUStarted = func() { startedOnce.Do(func() { close(started) }) }
	client := profileClient(t)
	result := make(chan *http.Response, 1)
	go func() {
		req, err := http.NewRequest(http.MethodGet, s.URL()+"/debug/pprof/profile?seconds=30", nil)
		if err != nil {
			result <- nil
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.token)
		resp, err := client.Do(req)
		if err == nil {
			result <- resp
			return
		}
		result <- nil
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("CPU profile did not start")
	}
	dir := s.Dir()
	if err := s.Close(); err != nil {
		t.Fatalf("close diagnostics server: %v", err)
	}
	select {
	case resp := <-result:
		if resp != nil {
			resp.Body.Close()
		}
	case <-time.After(5 * time.Second):
		t.Fatal("profile request did not finish after server close")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("owned directory still exists: %v", err)
	}
}

func TestDeliverProfileUsesBoundedDeadlineAndReleasesCPUProfiler(t *testing.T) {
	s := &Server{profileDeliveryWindow: 50 * time.Millisecond}
	path := filepath.Join(t.TempDir(), "profile")
	if err := os.WriteFile(path, []byte("profile bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	writer := &blockingResponseWriter{started: make(chan struct{})}
	finished := make(chan error, 1)
	go func() { finished <- s.deliverProfile(writer, file) }()
	select {
	case <-writer.started:
	case <-time.After(time.Second):
		t.Fatal("profile response did not attempt a write")
	}
	if time.Until(writer.deadline) > 50*time.Millisecond || time.Until(writer.deadline) <= 0 {
		t.Fatalf("write deadline = %v", writer.deadline)
	}
	select {
	case err := <-finished:
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("blocked delivery error = %v, want deadline exceeded", err)
		}
	case <-time.After(time.Second):
		t.Fatal("slow profile delivery exceeded its test deadline")
	}

	var out bytes.Buffer
	if err := pprof.StartCPUProfile(&out); err != nil {
		t.Fatalf("CPU profiler remained active during file delivery: %v", err)
	}
	pprof.StopCPUProfile()
}

type blockingResponseWriter struct {
	header   http.Header
	started  chan struct{}
	deadline time.Time
}

func (w *blockingResponseWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}
func (w *blockingResponseWriter) WriteHeader(int) {}
func (w *blockingResponseWriter) Write(data []byte) (int, error) {
	close(w.started)
	timer := time.NewTimer(time.Until(w.deadline))
	defer timer.Stop()
	<-timer.C
	return 0, os.ErrDeadlineExceeded
}
func (w *blockingResponseWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func profileClient(t *testing.T) *http.Client {
	t.Helper()
	return &http.Client{Timeout: 15 * time.Second}
}

func profileRequest(t *testing.T, client *http.Client, url string) *http.Response {
	t.Helper()
	resp, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

func authorizedProfileRequest(t *testing.T, client *http.Client, s *Server, path string) *http.Response {
	return authorizedProfileMethod(t, client, s, http.MethodGet, path)
}

func authorizedProfileMethod(t *testing.T, client *http.Client, s *Server, method, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, s.URL()+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

func assertGzipProfile(t *testing.T, data []byte) {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("profile is not a gzip-compressed pprof payload: %v", err)
	}
	defer reader.Close()
	if _, err := io.Copy(io.Discard, reader); err != nil {
		t.Fatalf("decode profile: %v", err)
	}
}

func assertNoTemporaryProfiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), profileFilePrefix) {
			t.Errorf("temporary profile remains: %s", entry.Name())
		}
	}
}
