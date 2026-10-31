package dshweb

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	startupTimeout   = 60 * time.Second
	readinessPoll    = 500 * time.Millisecond
	maxStartupOutput = 1 << 20
	termGrace        = 8 * time.Second
	killGrace        = 2 * time.Second
	announcePrefix   = "dsh web: "
)

// ServiceConfig contains startup-only values. Clock and Starter are test seams.
type ServiceConfig struct {
	Enabled  bool
	Command  string
	Origin   string
	DataDir  string
	Clock    Clock
	Starter  Starter
	TempBase string
}

// Service owns one DSH process for its entire lifetime. Only run terminates
// and reaps the child; Stop cancels it and joins that owner.
type Service struct {
	clock     Clock
	starter   Starter
	tempBase  string
	origin    Origin
	command   string
	dataDir   string
	admit     Admit
	live      *liveRegistry
	transport http.RoundTripper
	ctx       context.Context
	cancel    context.CancelFunc

	mu       sync.Mutex
	status   Status
	started  bool
	instance string
	upstream *url.URL
	token    string
	proxy    *httputil.ReverseProxy
	wg       sync.WaitGroup
}

func NewService(cfg ServiceConfig, admit Admit, current CurrentGeneration) *Service {
	clock := cfg.Clock
	if clock == nil {
		clock = SystemClock()
	}
	starter := cfg.Starter
	if starter == nil {
		starter = realStarter{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{
		clock: clock, starter: starter, tempBase: cfg.TempBase,
		command: cfg.Command, dataDir: cfg.DataDir, admit: admit,
		ctx: ctx, cancel: cancel,
		status:    Status{Enabled: cfg.Enabled, State: StateDisabled},
		transport: newLoopbackTransport(),
		live:      newLiveRegistry(clock, current),
	}
	if !cfg.Enabled {
		return s
	}
	origin, err := ParseOrigin(cfg.Origin)
	if err != nil || !filepath.IsAbs(cfg.Command) || cfg.DataDir == "" {
		s.fail(ReasonInvalidConfig)
		return s
	}
	s.origin = origin
	if !supportedPlatform() {
		s.fail(ReasonUnsupported)
		return s
	}
	s.status.State = StateStopped
	return s
}

// Start is one-shot, including after Stop. The join count is published under
// the same lock as Stop so shutdown cannot miss a not-yet-started goroutine.
func (s *Service) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started || s.ctx.Err() != nil || !s.status.Enabled || s.status.State == StateUnavailable {
		return
	}
	s.started = true
	s.status.State = StateStarting
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.run() }()
}

func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}
func (s *Service) Origin() Origin { return s.origin }
func (s *Service) Admit(r *http.Request) (Lease, bool) {
	if s.admit == nil {
		return Lease{}, false
	}
	return s.admit(r)
}
func (s *Service) Ready() (string, *httputil.ReverseProxy, *url.URL, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.instance, s.proxy, s.upstream, s.status.State == StateReady
}
func (s *Service) Live() *liveRegistry { return s.live }
func (s *Service) RevokeStale()        { s.live.RevokeStale() }

func (s *Service) Stop() {
	s.mu.Lock()
	s.cancel()
	if s.status.State != StateDisabled {
		s.clearLocked(StateStopped, ReasonStopped)
	}
	s.mu.Unlock()
	s.live.CloseAll()
	s.wg.Wait()
}

func (s *Service) clearLocked(state, reason string) {
	s.status.State, s.status.Reason, s.status.Mount = state, reason, ""
	s.instance, s.token, s.upstream, s.proxy = "", "", nil, nil
}
func (s *Service) fail(reason string) {
	s.mu.Lock()
	if s.ctx.Err() == nil {
		s.clearLocked(StateUnavailable, reason)
	}
	s.mu.Unlock()
	s.live.CloseAll()
}

func (s *Service) run() {
	if s.ctx.Err() != nil {
		return
	}
	instance, err := mintInstance()
	if err != nil {
		s.fail(ReasonSpawnFailed)
		return
	}
	home := filepath.Join(s.dataDir, "dsh-preview", "home")
	agents := filepath.Join(s.dataDir, "dsh-preview", "agents")
	for _, dir := range []string{home, agents} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			s.fail(ReasonSpawnFailed)
			return
		}
	}
	runTemp, err := os.MkdirTemp(s.tempBase, "phi-dsh-run-")
	if err != nil {
		s.fail(ReasonSpawnFailed)
		return
	}
	defer os.RemoveAll(runTemp)
	cwd := filepath.Join(runTemp, "cwd")
	if err := os.MkdirAll(cwd, 0700); err != nil {
		s.fail(ReasonSpawnFailed)
		return
	}
	if s.ctx.Err() != nil {
		return
	}
	args := []string{"--profile", "web", "--host", "127.0.0.1", "--port", "0", "--no-open", "--trusted-host", s.origin.Authority}
	proc, stdout, stderr, err := s.starter.Start(s.command, args, cwd, childEnv(home, agents, runTemp))
	if err != nil {
		s.fail(ReasonSpawnFailed)
		return
	}

	// Install the Wait owner immediately, even if Stop won during Start.
	waitDone := make(chan struct{})
	startupCtx, cancelStartup := context.WithCancel(s.ctx)
	go func() { _ = proc.Wait(); close(waitDone); cancelStartup() }()
	var drainers sync.WaitGroup
	defer func() {
		cancelStartup()
		terminateProcess(proc, waitDone, s.clock)
		// A descendant can retain the pipes after the leader exits. Closing
		// our readers prevents that descendant from holding shutdown open.
		_ = stdout.Close()
		_ = stderr.Close()
		drainers.Wait()
		if t, ok := s.transport.(interface{ CloseIdleConnections() }); ok {
			t.CloseIdleConnections()
		}
	}()
	if s.ctx.Err() != nil {
		return
	}

	deadline := s.clock.AfterFunc(startupTimeout, cancelStartup)
	defer deadline.Stop()
	var outputBytes atomic.Int64
	announced := make(chan string, 1)
	overflow := make(chan struct{}, 1)
	drainers.Add(2)
	go drainPipe(stdout, &outputBytes, overflow, &drainers, func(line string) {
		if rest, ok := strings.CutPrefix(line, announcePrefix); ok {
			select {
			case announced <- strings.TrimSpace(rest):
			default:
			}
		}
	})
	go drainPipe(stderr, &outputBytes, overflow, &drainers, nil)

	failure := func(reason string) {
		if s.ctx.Err() != nil {
			return
		}
		select {
		case <-waitDone:
			reason = ReasonChildExited
		default:
		}
		s.fail(reason)
	}
	var raw string
	select {
	case <-startupCtx.Done():
		failure(ReasonStartupTimeout)
		return
	case <-overflow:
		failure(ReasonOutputOverflow)
		return
	case raw = <-announced:
	}
	upstream, token, err := parseAnnouncement(raw)
	if err != nil {
		failure(ReasonBadAnnouncement)
		return
	}
	if !s.awaitReady(startupCtx, upstream) {
		failure(ReasonNotReady)
		return
	}
	select {
	case <-overflow:
		failure(ReasonOutputOverflow)
		return
	default:
	}
	deadline.Stop()
	cancelStartup()
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.instance, s.upstream, s.token = instance, upstream, token
	s.proxy = newDSHProxy(upstream, "/api/dsh/"+instance+"/", s.origin, s.live, s.transport)
	s.status.State, s.status.Reason, s.status.Mount = StateReady, ReasonNone, "/api/dsh/"+instance+"/"
	s.mu.Unlock()
	select {
	case <-s.ctx.Done():
	case <-waitDone:
		s.fail(ReasonChildExited)
	}
}

func (s *Service) awaitReady(ctx context.Context, upstream *url.URL) bool {
	for ctx.Err() == nil {
		if s.probeReady(ctx, upstream) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-s.clock.After(readinessPoll):
		}
	}
	return false
}

func (s *Service) probeReady(ctx context.Context, upstream *url.URL) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstream.String()+"/", nil)
	if err != nil {
		return false
	}
	resp, err := s.transport.RoundTrip(req)
	if err != nil {
		return false
	}
	// The status is sufficient. Never wait for an unbounded denial body.
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusUnauthorized
}

// drainPipe caps even an unterminated line. After the cap it discards all
// output without retaining it; child diagnostics never enter Phi logs.
func drainPipe(r io.ReadCloser, total *atomic.Int64, overflow chan struct{}, wg *sync.WaitGroup, onLine func(string)) {
	defer wg.Done()
	reader := bufio.NewReader(r)
	var line []byte
	for {
		part, err := reader.ReadSlice('\n')
		if total.Add(int64(len(part))) > maxStartupOutput {
			select {
			case overflow <- struct{}{}:
			default:
			}
			_, _ = io.Copy(io.Discard, reader)
			return
		}
		if onLine != nil {
			line = append(line, part...)
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if onLine != nil && len(line) > 0 {
			onLine(strings.TrimRight(string(line), "\r\n"))
			line = line[:0]
		}
		if err != nil {
			return
		}
	}
}

func parseAnnouncement(raw string) (*url.URL, string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", err
	}
	if u.Scheme != "http" || u.User != nil || (u.Path != "" && u.Path != "/") || u.Fragment != "" || u.Opaque != "" {
		return nil, "", errors.New("dshweb: invalid announcement URL")
	}
	// Literal loopback only: neither DNS nor proxy discovery is permitted.
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return nil, "", errors.New("dshweb: announcement must be loopback")
	}
	n, err := strconv.Atoi(u.Port())
	if err != nil || n < 1 || n > 65535 {
		return nil, "", errors.New("dshweb: invalid announcement port")
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(q) != 1 || len(q["token"]) != 1 || q.Get("token") == "" {
		return nil, "", errors.New("dshweb: announcement must carry one token")
	}
	return &url.URL{Scheme: "http", Host: u.Host}, q.Get("token"), nil
}

func mintInstance() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

func ValidInstance(instance string) bool {
	if len(instance) != 22 {
		return false
	}
	for i := 0; i < len(instance); i++ {
		c := instance[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_' {
			continue
		}
		return false
	}
	return true
}

// childEnv never inherits ambient credentials, proxies, or tool config.
func childEnv(home, agents, tmp string) []string {
	return []string{
		"HOME=" + home, "PATH=" + fixedChildPath(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TMPDIR=" + tmp,
		"DSH_HOME=" + home, "DSH_AGENTS_HOME=" + agents, "DSH_TELEMETRY_DISABLED=1",
	}
}
func fixedChildPath() string {
	if runtime.GOOS == "darwin" {
		return "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	}
	return "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}
