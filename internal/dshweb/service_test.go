package dshweb

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// fakeClock is a deterministic Clock. Advance fires due timers.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	clock *fakeClock
	fire  time.Time
	fn    func()
	done  bool
}

func newFakeClock(now time.Time) *fakeClock {
	return &fakeClock{now: now}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	c.AfterFunc(d, func() { ch <- c.Now() })
	return ch
}

func (c *fakeClock) AfterFunc(d time.Duration, fn func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{clock: c, fire: c.now.Add(d), fn: fn}
	c.timers = append(c.timers, t)
	return t
}

func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	wasActive := !t.done
	t.done = true
	return wasActive
}

// Advance moves time forward and runs due timer callbacks synchronously.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var due []*fakeTimer
	var pending []*fakeTimer
	for _, t := range c.timers {
		if t.done {
			continue
		}
		if !t.fire.After(c.now) {
			t.done = true
			due = append(due, t)
			continue
		}
		pending = append(pending, t)
	}
	c.timers = pending
	c.mu.Unlock()
	for _, t := range due {
		t.fn()
	}
}

func (c *fakeClock) pendingTimers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	active := 0
	for _, t := range c.timers {
		if !t.done {
			active++
		}
	}
	return active
}

// fakeProcess is a scripted child. Wait blocks until release closes.
type fakeProcess struct {
	pid     int
	release chan struct{}
	waited  chan struct{}
	waitErr error
}

func newFakeProcess() *fakeProcess {
	return &fakeProcess{pid: 424242, release: make(chan struct{}), waited: make(chan struct{})}
}

func (p *fakeProcess) Pid() int { return p.pid }

func (p *fakeProcess) Wait() error {
	select {
	case <-p.waited:
	default:
		close(p.waited)
	}
	<-p.release
	return p.waitErr
}

type fakeStarter struct {
	mu       sync.Mutex
	calls    int
	command  string
	args     []string
	dir      string
	env      []string
	stdout   string
	stderr   string
	proc     *fakeProcess
	startErr error
}

func (f *fakeStarter) Start(command string, args []string, dir string, env []string) (Process, io.ReadCloser, io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.command, f.args, f.dir, f.env = command, args, dir, env
	if f.startErr != nil {
		return nil, nil, nil, f.startErr
	}
	if f.proc == nil {
		f.proc = newFakeProcess()
	}
	return f.proc, io.NopCloser(strings.NewReader(f.stdout)), io.NopCloser(strings.NewReader(f.stderr)), nil
}

// Proc returns the spawned fake process, or nil before spawn.
func (f *fakeStarter) Proc() *fakeProcess {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.proc
}

func (f *fakeStarter) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// releaseOnKill swaps the group-signal function so termination releases
// the fake child's Wait, keeping teardown fast and hermetic.
func releaseOnKill(starter *fakeStarter) func() {
	return swapKillGroup(func(syscall.Signal) {
		if p := starter.Proc(); p != nil {
			select {
			case <-p.release:
			default:
				close(p.release)
			}
		}
	})
}

// stopService releases the fake child, then stops the service.
func stopService(s *Service, starter *fakeStarter) {
	if p := starter.Proc(); p != nil {
		select {
		case <-p.release:
		default:
			close(p.release)
		}
	}
	s.Stop()
}

func testOrigin(t *testing.T) string {
	t.Helper()
	return "http://127.0.0.1:8080"
}

func allowAll(*http.Request) (Lease, bool) {
	return Lease{Generation: 1, ExpiresAt: time.Now().Add(time.Hour)}, true
}

func waitState(t *testing.T, s *Service, want string) Status {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st := s.Status()
		if st.State == want {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	st := s.Status()
	t.Fatalf("status = %+v, want state %q", st, want)
	return st
}

func waitProc(t *testing.T, starter *fakeStarter) *fakeProcess {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if p := starter.Proc(); p != nil {
			return p
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("child never spawned")
	return nil
}

func TestDisabledSpawnsNothing(t *testing.T) {
	t.Parallel()
	starter := &fakeStarter{}
	s := NewService(ServiceConfig{
		Enabled: false,
		Command: "/bin/false",
		Origin:  testOrigin(t),
		DataDir: t.TempDir(),
		Clock:   newFakeClock(time.Now()),
		Starter: starter,
	}, allowAll, func() uint64 { return 1 })
	s.Start()
	time.Sleep(100 * time.Millisecond)
	if got := s.Status(); got.State != StateDisabled || got.Enabled {
		t.Fatalf("status = %+v, want disabled", got)
	}
	if calls := starter.Calls(); calls != 0 {
		t.Fatalf("disabled preview spawned %d children", calls)
	}
	s.Stop()
}

func TestInvalidConfigUnavailable(t *testing.T) {
	t.Parallel()
	for _, command := range []string{"", "relative/path/dsh"} {
		starter := &fakeStarter{}
		s := NewService(ServiceConfig{
			Enabled: true,
			Command: command,
			Origin:  testOrigin(t),
			DataDir: t.TempDir(),
			Clock:   newFakeClock(time.Now()),
			Starter: starter,
		}, allowAll, func() uint64 { return 1 })
		s.Start()
		if got := s.Status(); got.State != StateUnavailable || got.Reason != ReasonInvalidConfig {
			t.Errorf("command %q: status = %+v", command, got)
		}
		if calls := starter.Calls(); calls != 0 {
			t.Errorf("command %q: spawned %d children", command, calls)
		}
		s.Stop()
	}
	for _, origin := range []string{"", "http://127.0.0.1:8080/ui", "ftp://127.0.0.1:21"} {
		starter := &fakeStarter{}
		s := NewService(ServiceConfig{
			Enabled: true,
			Command: "/opt/fixture/dsh-wrapper.sh",
			Origin:  origin,
			DataDir: t.TempDir(),
			Clock:   newFakeClock(time.Now()),
			Starter: starter,
		}, allowAll, func() uint64 { return 1 })
		s.Start()
		if got := s.Status(); got.State != StateUnavailable || got.Reason != ReasonInvalidConfig {
			t.Errorf("origin %q: status = %+v", origin, got)
		}
		if calls := starter.Calls(); calls != 0 {
			t.Errorf("origin %q: spawned %d children", origin, calls)
		}
		s.Stop()
	}
}

// stubDSH serves the minimal token-gated root: 401 without credentials,
// a 303 plus cookie for the exact launch token.
func stubDSH(t *testing.T, token, cookieName string, seenHost *atomic.Value) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seenHost != nil {
			seenHost.Store(r.Host)
		}
		if r.URL.Path == "/" && r.URL.Query().Get("token") == token && len(r.URL.Query()) == 1 && r.Method == http.MethodGet {
			http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "stub-signed-value", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Location", "./")
			w.WriteHeader(http.StatusSeeOther)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
}

func TestReadyFlowAndEnvAllowlist(t *testing.T) {
	// Sequential: swaps the package killGroup seam and poisons ambient env.
	// Poison the ambient environment: none of it may enter the child.
	t.Setenv("DEEPSEEK_API_KEY", "real-key-must-not-leak")
	t.Setenv("HTTP_PROXY", "http://proxy.invalid:8080")
	t.Setenv("HTTPS_PROXY", "http://proxy.invalid:8080")
	t.Setenv("PHI_SECRET", "nope")

	var seenHost atomic.Value
	stub := stubDSH(t, "stub-token", "dsh-auth-stub", &seenHost)
	defer stub.Close()
	stubURL, err := url.Parse(stub.URL)
	if err != nil {
		t.Fatal(err)
	}
	announce := fmt.Sprintf("dsh web: http://%s/?token=stub-token\n", stubURL.Host)

	starter := &fakeStarter{stdout: "booting\n" + announce}
	clock := newFakeClock(time.Now())
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{
		Enabled: true,
		Command: "/opt/fixture/dsh-wrapper.sh",
		Origin:  testOrigin(t),
		DataDir: t.TempDir(),
		Clock:   clock,
		Starter: starter,
	}, allowAll, func() uint64 { return 1 })
	defer stopService(s, starter)
	s.Start()
	st := waitState(t, s, StateReady)
	if st.Mount == "" || !strings.HasPrefix(st.Mount, "/api/dsh/") {
		t.Fatalf("mount = %q", st.Mount)
	}
	if _, _, _, ok := s.Ready(); !ok {
		t.Fatal("Ready snapshot missing")
	}

	starter.mu.Lock()
	env := append([]string(nil), starter.env...)
	args := append([]string(nil), starter.args...)
	starter.mu.Unlock()
	for _, kv := range env {
		key := strings.SplitN(kv, "=", 2)[0]
		switch key {
		case "HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "DSH_HOME", "DSH_AGENTS_HOME", "DSH_TELEMETRY_DISABLED":
		default:
			t.Errorf("child env carries %q", kv)
		}
	}
	joined := strings.Join(env, "\n")
	for _, leak := range []string{"real-key-must-not-leak", "proxy.invalid", "PHI_SECRET"} {
		if strings.Contains(joined, leak) {
			t.Errorf("child env leaks %q", leak)
		}
	}
	wantArgs := []string{"--profile", "web", "--host", "127.0.0.1", "--port", "0", "--no-open", "--trusted-host", "127.0.0.1:8080"}
	if strings.Join(args, " ") != strings.Join(wantArgs, " ") {
		t.Errorf("args = %q, want %q", args, wantArgs)
	}
}

func TestStartupTimeout(t *testing.T) {
	// Sequential: swaps the package killGroup seam.
	starter := &fakeStarter{stdout: "still booting, no announcement\n"}
	clock := newFakeClock(time.Now())
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{
		Enabled: true,
		Command: "/opt/fixture/dsh-wrapper.sh",
		Origin:  testOrigin(t),
		DataDir: t.TempDir(),
		Clock:   clock,
		Starter: starter,
	}, allowAll, func() uint64 { return 1 })
	defer stopService(s, starter)
	s.Start()
	deadline := time.Now().Add(10 * time.Second)
	for clock.pendingTimers() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	clock.Advance(61 * time.Second)
	st := waitState(t, s, StateUnavailable)
	if st.Reason != ReasonStartupTimeout {
		t.Fatalf("reason = %q, want %q", st.Reason, ReasonStartupTimeout)
	}
}

func TestBadAnnouncement(t *testing.T) {
	// Sequential: swaps the package killGroup seam.
	bad := []string{
		"dsh web: http://127.0.0.1:8080/\n",
		"dsh web: http://127.0.0.1:8080/?token=\n",
		"dsh web: http://127.0.0.1:8080/?token=a&other=b\n",
		"dsh web: https://127.0.0.1:8080/?token=a\n",
		"dsh web: http://example.com:8080/?token=a\n",
		"dsh web: http://127.0.0.1:0/?token=a\n",
		"dsh web: not-a-url\n",
	}
	for _, raw := range bad {
		starter := &fakeStarter{stdout: raw}
		clock := newFakeClock(time.Now())
		restoreKill := releaseOnKill(starter)
		s := NewService(ServiceConfig{
			Enabled: true,
			Command: "/opt/fixture/dsh-wrapper.sh",
			Origin:  testOrigin(t),
			DataDir: t.TempDir(),
			Clock:   clock,
			Starter: starter,
		}, allowAll, func() uint64 { return 1 })
		s.Start()
		st := waitState(t, s, StateUnavailable)
		if st.Reason != ReasonBadAnnouncement {
			t.Errorf("announce %q: reason = %q", raw, st.Reason)
		}
		stopService(s, starter)
		restoreKill()
	}
}

func TestOutputOverflow(t *testing.T) {
	// Sequential: swaps the package killGroup seam.
	// No newline: the bound must apply before a complete line arrives.
	big := strings.Repeat("x", maxStartupOutput+8192)
	starter := &fakeStarter{stdout: big}
	clock := newFakeClock(time.Now())
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{
		Enabled: true,
		Command: "/opt/fixture/dsh-wrapper.sh",
		Origin:  testOrigin(t),
		DataDir: t.TempDir(),
		Clock:   clock,
		Starter: starter,
	}, allowAll, func() uint64 { return 1 })
	defer stopService(s, starter)
	s.Start()
	st := waitState(t, s, StateUnavailable)
	if st.Reason != ReasonOutputOverflow {
		t.Fatalf("reason = %q, want %q", st.Reason, ReasonOutputOverflow)
	}
}

func TestChildExitBecomesUnavailable(t *testing.T) {
	// Sequential: swaps the package killGroup seam.
	stub := stubDSH(t, "stub-token", "dsh-auth-stub", nil)
	defer stub.Close()
	stubURL, _ := url.Parse(stub.URL)
	starter := &fakeStarter{stdout: fmt.Sprintf("dsh web: http://%s/?token=stub-token\n", stubURL.Host)}
	clock := newFakeClock(time.Now())
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{
		Enabled: true,
		Command: "/opt/fixture/dsh-wrapper.sh",
		Origin:  testOrigin(t),
		DataDir: t.TempDir(),
		Clock:   clock,
		Starter: starter,
	}, allowAll, func() uint64 { return 1 })
	defer stopService(s, starter)
	s.Start()
	waitState(t, s, StateReady)
	proc := waitProc(t, starter)
	close(proc.release)
	st := waitState(t, s, StateUnavailable)
	if st.Reason != ReasonChildExited {
		t.Fatalf("reason = %q, want %q", st.Reason, ReasonChildExited)
	}
	if _, _, _, ok := s.Ready(); ok {
		t.Error("Ready snapshot must clear after child exit")
	}
}

func TestBootstrapExchange(t *testing.T) {
	// Sequential: swaps the package killGroup seam.
	origin := testOrigin(t)
	cookieName, err := CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	var seenHost atomic.Value
	stub := stubDSH(t, "stub-token", cookieName, &seenHost)
	defer stub.Close()
	stubURL, _ := url.Parse(stub.URL)
	starter := &fakeStarter{stdout: fmt.Sprintf("dsh web: http://%s/?token=stub-token\n", stubURL.Host)}
	clock := newFakeClock(time.Now())
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{
		Enabled: true,
		Command: "/opt/fixture/dsh-wrapper.sh",
		Origin:  origin,
		DataDir: t.TempDir(),
		Clock:   clock,
		Starter: starter,
	}, allowAll, func() uint64 { return 1 })
	defer stopService(s, starter)
	s.Start()
	st := waitState(t, s, StateReady)
	cookie, err := s.BootstrapExchange(context.Background(), "127.0.0.1:8080")
	if err != nil {
		t.Fatalf("BootstrapExchange: %v", err)
	}
	if cookie.Name != cookieName || cookie.Value != "stub-signed-value" {
		t.Errorf("cookie = %v", cookie)
	}
	if cookie.Path != st.Mount || !cookie.HttpOnly || cookie.Secure {
		t.Errorf("cookie attrs = %+v, mount %q", cookie, st.Mount)
	}
	if got, _ := seenHost.Load().(string); got != "127.0.0.1:8080" {
		t.Errorf("upstream saw Host %q, want browser-facing host", seenHost)
	}
}

func TestParseAnnouncement(t *testing.T) {
	t.Parallel()
	upstream, token, err := parseAnnouncement("http://127.0.0.1:54321/?token=abc123")
	if err != nil {
		t.Fatal(err)
	}
	if upstream.Host != "127.0.0.1:54321" || token != "abc123" {
		t.Errorf("parsed = %v %q", upstream, token)
	}
	for _, raw := range []string{
		"http://localhost:54321/?token=x", "http://example.com:54321/?token=x",
		"https://127.0.0.1:54321/?token=x", "http://127.0.0.1:0/?token=x",
		"http://user@127.0.0.1:54321/?token=x", "http://127.0.0.1:54321/app?token=x",
		"http://127.0.0.1:54321/?token=x&token=y", "http://127.0.0.1:54321/?token=x&extra=y",
		"http://127.0.0.1:54321/?token=x#fragment",
	} {
		if _, _, err := parseAnnouncement(raw); err == nil {
			t.Errorf("accepted unsafe announcement %q", raw)
		}
	}
}

// startReadyService boots a service against the token-gated stub and waits
// for ready. Sequential: swaps the package killGroup seam.
func startReadyService(t *testing.T, dataDir string) (*Service, *fakeStarter) {
	t.Helper()
	stub := stubDSH(t, "stub-token", "dsh-auth-stub", nil)
	t.Cleanup(stub.Close)
	u, err := url.Parse(stub.URL)
	if err != nil {
		t.Fatal(err)
	}
	announce := fmt.Sprintf("dsh web: http://%s/?token=stub-token\n", u.Host)
	starter := &fakeStarter{stdout: "boot\n" + announce}
	t.Cleanup(releaseOnKill(starter))
	s := NewService(ServiceConfig{
		Enabled: true,
		Command: "/opt/fixture/dsh-wrapper.sh",
		Origin:  testOrigin(t),
		DataDir: dataDir,
		Clock:   newFakeClock(time.Now()),
		Starter: starter,
	}, allowAll, func() uint64 { return 1 })
	t.Cleanup(func() { stopService(s, starter) })
	s.Start()
	waitState(t, s, StateReady)
	return s, starter
}

func TestStopIdempotent(t *testing.T) {
	// Sequential: swaps the package killGroup seam via startReadyService.
	s, _ := startReadyService(t, t.TempDir())
	start := time.Now()
	s.Stop()
	if st := s.Status(); st.State != StateStopped || st.Reason != ReasonStopped {
		t.Fatalf("status = %+v, want stopped", st)
	}
	s.Stop()
	if st := s.Status(); st.State != StateStopped {
		t.Fatalf("second stop status = %+v, want stopped", st)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("double stop took %v, want under 10s", elapsed)
	}
}

func TestDataDirSurvivesService(t *testing.T) {
	// Sequential: swaps the package killGroup seam via startReadyService.
	dataDir := t.TempDir()
	s, _ := startReadyService(t, dataDir)
	keep := filepath.Join(dataDir, "dsh-preview", "home", "session.json")
	if err := os.WriteFile(keep, []byte("durable"), 0600); err != nil {
		t.Fatal(err)
	}
	s.Stop()
	if got, err := os.ReadFile(keep); err != nil || string(got) != "durable" {
		t.Errorf("durable file = %q err %v, want intact", got, err)
	}
}

func TestRefusedPortNotReady(t *testing.T) {
	// Sequential: swaps the package killGroup seam.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	starter := &fakeStarter{stdout: fmt.Sprintf("dsh web: http://127.0.0.1:%d/?token=x\n", port)}
	clock := newFakeClock(time.Now())
	defer releaseOnKill(starter)()
	s := NewService(ServiceConfig{
		Enabled: true,
		Command: "/opt/fixture/dsh-wrapper.sh",
		Origin:  testOrigin(t),
		DataDir: t.TempDir(),
		Clock:   clock,
		Starter: starter,
	}, allowAll, func() uint64 { return 1 })
	defer stopService(s, starter)
	s.Start()
	deadline := time.Now().Add(10 * time.Second)
	for clock.pendingTimers() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	clock.Advance(61 * time.Second)
	st := waitState(t, s, StateUnavailable)
	if st.Reason != ReasonNotReady {
		t.Fatalf("reason = %q, want %q", st.Reason, ReasonNotReady)
	}
}

// swapKillGroup replaces the group-signal function and returns a restore func.
func swapKillGroup(fn func(syscall.Signal)) func() {
	orig := killGroup
	killGroup = func(_ int, sig syscall.Signal) error {
		fn(sig)
		return nil
	}
	return func() { killGroup = orig }
}
