package diagnostics

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStartUsesPrivateLoopbackFilesAndAuth(t *testing.T) {
	var calls atomic.Int32
	s := startTestServer(t, snapshotReaders{
		rss: func(context.Context) (uint64, error) { calls.Add(1); return 4096, nil },
		cpu: func(context.Context) (float64, error) { calls.Add(1); return 0.5, nil },
	})

	u, err := net.ResolveTCPAddr("tcp", strings.TrimPrefix(s.URL(), "http://"))
	if err != nil {
		t.Fatal(err)
	}
	if !u.IP.Equal(net.ParseIP("127.0.0.1")) || u.Port == 0 {
		t.Fatalf("diagnostics listener = %v, want IPv4 loopback with allocated port", u)
	}
	for _, item := range []struct {
		path string
		mode os.FileMode
	}{{s.Dir(), 0700}, {filepath.Join(s.Dir(), "url"), 0600}, {filepath.Join(s.Dir(), "client.curl"), 0600}} {
		info, err := os.Stat(item.path)
		if err != nil {
			t.Fatalf("stat %s: %v", item.path, err)
		}
		if got := info.Mode().Perm(); got != item.mode {
			t.Errorf("mode %s = %o, want %o", item.path, got, item.mode)
		}
	}
	urlFile, err := os.ReadFile(filepath.Join(s.Dir(), "url"))
	if err != nil || string(urlFile) != s.URL()+"\n" {
		t.Fatalf("url file = %q, err=%v", urlFile, err)
	}
	curlFile, err := os.ReadFile(filepath.Join(s.Dir(), "client.curl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(curlFile), "Authorization: Bearer "+s.token) || !strings.Contains(string(curlFile), `noproxy = "*"`) {
		t.Fatalf("curl config is incomplete")
	}

	resp := request(s, http.MethodGet, "/debug/phi", "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing token status = %d", resp.StatusCode)
	}
	if calls.Load() != 0 {
		t.Fatalf("metrics called before authentication: %d", calls.Load())
	}
	resp.Body.Close()

	resp = request(s, http.MethodGet, "/debug/phi", "Bearer incorrect")
	if resp.StatusCode != http.StatusUnauthorized || calls.Load() != 0 {
		t.Fatalf("bad token status=%d metrics calls=%d", resp.StatusCode, calls.Load())
	}
	resp.Body.Close()

	resp = request(s, http.MethodPost, "/debug/phi", "Bearer "+s.token)
	if resp.StatusCode != http.StatusMethodNotAllowed || calls.Load() != 0 {
		t.Fatalf("bad method status=%d metrics calls=%d", resp.StatusCode, calls.Load())
	}
	resp.Body.Close()

	resp = request(s, http.MethodGet, "/unknown", "Bearer "+s.token)
	if resp.StatusCode != http.StatusNotFound || calls.Load() != 0 {
		t.Fatalf("unknown route status=%d metrics calls=%d", resp.StatusCode, calls.Load())
	}
	resp.Body.Close()

	resp = request(s, http.MethodGet, "/debug/phi", "Bearer "+s.token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("snapshot status = %d", resp.StatusCode)
	}
	if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("security headers = %v", resp.Header)
	}
	if calls.Load() != 2 {
		t.Fatalf("metrics called %d times, want 2", calls.Load())
	}
	var got snapshotResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Ownership != nil {
		t.Fatalf("ownership = %v, want null without a callback", got.Ownership)
	}
	if got.snapshot.Process.RSSBytes == nil || *got.snapshot.Process.RSSBytes != 4096 || got.snapshot.Process.CPUTotalSeconds == nil || *got.snapshot.Process.CPUTotalSeconds != 0.5 {
		t.Fatalf("process snapshot = %+v", got.snapshot.Process)
	}
}

func TestSnapshotIncludesOptionalOwnershipCallback(t *testing.T) {
	s := startTestServer(t, snapshotReaders{
		rss: func(context.Context) (uint64, error) { return 4096, nil },
		cpu: func(context.Context) (float64, error) { return 0.5, nil },
	})
	var calls atomic.Int32
	s.SetOwnershipStats(func() any {
		calls.Add(1)
		return map[string]any{"complete": true, "ring_capacity_bytes": 64}
	})

	resp := request(s, http.MethodGet, "/debug/phi", "Bearer "+s.token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("snapshot status = %d", resp.StatusCode)
	}
	var got struct {
		Ownership map[string]any `json:"ownership"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || got.Ownership["complete"] != true || got.Ownership["ring_capacity_bytes"] != float64(64) {
		t.Fatalf("ownership = %v, callback calls = %d", got.Ownership, calls.Load())
	}
}

func TestSnapshotBusyRejectsConcurrentRequest(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	s := startTestServer(t, snapshotReaders{
		rss: func(context.Context) (uint64, error) {
			select {
			case <-entered:
			default:
				close(entered)
			}
			<-release
			return 8192, nil
		},
		cpu: func(context.Context) (float64, error) { return 0.25, nil },
	})

	firstDone := make(chan error, 1)
	go func() {
		resp := request(s, http.MethodGet, "/debug/phi", "Bearer "+s.token)
		defer resp.Body.Close()
		firstDone <- expectStatus(resp, http.StatusOK)
	}()
	<-entered

	resp := request(s, http.MethodGet, "/debug/phi", "Bearer "+s.token)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("concurrent snapshot status = %d, want 503", resp.StatusCode)
	}
	resp.Body.Close()
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
}

func TestStartRejectsInvalidParentWithoutArtifacts(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("owned"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := start(file, time.Now(), "test", currentProcessReaders()); err == nil {
		t.Fatal("expected a regular file parent to fail")
	}
	if got, err := os.ReadFile(file); err != nil || string(got) != "owned" {
		t.Fatalf("parent file changed: %q, err=%v", got, err)
	}
}

func TestStartRejectsRelativeParent(t *testing.T) {
	if _, err := start("relative", time.Now(), "test", currentProcessReaders()); err == nil {
		t.Fatal("expected a relative parent to fail")
	}
}

func TestCloseIsIdempotentAndLeavesUnknownContents(t *testing.T) {
	s := startTestServer(t, snapshotReaders{
		rss: func(context.Context) (uint64, error) { return 1, nil },
		cpu: func(context.Context) (float64, error) { return 0, nil },
	})
	unknown := filepath.Join(s.Dir(), "operator-note")
	if err := os.WriteFile(unknown, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err == nil {
		t.Fatal("expected non-empty owned directory to be retained")
	}
	if err := s.Close(); err == nil {
		t.Fatal("second Close must return the same cleanup error")
	}
	if _, err := os.Stat(unknown); err != nil {
		t.Fatalf("unknown file was removed: %v", err)
	}
	for _, name := range []string{"url", "client.curl"} {
		if _, err := os.Stat(filepath.Join(s.Dir(), name)); !os.IsNotExist(err) {
			t.Fatalf("connection file %s remains: %v", name, err)
		}
	}
	if _, err := http.Get(s.URL() + "/debug/phi"); err == nil {
		t.Fatal("listener remained reachable after Close")
	}
}

func startTestServer(t *testing.T, readers snapshotReaders) *Server {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("private diagnostics listener is disabled on Windows")
	}
	s, err := start(t.TempDir(), time.Now(), "test-commit", readers)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func request(s *Server, method, path, authorization string) *http.Response {
	req, err := http.NewRequest(method, s.URL()+path, nil)
	if err != nil {
		panic(err)
	}
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(fmt.Sprintf("request %s: %v", path, err))
	}
	return resp
}

func expectStatus(resp *http.Response, want int) error {
	if resp.StatusCode != want {
		return fmt.Errorf("status = %d, want %d", resp.StatusCode, want)
	}
	return nil
}
