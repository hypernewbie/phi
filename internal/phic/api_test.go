package phic

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"golang.org/x/crypto/pbkdf2"
)

// TestAPIClientAuthStatusDisabled covers the no-auth path.
func TestAPIClientAuthStatusDisabled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/status" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"enabled":       false,
			"authenticated": false,
		})
	}))
	defer srv.Close()

	api, err := newAPIClient(srv.URL)
	if err != nil {
		t.Fatalf("newAPIClient: %v", err)
	}
	st, err := api.AuthStatus(context.Background())
	if err != nil {
		t.Fatalf("AuthStatus: %v", err)
	}
	if st.Enabled {
		t.Fatalf("expected disabled")
	}
}

// TestAPIClientLoginSendsProof pins the {challenge, proof}
// body and the cookie jar round-trip.
func TestAPIClientLoginSendsProof(t *testing.T) {
	password := "pw-1234"
	salt := []byte("0123456789abcdef")
	iters := 1000
	challenge := "challenge-token"
	verifier := pbkdf2.Key([]byte(password), salt, iters, 32, sha256.New)
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte(challenge))
	proof := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/status":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enabled":       true,
				"authenticated": false,
				"version":       "v1",
				"algorithm":     "pbkdf2-sha256",
				"iterations":    iters,
				"salt":          base64.RawURLEncoding.EncodeToString(salt),
				"challenge":     challenge,
			})
		case "/api/auth/login":
			body, _ := io.ReadAll(r.Body)
			var req map[string]string
			if err := json.Unmarshal(body, &req); err != nil {
				http.Error(w, "bad", 400)
				return
			}
			if req["challenge"] != challenge || req["proof"] != proof {
				http.Error(w, "bad proof", 401)
				return
			}
			http.SetCookie(w, &http.Cookie{
				Name:  "phi_access_session",
				Value: "session-token",
				Path:  "/",
			})
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	api, err := newAPIClient(srv.URL)
	if err != nil {
		t.Fatalf("newAPIClient: %v", err)
	}
	st, err := api.AuthStatus(context.Background())
	if err != nil {
		t.Fatalf("AuthStatus: %v", err)
	}
	if !st.Enabled {
		t.Fatalf("expected enabled")
	}
	if err := api.Login(context.Background(), st, password); err != nil {
		t.Fatalf("Login: %v", err)
	}
	u, _ := url.Parse(srv.URL)
	cookies := api.http.Jar.Cookies(u)
	for _, c := range cookies {
		if c.Name == "phi_access_session" && c.Value == "session-token" {
			return
		}
	}
	t.Fatalf("session cookie not stored: %v", cookies)
}

// TestDeriveVerifierMatchesPBKDF2 is the unit-level proof
// that deriveVerifier uses the advertised KDF.
func TestDeriveVerifierMatchesPBKDF2(t *testing.T) {
	pw := "x"
	salt := []byte("y")
	got, err := deriveVerifier(pw, salt, "pbkdf2-sha256", 10)
	if err != nil {
		t.Fatalf("deriveVerifier: %v", err)
	}
	want := pbkdf2.Key([]byte(pw), salt, 10, 32, sha256.New)
	if !bytes.Equal(got, want) {
		t.Fatalf("verifier mismatch")
	}
	if _, err := deriveVerifier(pw, salt, "scrypt", 1); err == nil {
		t.Fatalf("expected error on bad algorithm")
	}
}
