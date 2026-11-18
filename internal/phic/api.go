package phic

import (
	"context"
	"encoding/json"
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

// authStatus is phiaccess.Status: one shared mirror of GET
// /api/auth/status and one shared client-side proof.
type authStatus = phiaccess.Status

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
		http: &http.Client{Transport: obs.Transport(nil), Jar: jar, Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
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
	if err := phiaccess.ValidateChallenge(status); err != nil {
		return err
	}
	proof, err := phiaccess.Proof(password, status)
	if err != nil {
		return err
	}

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
