package phic

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"
)

// authStatus mirrors GET /api/auth/status.
type authStatus struct {
	Enabled       bool   `json:"enabled"`
	Authenticated bool   `json:"authenticated"`
	Version       string `json:"version,omitempty"`
	Algorithm     string `json:"algorithm,omitempty"`
	Iterations    int    `json:"iterations,omitempty"`
	Salt          string `json:"salt,omitempty"`
	Challenge     string `json:"challenge,omitempty"`
}

// loginResponse mirrors POST /api/auth/login.
type loginResponse struct {
	OK bool `json:"ok"`
}

// apiClient wraps a *http.Client with the cookie jar and base URL.
type apiClient struct {
	base          *url.URL
	http          *http.Client
	rememberMu    sync.Mutex
	remember      *sessionPersistence
	rememberError string
}

func newAPIClient(server string) (*apiClient, error) {
	origin, _, err := desktopEndpoint(server)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(origin)
	if err != nil {
		return nil, err
	}
	u.Path = ""
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &apiClient{
		base: u,
		http: &http.Client{Jar: jar, Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Do not move credentials or proof bodies to another server.
			if req.URL.Scheme != u.Scheme || !strings.EqualFold(req.URL.Host, u.Host) {
				return fmt.Errorf("phic: cross-origin redirect refused")
			}
			if len(via) >= 5 {
				return fmt.Errorf("phic: too many redirects")
			}
			return nil
		}},
	}, nil
}

// AuthStatus returns the parsed /api/auth/status body.
func (a *apiClient) AuthStatus(ctx context.Context) (authStatus, error) {
	var s authStatus
	var raw json.RawMessage
	if err := a.getJSON(ctx, "/api/auth/status", &raw); err != nil {
		return s, err
	}
	var presence struct {
		Enabled       *bool `json:"enabled"`
		Authenticated *bool `json:"authenticated"`
	}
	if err := json.Unmarshal(raw, &presence); err != nil || presence.Enabled == nil {
		return s, fmt.Errorf("phic: malformed auth status")
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return s, err
	}
	// Only an explicit server rejection/disable clears a remembered login.
	if !s.Enabled || (presence.Authenticated != nil && !s.Authenticated) {
		a.forgetRememberedSession()
	}
	return s, nil
}

// Login posts a password proof derived from the KDF. The
// password never crosses the wire; only the HMAC proof does.
func (a *apiClient) Login(ctx context.Context, status authStatus, password string) error {
	if !status.Enabled {
		return nil
	}
	if status.Version != "v1" || len(status.Salt) > 128 || len(status.Challenge) == 0 || len(status.Challenge) > 4096 {
		return fmt.Errorf("phic: unsupported or malformed login challenge")
	}
	salt, err := base64.RawURLEncoding.DecodeString(status.Salt)
	if err != nil {
		return fmt.Errorf("phic: bad salt: %w", err)
	}
	verifier, err := deriveVerifier(password, salt, status.Algorithm, status.Iterations)
	if err != nil {
		return err
	}
	defer clear(verifier)
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte(status.Challenge))
	proof := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	body, _ := json.Marshal(map[string]string{
		"challenge": status.Challenge,
		"proof":     proof,
	})
	var resp loginResponse
	if err := a.postJSON(ctx, "/api/auth/login", body, &resp); err != nil {
		return err
	}
	if !resp.OK {
		return fmt.Errorf("phic: login failed")
	}
	a.saveRememberedSession()
	return nil
}

func deriveVerifier(password string, salt []byte, algo string, iters int) ([]byte, error) {
	if algo != "pbkdf2-sha256" {
		return nil, fmt.Errorf("phic: unsupported KDF %q", algo)
	}
	if iters <= 0 || iters > 1_000_000 {
		return nil, fmt.Errorf("phic: bad iteration count %d", iters)
	}
	return pbkdf2SHA256(password, salt, iters, 32)
}

func (a *apiClient) getJSON(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base.String()+path, nil)
	if err != nil {
		return err
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &apiError{Code: resp.StatusCode, Message: "GET " + path + ": " + resp.Status}
	}
	return decodeJSON(resp.Body, out)
}

func (a *apiClient) postJSON(ctx context.Context, path string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base.String()+path, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &apiError{Code: resp.StatusCode, Message: "POST " + path + ": " + resp.Status}
	}
	return decodeJSON(resp.Body, out)
}

type apiError struct {
	Code    int
	Message string
}

func (e *apiError) Error() string { return "phic: " + e.Message }

const maxMetadataBytes = 16 << 20

func decodeJSON(r io.Reader, out any) error {
	body, err := io.ReadAll(io.LimitReader(r, maxMetadataBytes+1))
	if err != nil {
		return err
	}
	if len(body) > maxMetadataBytes {
		return fmt.Errorf("phic: metadata response too large")
	}
	return json.Unmarshal(body, out)
}
