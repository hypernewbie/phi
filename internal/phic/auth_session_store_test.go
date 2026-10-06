package phic

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

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
	if _, err = os.Stat(p.file(server.URL)); !os.IsNotExist(err) {
		t.Fatal("confirmed rejection did not clear the saved token")
	}
}
func TestRememberedSessionOriginPermissionsExpiryAndBadData(t *testing.T) {
	p := isolatedSessionStore(t)
	origin := "http://localhost:7070"
	c := rememberCookie()
	if err := p.save(origin, c); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(p.dir)
		f, _ := os.Stat(p.file(origin))
		if st.Mode().Perm() != 0700 || f.Mode().Perm() != 0600 {
			t.Fatal("credentials were not owner-only")
		}
	}
	for _, other := range []string{"http://localhost:7071", "https://localhost:7070", "http://127.0.0.1:7070"} {
		got, err := p.load(other)
		if err != nil || got != nil {
			t.Fatalf("origin leak %s: %+v %v", other, got, err)
		}
	}
	raw, _ := os.ReadFile(p.file(origin))
	if strings.Contains(string(raw), "secret password") {
		t.Fatal("saved password")
	}
	other := "http://localhost:7071"
	os.WriteFile(p.file(other), raw, 0600)
	if _, err := p.load(other); err == nil {
		t.Fatal("accepted an origin-swapped credential file")
	}
	expired := storedAccessSession{Version: 1, Origin: origin, Cookie: c}
	expired.Cookie.Expires = time.Now().Add(-time.Hour)
	data, _ := json.Marshal(expired)
	os.WriteFile(p.file(origin), data, 0600)
	if got, err := p.load(origin); err != nil || got != nil {
		t.Fatalf("loaded expired token: %+v %v", got, err)
	}
	os.WriteFile(p.file(origin), []byte("corrupt"), 0600)
	if _, err := p.load(origin); err == nil {
		t.Fatal("accepted corrupt session")
	}
	if runtime.GOOS != "windows" {
		os.Chmod(p.file(origin), 0644)
		if _, err := p.load(origin); err == nil {
			t.Fatal("accepted public credential file")
		}
	}
}
func TestRememberedSessionRefusesSymlinkDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission/symlink contract")
	}
	p := isolatedSessionStore(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, p.dir); err != nil {
		t.Fatal(err)
	}
	if err := p.save("http://example.com:7070", rememberCookie()); err == nil {
		t.Fatal("saved a credential through a directory symlink")
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("session write escaped its private directory")
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
	if err := p.save(s.URL, rememberCookie()); err != nil {
		t.Fatal(err)
	}
	a, _ := newAPIClient(s.URL)
	a.enableRememberedSession(p)
	if _, err := a.AuthStatus(context.Background()); err == nil {
		t.Fatal("expected outage")
	}
	if _, err := os.Stat(p.file(s.URL)); err != nil {
		t.Fatal("an outage erased remembered login")
	}
}
