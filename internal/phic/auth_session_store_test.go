package phic

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func storeFile(p *sessionPersistence, origin string) string {
	return filepath.Join(p.Dir(), fmt.Sprintf("%x.session", sha256.Sum256([]byte(origin))))
}

func isolatedSessionStore(t *testing.T) *sessionPersistence {
	t.Helper()
	p := newSessionPersistence(filepath.Join(t.TempDir(), "profiles.json"))
	return p
}
func rememberCookie() http.Cookie {
	return http.Cookie{Name: accessSessionCookieName, Value: fmt.Sprintf("nonce.%d.signature", time.Now().Add(time.Hour).Unix()), HttpOnly: true, Path: "/", Expires: time.Now().Add(time.Hour)}
}
func TestRememberedSessionSurvivesNewClientAndRotation(t *testing.T) {
	p := isolatedSessionStore(t)
	token := rememberCookie()
	var revoked atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			http.SetCookie(w, &token)
			json.NewEncoder(w).Encode(loginResponse{OK: true})
		case "/api/auth/status":
			c, _ := r.Cookie(accessSessionCookieName)
			json.NewEncoder(w).Encode(authStatus{Enabled: true, Authenticated: c != nil && c.Value == token.Value && !revoked.Load(), Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 1, Salt: "c2FsdA", Challenge: "challenge"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a, _ := newAPIClient(server.URL)
	a.enableRememberedSession(p)
	st, err := a.AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Login(context.Background(), st, "secret password"); err != nil {
		t.Fatal(err)
	}
	if a.rememberWarning() != "" {
		t.Fatal(a.rememberWarning())
	}
	// A genuinely new jar/client represents the next application launch.
	b, _ := newAPIClient(server.URL)
	b.enableRememberedSession(p)
	st, err = b.AuthStatus(context.Background())
	if err != nil || !st.Authenticated {
		t.Fatalf("relaunch prompts again: %+v %v", st, err)
	}
	revoked.Store(true)
	st, err = b.AuthStatus(context.Background())
	if err != nil || st.Authenticated {
		t.Fatal("revoked token still accepted")
	}
	if _, err = os.Stat(storeFile(p, server.URL)); !os.IsNotExist(err) {
		t.Fatal("confirmed rejection did not clear the saved token")
	}
}
func TestRememberedSessionJarDoesNotCrossPortsOrSchemes(t *testing.T) {
	a, _ := newAPIClient("http://example.com:7070")
	a.enableRememberedSession(isolatedSessionStore(t))
	c := rememberCookie()
	a.http.Jar.SetCookies(a.base, []*http.Cookie{&c})
	for _, origin := range []string{"http://example.com:7071", "https://example.com:7070", "http://other.example.com:7070"} {
		u, _ := url.Parse(origin)
		if len(a.http.Jar.Cookies(u)) != 0 {
			t.Fatal("jar leaked credentials to " + origin)
		}
	}
}
func TestRememberedSessionNetworkFailureDoesNotForgetLogin(t *testing.T) {
	p := isolatedSessionStore(t)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "unavailable", 503) }))
	defer s.Close()
	if err := p.Save(s.URL, rememberCookie()); err != nil {
		t.Fatal(err)
	}
	a, _ := newAPIClient(s.URL)
	a.enableRememberedSession(p)
	if _, err := a.AuthStatus(context.Background()); err == nil {
		t.Fatal("expected outage")
	}
	if _, err := os.Stat(storeFile(p, s.URL)); err != nil {
		t.Fatal("an outage erased remembered login")
	}
}
