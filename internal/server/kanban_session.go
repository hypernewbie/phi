package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The Vikunja session belongs to the server, not to a browser.
//
// One login per process (per token lifetime) serves every client of this
// backend: the desktop, the web app and the tablet share it. That makes the
// upstream rate limit (Vikunja allows 10 logins per minute per IP) unreachable
// by a client, and it keeps the Vikunja password and token out of the browser
// entirely.
//
// The client asks for a session; the server logs in once and answers. A 401
// from the board refreshes the token exactly once, and the refresh is fenced
// by the same cooldown that a 429 sets, so no burst of clients can walk into
// the upstream's limit.

const (
	// kanbanLoginTimeout bounds one login round trip.
	kanbanLoginTimeout = 10 * time.Second
	// kanbanRequestTimeout bounds one board request.
	kanbanRequestTimeout = 30 * time.Second
	// kanbanMinLoginInterval is the floor between two login attempts. Many
	// clients may ask for a session at once; one login answers them all.
	kanbanMinLoginInterval = 2 * time.Second
	// kanbanTokenFallbackTTL is used when the token carries no readable
	// expiry. A 401 refreshes it anyway.
	kanbanTokenFallbackTTL = 10 * time.Minute
	// kanbanMaxBodyBytes bounds one board request body.
	kanbanMaxBodyBytes = 8 << 20
	// kanbanMaxErrorBytes bounds one upstream error body.
	kanbanMaxErrorBytes = 64 << 10
)

// kanbanUpstreamError is one upstream failure with the status the client
// should see and the wait before a retry is allowed.
type kanbanUpstreamError struct {
	status     int
	message    string
	retryAfter time.Duration
}

func (e *kanbanUpstreamError) Error() string { return e.message }

// kanbanLoginCall is one in-flight login. Every caller that arrives while it
// runs waits for it instead of starting a second one.
type kanbanLoginCall struct {
	done  chan struct{}
	token string
	err   error
}

// kanbanCredentials reads the configured Vikunja instance and its credentials.
func (app *Server) kanbanCredentials() (baseURL, username, password string, err error) {
	cfg := app.loadConfig()
	baseURL = strings.TrimRight(strings.TrimSpace(cfg.KanbanURL), "/")
	username = strings.TrimSpace(cfg.KanbanUsername)
	if baseURL == "" {
		return "", "", "", &kanbanUpstreamError{
			status:  http.StatusBadRequest,
			message: "No Kanban server is configured.",
		}
	}
	if username == "" {
		return "", "", "", &kanbanUpstreamError{
			status:  http.StatusBadRequest,
			message: "No Kanban username is configured.",
		}
	}
	if cfg.KanbanPasswordEnc == "" {
		return "", "", "", &kanbanUpstreamError{
			status:  http.StatusBadRequest,
			message: "No Kanban password is saved.",
		}
	}
	secret, decErr := app.decryptVault(cfg.KanbanPasswordEnc)
	if decErr != nil {
		return "", "", "", &kanbanUpstreamError{
			status:  http.StatusInternalServerError,
			message: "The saved Kanban password could not be read.",
		}
	}
	return baseURL, username, secret.Plaintext, nil
}

// kanbanEnsureToken returns a usable Vikunja token. It logs in when the
// process has no token, when the token expired, or when a 401 dropped it.
//
// Concurrent callers share one login. A cooldown set by an upstream 429 is
// honoured here, so a client storm never reaches the upstream at all.
func (app *Server) kanbanEnsureToken(ctx context.Context) (string, error) {
	for round := 0; round < 3; round++ {
		now := time.Now()
		app.kanbanMu.Lock()
		if app.kanbanToken != "" && now.Before(app.kanbanTokenExpiry) {
			token := app.kanbanToken
			app.kanbanMu.Unlock()
			return token, nil
		}
		if now.Before(app.kanbanCooldownUntil) {
			wait := app.kanbanCooldownUntil.Sub(now)
			app.kanbanMu.Unlock()
			return "", &kanbanUpstreamError{
				status:     http.StatusTooManyRequests,
				message:    "The Kanban server is rate-limiting logins. Try again shortly.",
				retryAfter: wait,
			}
		}
		if call := app.kanbanLoginCall; call != nil {
			app.kanbanMu.Unlock()
			select {
			case <-call.done:
				if call.err != nil {
					return "", call.err
				}
				continue
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		// The floor between two logins keeps a burst of clients to one
		// upstream call per window. It applies only after a FAILED login:
		// a stale token must be replaceable at once, while an instance
		// that refuses the credentials must not be hammered.
		if app.kanbanLoginFailed {
			if wait := kanbanMinLoginInterval - now.Sub(app.kanbanLastLogin); wait > 0 {
				app.kanbanMu.Unlock()
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					return "", ctx.Err()
				}
				continue
			}
		}
		call := &kanbanLoginCall{done: make(chan struct{})}
		app.kanbanLoginCall = call
		app.kanbanMu.Unlock()

		token, err := app.kanbanLogin(ctx)

		app.kanbanMu.Lock()
		app.kanbanLoginCall = nil
		app.kanbanLastLogin = time.Now()
		app.kanbanLoginFailed = err != nil
		if err != nil {
			var upstream *kanbanUpstreamError
			if asUpstream(err, &upstream) && upstream.retryAfter > 0 {
				app.kanbanCooldownUntil = time.Now().Add(upstream.retryAfter)
			}
		} else {
			app.kanbanToken = token.token
			app.kanbanTokenExpiry = token.expiry
			app.kanbanCooldownUntil = time.Time{}
		}
		app.kanbanMu.Unlock()

		call.token = token.token
		call.err = err
		close(call.done)
		if err != nil {
			return "", err
		}
		return token.token, nil
	}
	return "", &kanbanUpstreamError{
		status:  http.StatusServiceUnavailable,
		message: "The Kanban session could not be established.",
	}
}

// kanbanLoginToken is one successful login and its expiry.
type kanbanLoginToken struct {
	token  string
	expiry time.Time
}

// kanbanLogin performs one login round trip against the configured instance.
func (app *Server) kanbanLogin(ctx context.Context) (kanbanLoginToken, error) {
	baseURL, username, password, err := app.kanbanCredentials()
	if err != nil {
		return kanbanLoginToken{}, err
	}
	body, _ := json.Marshal(map[string]string{
		"username": username,
		"password": password,
	})
	reqCtx, cancel := context.WithTimeout(ctx, kanbanLoginTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, baseURL+"/api/v1/login", strings.NewReader(string(body)))
	if err != nil {
		return kanbanLoginToken{}, &kanbanUpstreamError{
			status:  http.StatusBadGateway,
			message: "The Kanban server address is not usable.",
		}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return kanbanLoginToken{}, &kanbanUpstreamError{
			status:  http.StatusBadGateway,
			message: "The Kanban server could not be reached: " + err.Error(),
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return kanbanLoginToken{}, kanbanLoginFailure(resp)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, kanbanMaxErrorBytes))
	if err != nil {
		return kanbanLoginToken{}, &kanbanUpstreamError{
			status:  http.StatusBadGateway,
			message: "The Kanban server sent an unreadable answer.",
		}
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Token == "" {
		return kanbanLoginToken{}, &kanbanUpstreamError{
			status:  http.StatusBadGateway,
			message: "The Kanban server returned no session token.",
		}
	}
	expiry := time.Now().Add(kanbanTokenFallbackTTL)
	if exp, ok := kanbanTokenExpiry(payload.Token); ok {
		expiry = exp
	}
	return kanbanLoginToken{token: payload.Token, expiry: expiry}, nil
}

// kanbanLoginFailure maps one failed login to a client-facing error. A 429
// carries the upstream's own reset time, so the next attempt waits exactly
// as long as the upstream asks.
func kanbanLoginFailure(resp *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, kanbanMaxErrorBytes))
	message := strings.TrimSpace(string(raw))
	if decoded, ok := kanbanErrorMessage(raw); ok {
		message = decoded
	}
	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		retry := kanbanRetryAfter(resp)
		if message == "" || strings.Contains(message, "Too Many Requests") {
			message = "The Kanban server is rate-limiting logins. Try again shortly."
		}
		return &kanbanUpstreamError{
			status:     http.StatusTooManyRequests,
			message:    message,
			retryAfter: retry,
		}
	case http.StatusForbidden, http.StatusUnauthorized:
		return &kanbanUpstreamError{
			status:  http.StatusForbidden,
			message: "Wrong username or password.",
		}
	}
	if message == "" {
		message = fmt.Sprintf("The Kanban server refused the login (HTTP %d).", resp.StatusCode)
	}
	return &kanbanUpstreamError{
		status:  http.StatusBadGateway,
		message: message,
	}
}

// kanbanErrorMessage reads the message field of a Vikunja error envelope.
func kanbanErrorMessage(raw []byte) (string, bool) {
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Message == "" {
		return "", false
	}
	return payload.Message, true
}

// kanbanRetryAfter reads how long the upstream asks the caller to wait.
func kanbanRetryAfter(resp *http.Response) time.Duration {
	if raw := resp.Header.Get("Retry-After"); raw != "" {
		if secs, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	if raw := resp.Header.Get("X-Ratelimit-Reset"); raw != "" {
		if reset, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil {
			wait := time.Until(time.Unix(reset, 0))
			if wait > 0 {
				return wait.Round(time.Second)
			}
		}
	}
	if raw := resp.Header.Get("X-Ratelimit-Remaining"); raw != "" {
		if remaining, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && remaining <= 0 {
			return 30 * time.Second
		}
	}
	return 30 * time.Second
}

// kanbanTokenExpiry reads the exp claim of a session token. The token is only
// used as a bearer credential for the instance that issued it, so the claim
// is a hint about freshness, never a security decision.
func kanbanTokenExpiry(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp <= 0 {
		return time.Time{}, false
	}
	expiry := time.Unix(claims.Exp, 0)
	if !expiry.After(time.Now()) {
		return time.Time{}, false
	}
	return expiry, true
}

// kanbanDropToken forgets the cached token but keeps the cooldown: a 401
// means the token was stale, not that the instance is angry.
func (app *Server) kanbanDropToken() {
	app.kanbanMu.Lock()
	app.kanbanToken = ""
	app.kanbanTokenExpiry = time.Time{}
	app.kanbanMu.Unlock()
}

// asUpstream reports whether err is a kanban upstream error.
func asUpstream(err error, target **kanbanUpstreamError) bool {
	for err != nil {
		if typed, ok := err.(*kanbanUpstreamError); ok {
			*target = typed
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

// kanbanUpstreamURL builds the upstream URL for one board path. The path is
// relative to the instance root and never carries a scheme or a host.
func kanbanUpstreamURL(baseURL, path string, query url.Values) (string, error) {
	trimmed := strings.TrimPrefix(path, "/")
	if trimmed == "" {
		return "", fmt.Errorf("empty path")
	}
	if strings.Contains(trimmed, "://") {
		return "", fmt.Errorf("absolute url")
	}
	target := strings.TrimRight(baseURL, "/") + "/api/v1/" + trimmed
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("unsupported scheme")
	}
	return parsed.String(), nil
}
