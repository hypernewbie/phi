// Package phicmd is the phi-cmd client library: REST, control WebSocket,
// and pane WebSocket against one Phi backend, plus the shared login.
//
// It is deliberately independent of internal/phic, which links the
// virtual terminal; this package links no terminal emulation at all.
package phicmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/internal/phiaccess"
	"github.com/hypernewbie/phi/pkg/obs"
)

// Exit codes. They are a contract for scripts and agents.
const (
	ExitOK        = 0
	ExitError     = 1 // runtime error (transport, protocol, server)
	ExitUsage     = 2 // usage error (bad flags, unknown command, ambiguity)
	ExitNotFound  = 3 // target not found (server, session, pane, coder)
	ExitAuth      = 4 // authentication required or refused
	ExitTimeout   = 5 // deadline exceeded
	maxRedirects  = 5
	defaultMaxOut = 1 << 20 // 1 MiB default output cap
)

// ErrUnauthorized marks a request the server refused as unauthenticated.
var ErrUnauthorized = errors.New("phi-cmd: authentication required")

// ErrNotFound marks a missing target (pane, session, coder).
var ErrNotFound = errors.New("phi-cmd: not found")

// PasswordSource resolves the access password when a backend demands one.
// It returns an empty string when no password is available; the client
// then reports the auth failure with the available env-var hint.
type PasswordSource func(ctx context.Context) (string, error)

// HTTP is the REST half of a backend connection. The cookie jar carries
// the access session across requests and onto WebSocket upgrades.
type HTTP struct {
	Base     *url.URL
	Client   *http.Client
	MaxBytes int64

	password PasswordSource
	sessions *phiaccess.SessionStore
	loginMu  sync.Mutex
	tried    bool
}

// RememberSessions makes the client reuse and refresh phic's saved
// access sessions beside the profiles document. A login in phic or in
// phi-cmd is then a login in both; the password itself is never stored.
func (h *HTTP) RememberSessions(profilesPath string) {
	if profilesPath == "" {
		return
	}
	h.sessions = phiaccess.NewSessionStore(profilesPath)
	if c, err := h.sessions.Load(h.Base.String()); err == nil && c != nil {
		h.Client.Jar.SetCookies(h.Base, []*http.Cookie{c})
	}
}

// sessionCookie returns the current access-session cookie, if any.
func (h *HTTP) sessionCookie() *http.Cookie {
	u := *h.Base
	u.Path = ""
	for _, c := range h.Client.Jar.Cookies(&u) {
		if c.Name == "phi_access_session" && c.Value != "" {
			cp := *c
			return &cp
		}
	}
	return nil
}

// NewHTTP builds a client for one origin. The origin must be the server
// root (Phi serves /api and /ws at the origin root).
func NewHTTP(origin string, password PasswordSource) (*HTTP, error) {
	u, err := url.Parse(strings.TrimRight(origin, "/"))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("phi-cmd: invalid server URL %q", origin)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{
		Transport: obs.Transport(nil),
		Jar:       jar,
		Timeout:   60 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Never move credentials to another server.
			if req.URL.Scheme != u.Scheme || !strings.EqualFold(req.URL.Host, u.Host) {
				return fmt.Errorf("phi-cmd: cross-origin redirect refused")
			}
			if len(via) >= maxRedirects {
				return fmt.Errorf("phi-cmd: too many redirects")
			}
			return nil
		},
	}
	h := &HTTP{Base: u, Client: client, MaxBytes: defaultMaxOut, password: password}
	return h, nil
}

// NoPassword is a source that never has a password.
func NoPassword(context.Context) (string, error) { return "", nil }

// APIError carries a non-2xx REST answer.
type APIError struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *APIError) Error() string {
	trimmed := strings.TrimSpace(e.Body)
	if len(trimmed) > 200 {
		trimmed = trimmed[:200] + "…"
	}
	if trimmed == "" {
		return fmt.Sprintf("%s %s: %s", e.Method, e.Path, http.StatusText(e.Status))
	}
	return fmt.Sprintf("%s %s: %s: %s", e.Method, e.Path, http.StatusText(e.Status), trimmed)
}

// Do performs one API request, logging in once on a 401 and retrying.
// body may be nil; out may be nil to discard a JSON answer.
func (h *HTTP) Do(ctx context.Context, method, path string, body []byte, out any) error {
	respBody, _, err := h.do(ctx, method, path, body, true)
	if err != nil {
		return err
	}
	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("phi-cmd: malformed %s answer: %w", path, err)
		}
	}
	return nil
}

// Raw performs one API request and returns the bounded body bytes.
func (h *HTTP) Raw(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	return h.do(ctx, method, path, body, true)
}

func (h *HTTP) do(ctx context.Context, method, path string, body []byte, allowLogin bool) ([]byte, int, error) {
	status, respBody, err := h.once(ctx, method, path, body)
	if err != nil {
		return nil, status, err
	}
	if status == http.StatusUnauthorized && allowLogin && h.password != nil {
		if loginErr := h.login(ctx); loginErr != nil {
			return nil, status, loginErr
		}
		status, respBody, err = h.once(ctx, method, path, body)
		if err != nil {
			return nil, status, err
		}
	}
	if status != http.StatusOK {
		return respBody, status, &APIError{Method: method, Path: path, Status: status, Body: string(respBody)}
	}
	return respBody, status, nil
}

// once performs one request. err is a transport failure only; a non-200
// status is conveyed by the status return, not as an error, so the caller
// can intercept 401 for the login retry.
func (h *HTTP) once(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.Base.String()+path, reader)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := h.Client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	limit := h.MaxBytes
	if limit <= 0 {
		limit = defaultMaxOut
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if int64(len(data)) > limit {
		data = data[:limit]
	}
	return resp.StatusCode, data, nil
}

// login runs the v1 challenge→proof handshake once per process.
func (h *HTTP) login(ctx context.Context) error {
	h.loginMu.Lock()
	defer h.loginMu.Unlock()
	if h.tried {
		// Another login already ran in this process. Do not fail here:
		// the caller retries the request, and either the new cookie works
		// or the 401 answer is the honest result.
		return nil
	}
	h.tried = true

	status, body, err := h.once(ctx, http.MethodGet, "/api/auth/status", nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return &APIError{Method: "GET", Path: "/api/auth/status", Status: status, Body: string(body)}
	}
	var auth phiaccess.Status
	if err := json.Unmarshal(body, &auth); err != nil {
		return fmt.Errorf("phi-cmd: malformed auth status: %w", err)
	}
	if !auth.Enabled {
		// Auth disabled but the request was refused: not a login problem.
		return ErrUnauthorized
	}
	if auth.Authenticated {
		return ErrUnauthorized // cookie present yet refused: session revoked
	}
	password, err := h.password(ctx)
	if err != nil {
		return fmt.Errorf("phi-cmd: password unavailable: %w", err)
	}
	if password == "" {
		return fmt.Errorf(`%w (set PHI_CMD_PASSWORD or use --password-file)`, ErrUnauthorized)
	}
	if err := phiaccess.ValidateChallenge(auth); err != nil {
		return err
	}
	proof, err := phiaccess.Proof(password, auth)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"challenge": auth.Challenge, "proof": proof})
	status, body, err = h.once(ctx, http.MethodPost, "/api/auth/login", payload)
	if err != nil {
		return err
	}
	if status == http.StatusUnauthorized {
		return fmt.Errorf("%w: invalid password", ErrUnauthorized)
	}
	if status != http.StatusOK {
		return &APIError{Method: "POST", Path: "/api/auth/login", Status: status, Body: string(body)}
	}
	var ok struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(body, &ok); err != nil || !ok.OK {
		return fmt.Errorf("%w: login refused", ErrUnauthorized)
	}
	if h.sessions != nil {
		if c := h.sessionCookie(); c != nil {
			// Best-effort: a failed save only costs re-login next time.
			_ = h.sessions.Save(h.Base.String(), *c)
		}
	}
	return nil
}

// Health probes /healthz without credentials: a liveness probe must
// never send a password or session cookie.
func (h *HTTP) Health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.Base.String()+"/healthz", nil)
	if err != nil {
		return err
	}
	probe := *h.Client
	probe.Jar = nil
	resp, err := probe.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("healthz: %s", resp.Status)
	}
	return nil
}
