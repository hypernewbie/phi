package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/dshweb"
)

// dshFakeProc is a scripted child that never touches real processes.
// Pid -1 keeps termination signal-free; Wait unblocks on release.
type dshFakeProc struct {
	release chan struct{}
}

func (p *dshFakeProc) Pid() int { return -1 }

func (p *dshFakeProc) Wait() error {
	<-p.release
	return nil
}

type dshFakeStarter struct {
	mu     sync.Mutex
	stdout string
	proc   *dshFakeProc
}

func (f *dshFakeStarter) Start(command string, args []string, dir string, env []string) (dshweb.Process, io.ReadCloser, io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.proc == nil {
		f.proc = &dshFakeProc{release: make(chan struct{})}
	}
	return f.proc, io.NopCloser(strings.NewReader(f.stdout)), io.NopCloser(strings.NewReader("")), nil
}

func (f *dshFakeStarter) releaseChild() {
	f.mu.Lock()
	proc := f.proc
	f.mu.Unlock()
	if proc != nil {
		select {
		case <-proc.release:
		default:
			close(proc.release)
		}
	}
}

type dshStub struct {
	t            *testing.T
	server       *httptest.Server
	token        string
	cookieName   string
	hits         atomic.Int64
	exchanges    atomic.Int64
	lastCookie   atomic.Value // last observed upstream Cookie header
	cancelled    chan struct{}
	cancelOnce   sync.Once
	blockRelease chan struct{}
	streamRel    chan struct{}
}

func newDshStub(t *testing.T, cookieName string) *dshStub {
	t.Helper()
	stub := &dshStub{
		token:        "test-launch-token",
		cookieName:   cookieName,
		cancelled:    make(chan struct{}),
		blockRelease: make(chan struct{}),
		streamRel:    make(chan struct{}),
	}
	stub.lastCookie.Store("")
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stub.hits.Add(1)
		stub.lastCookie.Store(r.Header.Get("Cookie"))
		switch {
		case r.URL.Path == "/" && r.URL.Query().Get("token") == stub.token && len(r.URL.Query()) == 1:
			stub.exchanges.Add(1)
			http.SetCookie(w, &http.Cookie{Name: stub.cookieName, Value: "stub-signed", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			w.Header().Set("Location", "./")
			w.WriteHeader(http.StatusSeeOther)
		case r.URL.Path == "/block":
			select {
			case <-r.Context().Done():
				stub.cancelOnce.Do(func() { close(stub.cancelled) })
			case <-stub.blockRelease:
				_, _ = w.Write([]byte("released"))
			}
		case r.URL.Path == "/stream":
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusOK)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			_, _ = w.Write([]byte("A"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			<-stub.streamRel
			_, _ = w.Write([]byte("B"))
		case r.URL.Path == "/die":
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					_ = conn.Close()
					return
				}
			}
			http.Error(w, "no hijack", http.StatusInternalServerError)
		default:
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (s *dshStub) announce(t *testing.T) string {
	t.Helper()
	u, err := url.Parse(s.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u.Host, "127.0.0.1:") {
		t.Fatalf("stub bound to %q, want loopback", u.Host)
	}
	return fmt.Sprintf("dsh web: http://%s/?token=%s\n", u.Host, s.token)
}

const dshTestOrigin = "http://127.0.0.1:8080"

// startDshTestService builds a ready service against the counting stub and
// swaps it in as the global. Tests using it are sequential.
func startDshTestService(t *testing.T, stub *dshStub, admit dshweb.Admit, current dshweb.CurrentGeneration) *dshweb.Service {
	t.Helper()
	return startDshTestServiceOrigin(t, stub, admit, current, dshTestOrigin)
}

func startDshTestServiceOrigin(t *testing.T, stub *dshStub, admit dshweb.Admit, current dshweb.CurrentGeneration, origin string) *dshweb.Service {
	t.Helper()
	starter := &dshFakeStarter{stdout: "boot\n" + stub.announce(t)}
	svc := dshweb.NewService(dshweb.ServiceConfig{
		Enabled:  true,
		Command:  "/opt/fixture/dsh-wrapper.sh",
		Origin:   origin,
		DataDir:  t.TempDir(),
		TempBase: t.TempDir(),
		Starter:  starter,
	}, admit, current)
	t.Cleanup(func() {
		starter.releaseChild()
		svc.Stop()
	})
	svc.Start()
	deadline := time.Now().Add(15 * time.Second)
	for {
		if st := svc.Status(); st.State == dshweb.StateReady {
			break
		} else if st.State == dshweb.StateUnavailable {
			t.Fatalf("service unavailable: %+v", st)
		}
		if time.Now().After(deadline) {
			t.Fatalf("service never ready: %+v", svc.Status())
		}
		time.Sleep(10 * time.Millisecond)
	}
	dshServiceMu.Lock()
	prev := dshService
	dshService = svc
	dshServiceMu.Unlock()
	t.Cleanup(func() {
		dshServiceMu.Lock()
		dshService = prev
		dshServiceMu.Unlock()
	})
	return svc
}

func dshAdmitYes(gen *atomic.Uint64) dshweb.Admit {
	return func(*http.Request) (dshweb.Lease, bool) {
		return dshweb.Lease{Generation: gen.Load(), ExpiresAt: time.Now().Add(time.Hour)}, true
	}
}

func dshAdmitNo(*http.Request) (dshweb.Lease, bool) {
	return dshweb.Lease{}, false
}

func dshMountRequest(t *testing.T, svc *dshweb.Service, method, suffix string) *http.Request {
	t.Helper()
	st := svc.Status()
	req := httptest.NewRequest(method, st.Mount+suffix, nil)
	req.Host = "127.0.0.1:8080"
	return req
}

func TestDshUnauthorizedZeroUpstream(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(3)
	svc := startDshTestService(t, stub, dshAdmitNo, gen.Load)
	base := stub.hits.Load()

	// Entry: naked frame navigation with no Phi session.
	entry := dshMountRequest(t, svc, http.MethodGet, "")
	entryResp := httptest.NewRecorder()
	handleDshMount(entryResp, entry)
	if entryResp.Code != http.StatusUnauthorized {
		t.Errorf("entry code = %d, want 401", entryResp.Code)
	}

	// API call with no Phi session.
	api := dshMountRequest(t, svc, http.MethodGet, "api/sessions")
	apiResp := httptest.NewRecorder()
	handleDshMount(apiResp, api)
	if apiResp.Code != http.StatusUnauthorized {
		t.Errorf("api code = %d, want 401", apiResp.Code)
	}

	// Upgrade attempt with no Phi session.
	upgrade := dshMountRequest(t, svc, http.MethodGet, "ws")
	upgrade.Header.Set("Upgrade", "websocket")
	upgrade.Header.Set("Connection", "Upgrade")
	upgrade.Header.Set("Origin", dshTestOrigin)
	upgradeResp := httptest.NewRecorder()
	handleDshMount(upgradeResp, upgrade)
	if upgradeResp.Code != http.StatusUnauthorized {
		t.Errorf("upgrade code = %d, want 401", upgradeResp.Code)
	}

	if got := stub.hits.Load() - base; got != 0 {
		t.Errorf("unauthorized requests reached upstream %d times, want 0", got)
	}
}

func TestDshStaleInstance404(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)
	base := stub.hits.Load()

	req := httptest.NewRequest(http.MethodGet, "/api/dsh/aaaaaaaaaaaaaaaaaaaaaa/api/x", nil)
	req.Host = "127.0.0.1:8080"
	resp := httptest.NewRecorder()
	handleDshMount(resp, req)
	if resp.Code != http.StatusNotFound {
		t.Errorf("stale instance code = %d, want 404", resp.Code)
	}
	if got := stub.hits.Load() - base; got != 0 {
		t.Errorf("stale instance reached upstream %d times, want 0", got)
	}
	_ = svc
}

func TestDshBootstrapRedirect(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)

	req := dshMountRequest(t, svc, http.MethodGet, "")
	resp := httptest.NewRecorder()
	handleDshMount(resp, req)
	if resp.Code != http.StatusSeeOther {
		t.Fatalf("bootstrap code = %d, want 303", resp.Code)
	}
	st := svc.Status()
	if loc := resp.Header().Get("Location"); loc != st.Mount {
		t.Errorf("Location = %q, want mount %q", loc, st.Mount)
	}
	if strings.Contains(resp.Header().Get("Location"), "token") {
		t.Error("bootstrap redirect leaks the launch token")
	}
	cookies := resp.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != cookieName {
		t.Fatalf("cookies = %v, want single %q", cookies, cookieName)
	}
	if cookies[0].Path != st.Mount || !cookies[0].HttpOnly || cookies[0].Secure {
		t.Errorf("cookie attrs = %+v, mount %q", cookies[0], st.Mount)
	}
	if got := stub.exchanges.Load(); got != 1 {
		t.Errorf("token exchanges = %d, want 1", got)
	}
	for _, c := range cookies {
		if strings.Contains(c.Value, stub.token) {
			t.Error("bootstrap cookie leaks the launch token")
		}
	}
}

func TestDshPasswordChangeClosesLiveWork(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(5)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)

	// Start a proxied request that blocks at the stub.
	req := dshMountRequest(t, svc, http.MethodGet, "block")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "stub-signed"})
	before := stub.hits.Load()
	done := make(chan int, 1)
	go func() {
		resp := httptest.NewRecorder()
		handleDshMount(resp, req)
		done <- resp.Code
	}()
	deadline := time.Now().Add(10 * time.Second)
	for stub.hits.Load() == before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if stub.hits.Load() == before {
		t.Fatal("blocked request never reached upstream")
	}

	// Password change: bump the auth generation, then revoke live work.
	gen.Store(6)
	dshRevokeLiveWork()

	select {
	case <-stub.cancelled:
	case <-time.After(10 * time.Second):
		t.Fatal("revocation never cancelled the upstream request")
	}
	select {
	case code := <-done:
		if code != http.StatusBadGateway {
			t.Errorf("revoked request code = %d, want 502", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("revoked handler never returned")
	}
	// An old-generation lease no longer registers.
	old := dshweb.Lease{Generation: 5, ExpiresAt: time.Now().Add(time.Hour)}
	if _, ok := svc.Live().Register(old); ok {
		t.Error("pre-change lease still registers after generation bump")
	}
}

func TestDshAdmitGenerationBump(t *testing.T) {
	t.Parallel()
	mgr := newAccessAuthManager()
	first, ok := mgr.admitDSH(httptest.NewRequest(http.MethodGet, "/", nil))
	if !ok {
		t.Fatal("no-password mode must admit")
	}
	gen := mgr.currentGeneration()
	if first.Generation != gen {
		t.Fatalf("lease generation = %d, current = %d", first.Generation, gen)
	}
	// Enabling a password bumps the generation atomically with the session clear.
	encoded := "v1.pbkdf2-sha256.600000.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	if _, _, err := mgr.updatePassword(encoded, true); err != nil {
		t.Fatalf("updatePassword: %v", err)
	}
	if now := mgr.currentGeneration(); now != gen+1 {
		t.Fatalf("generation = %d, want %d", now, gen+1)
	}
	authed, ok := mgr.admitDSH(httptest.NewRequest(http.MethodGet, "/", nil))
	if ok || authed != (dshweb.Lease{}) {
		t.Error("password mode without a session cookie must deny")
	}
}

func TestDshPathGuard(t *testing.T) {
	t.Parallel()
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	guard := dshPathGuard(next)
	cases := []struct {
		target string
		code   int
	}{
		{"/api/dsh/%2e%2e/x", http.StatusBadRequest},
		{"/api/dsh/%2E%2E/x", http.StatusBadRequest},
		{"/api/dsh/%2fstatus", http.StatusBadRequest},
		{"/api/dsh/%5c..", http.StatusBadRequest},
		{"/api/dsh%2fstatus", http.StatusBadRequest},
		{"/api/dsh/%252e%252e/x", http.StatusBadRequest},
		{"/api/dsh/../x", http.StatusBadRequest},
		{"/api/dsh/abc?token=xyz", http.StatusBadRequest},
		{"/api/dsh/abc123/", http.StatusTeapot},
		{"/api/dsh/status", http.StatusTeapot},
		{"/api/config", http.StatusTeapot},
		{"/", http.StatusTeapot},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, tc.target, nil)
		resp := httptest.NewRecorder()
		guard.ServeHTTP(resp, req)
		if resp.Code != tc.code {
			t.Errorf("%s: code = %d, want %d", tc.target, resp.Code, tc.code)
		}
	}
}

func TestDshStatusHandler(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)

	req := httptest.NewRequest(http.MethodGet, "/api/dsh/status", nil)
	resp := httptest.NewRecorder()
	handleDshStatus(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status code = %d", resp.Code)
	}
	body := resp.Body.String()
	var decoded map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("status body is not JSON: %v", err)
	}
	if decoded["enabled"] != true {
		t.Errorf("enabled = %v (%T), want boolean true", decoded["enabled"], decoded["enabled"])
	}
	for _, leak := range []string{stub.token, "stub-signed", "/opt/fixture", "127.0.0.1:"} {
		if strings.Contains(body, leak) {
			t.Errorf("status body leaks %q: %s", leak, body)
		}
	}
	if !strings.Contains(body, svc.Status().Mount) {
		t.Errorf("ready status lacks mount: %s", body)
	}
	if got := resp.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	post := httptest.NewRequest(http.MethodPost, "/api/dsh/status", nil)
	postResp := httptest.NewRecorder()
	handleDshStatus(postResp, post)
	if postResp.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status code = %d, want 405", postResp.Code)
	}
}

func TestDshDshOnlyCookieZeroUpstream(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(3)
	svc := startDshTestService(t, stub, dshAdmitNo, gen.Load)
	base := stub.hits.Load()

	// A stolen DSH cookie without a Phi session admits nothing.
	req := dshMountRequest(t, svc, http.MethodGet, "api/sessions")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "stub-signed"})
	req.AddCookie(&http.Cookie{Name: "phi_access_session", Value: "forged"})
	resp := httptest.NewRecorder()
	handleDshMount(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Errorf("code = %d, want 401", resp.Code)
	}
	if got := stub.hits.Load() - base; got != 0 {
		t.Errorf("DSH-only cookie reached upstream %d times, want 0", got)
	}
}

func TestDshConflictingCookies400(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)
	base := stub.hits.Load()

	req := dshMountRequest(t, svc, http.MethodGet, "api/sessions")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "stub-signed"})
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "attacker-value"})
	resp := httptest.NewRecorder()
	handleDshMount(resp, req)
	if resp.Code != http.StatusBadRequest {
		t.Errorf("code = %d, want 400", resp.Code)
	}
	if got := stub.hits.Load() - base; got != 0 {
		t.Errorf("conflicting cookies reached upstream %d times, want 0", got)
	}
}

func TestDshOnlyDshCookieUpstream(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)

	req := dshMountRequest(t, svc, http.MethodGet, "api/x")
	req.AddCookie(&http.Cookie{Name: "phi_access_session", Value: "s3cret"})
	req.AddCookie(&http.Cookie{Name: "junk", Value: "1"})
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "stub-signed"})
	resp := httptest.NewRecorder()
	handleDshMount(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want stub 401 (proves proxying)", resp.Code)
	}
	if got := stub.lastCookie.Load().(string); got != cookieName+"=stub-signed" {
		t.Errorf("upstream Cookie = %q, want only the DSH cookie", got)
	}

	// No DSH cookie: nothing crosses, not even the Phi session.
	bare := dshMountRequest(t, svc, http.MethodGet, "api/y")
	bare.AddCookie(&http.Cookie{Name: "phi_access_session", Value: "s3cret"})
	bareResp := httptest.NewRecorder()
	handleDshMount(bareResp, bare)
	if bareResp.Code != http.StatusUnauthorized {
		t.Fatalf("bare code = %d, want stub 401", bareResp.Code)
	}
	if got := stub.lastCookie.Load().(string); got != "" {
		t.Errorf("upstream Cookie = %q, want empty", got)
	}
}

func TestDshEmptyInstance404(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)
	base := stub.hits.Load()

	for _, target := range []string{"/api/dsh/", "/api/dsh"} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.Host = "127.0.0.1:8080"
		resp := httptest.NewRecorder()
		handleDshMount(resp, req)
		if resp.Code != http.StatusNotFound {
			t.Errorf("%s: code = %d, want 404", target, resp.Code)
		}
	}
	if got := stub.hits.Load() - base; got != 0 {
		t.Errorf("empty instance reached upstream %d times, want 0", got)
	}
	_ = svc
}

func TestDshBootstrapTlsSecure(t *testing.T) {
	// Sequential: swaps the global DSH service.
	const httpsOrigin = "https://127.0.0.1:8080"
	cookieName, err := dshweb.CookieName("https", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestServiceOrigin(t, stub, dshAdmitYes(&gen), gen.Load, httpsOrigin)

	req := dshMountRequest(t, svc, http.MethodGet, "")
	resp := httptest.NewRecorder()
	handleDshMount(resp, req)
	if resp.Code != http.StatusSeeOther {
		t.Fatalf("bootstrap code = %d, want 303", resp.Code)
	}
	cookies := resp.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure {
		t.Fatalf("cookies = %v, want one Secure cookie", cookies)
	}
}

func TestDshStreamFirstChunk(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)

	srv := httptest.NewServer(http.HandlerFunc(handleDshMount))
	defer srv.Close()
	req, err := http.NewRequest(http.MethodGet, srv.URL+svc.Status().Mount+"stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "127.0.0.1:8080"
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "stub-signed"})
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	// The first chunk must arrive before the second exists.
	first := make([]byte, 1)
	readDone := make(chan error, 1)
	go func() { _, err := io.ReadFull(resp.Body, first); readDone <- err }()
	select {
	case err := <-readDone:
		if err != nil {
			t.Fatalf("first chunk read: %v", err)
		}
		if first[0] != 'A' {
			t.Fatalf("first chunk = %q, want A", first)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("first stream chunk never arrived before release")
	}
	close(stub.streamRel)
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(rest) != "B" {
		t.Errorf("second chunk = %q, want B", rest)
	}
}

func TestDshUpstreamDeathFixedError(t *testing.T) {
	// Sequential: swaps the global DSH service.
	cookieName, err := dshweb.CookieName("http", "127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	stub := newDshStub(t, cookieName)
	var gen atomic.Uint64
	gen.Store(1)
	svc := startDshTestService(t, stub, dshAdmitYes(&gen), gen.Load)

	req := dshMountRequest(t, svc, http.MethodGet, "die")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "stub-signed"})
	resp := httptest.NewRecorder()
	handleDshMount(resp, req)
	if resp.Code != http.StatusBadGateway {
		t.Fatalf("code = %d, want 502", resp.Code)
	}
	body := resp.Body.String()
	if body != "dsh unavailable\n" {
		t.Errorf("body = %q, want the fixed error", body)
	}
	for _, leak := range []string{stub.token, "stub-signed", "127.0.0.1:"} {
		if strings.Contains(body, leak) {
			t.Errorf("error body leaks %q", leak)
		}
	}
}

func TestDshPasswordLifecycle(t *testing.T) {
	// Sequential: touches the global DSH service handle (nil-safe path).
	mgr := newAccessAuthManager()
	gen := mgr.currentGeneration()
	first := "v1.pbkdf2-sha256.600000.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	second := "v1.pbkdf2-sha256.600000.AAAAAAAAAAAAAAAAAAAAAB.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABA"

	token1, _, err := mgr.updatePassword(first, false)
	if err != nil || token1 == "" {
		t.Fatalf("enable: token %q err %v", token1, err)
	}
	if now := mgr.currentGeneration(); now != gen+1 {
		t.Fatalf("generation = %d, want %d", now, gen+1)
	}
	withSession := func(token string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.AddCookie(&http.Cookie{Name: "phi_access_session", Value: token})
		return req
	}
	if _, ok := mgr.admitDSH(withSession(token1)); !ok {
		t.Fatal("fresh session must admit")
	}

	token2, _, err := mgr.updatePassword(second, true)
	if err != nil || token2 == "" {
		t.Fatalf("change: token %q err %v", token2, err)
	}
	if _, ok := mgr.admitDSH(withSession(token1)); ok {
		t.Error("pre-change session still admits after password change")
	}
	if _, ok := mgr.admitDSH(withSession(token2)); !ok {
		t.Error("post-change session must admit")
	}

	if token, _, err := mgr.updatePassword("", true); err != nil || token != "" {
		t.Fatalf("clear: token %q err %v", token, err)
	}
	if _, ok := mgr.admitDSH(httptest.NewRequest(http.MethodGet, "/", nil)); !ok {
		t.Error("cleared manager must admit without a session")
	}

	// Revocation with no preview service (or an absent hub) is a no-op.
	dshRevokeLiveWork()
}
