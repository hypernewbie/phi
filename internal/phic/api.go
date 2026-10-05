package phic

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
)

// authStatus is the response of GET /api/auth/status.
type authStatus struct {
	Enabled       bool   `json:"enabled"`
	Authenticated bool   `json:"authenticated"`
	Version       string `json:"version,omitempty"`
	Algorithm     string `json:"algorithm,omitempty"`
	Iterations    int    `json:"iterations,omitempty"`
	Salt          string `json:"salt,omitempty"`
	Challenge     string `json:"challenge,omitempty"`
}

// loginResponse is the response of POST /api/auth/login.
type loginResponse struct {
	OK bool `json:"ok"`
}

// apiClient wraps a *http.Client with the cookie jar and base
// URL. All phic HTTP traffic goes through this type.
type apiClient struct {
	base *url.URL
	http *http.Client
}

// newAPIClient builds an apiClient from a server base URL.
func newAPIClient(server string) (*apiClient, error) {
	u, err := url.Parse(server)
	if err != nil {
		return nil, fmt.Errorf("phic: bad server URL %q: %w", server, err)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &apiClient{
		base: u,
		http: &http.Client{Jar: jar},
	}, nil
}

// AuthStatus calls GET /api/auth/status and returns the parsed
// response. The challenge is single-use; do not call twice.
func (a *apiClient) AuthStatus(ctx context.Context) (authStatus, error) {
	var s authStatus
	if err := a.getJSON(ctx, "/api/auth/status", &s); err != nil {
		return s, err
	}
	return s, nil
}

// Login posts a password proof to /api/auth/login. The proof
// is HMAC-SHA256(verifier, challenge), matching the server's
// accessAuthManager.login.
func (a *apiClient) Login(ctx context.Context, status authStatus, password string) error {
	if !status.Enabled {
		return nil
	}
	salt, err := base64.RawURLEncoding.DecodeString(status.Salt)
	if err != nil {
		return fmt.Errorf("phic: bad salt: %w", err)
	}
	// The server stores only the verifier, never the password.
	// The phic client derives the same verifier from the
	// password + advertised KDF parameters. This means the
	// password never crosses the wire: only the HMAC proof
	// does.
	verifier, err := deriveVerifier(password, salt, status.Algorithm, status.Iterations)
	if err != nil {
		return err
	}
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
	return nil
}

// deriveVerifier reproduces the server's KDF. The server
// stores v1.pbkdf2-sha256.<iters>.<salt>.<verifier>; the
// verifier is PBKDF2(password, salt, iters, 32). The client
// mirrors that to avoid sending the password.
func deriveVerifier(password string, salt []byte, algo string, iters int) ([]byte, error) {
	if algo != "pbkdf2-sha256" {
		return nil, fmt.Errorf("phic: unsupported KDF %q", algo)
	}
	if iters <= 0 {
		return nil, fmt.Errorf("phic: bad iteration count %d", iters)
	}
	return pbkdf2SHA256(password, salt, iters, 32)
}

// getJSON performs a GET and decodes the response into out.
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
		return fmt.Errorf("phic: GET %s: %s", path, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// postJSON performs a POST with a JSON body and decodes the
// response into out.
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
		return fmt.Errorf("phic: POST %s: %s", path, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
