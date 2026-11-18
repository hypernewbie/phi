package phiaccess

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func rememberCookie() http.Cookie {
	return http.Cookie{Name: accessSessionCookieName, Value: fmt.Sprintf("nonce.%d.signature", time.Now().Add(time.Hour).Unix()), HttpOnly: true, Path: "/", Expires: time.Now().Add(time.Hour)}
}

func storeFile(p *SessionStore, origin string) string {
	return filepath.Join(p.Dir(), fmt.Sprintf("%x.session", sha256.Sum256([]byte(origin))))
}

func TestRememberedSessionOriginPermissionsExpiryAndBadData(t *testing.T) {
	p := NewSessionStore(filepath.Join(t.TempDir(), "profiles.json"))
	origin := "http://localhost:7070"
	c := rememberCookie()
	if err := p.Save(origin, c); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(p.Dir())
		f, _ := os.Stat(storeFile(p, origin))
		if st.Mode().Perm() != 0700 || f.Mode().Perm() != 0600 {
			t.Fatal("credentials were not owner-only")
		}
	}
	for _, other := range []string{"http://localhost:7071", "https://localhost:7070", "http://127.0.0.1:7070"} {
		got, err := p.Load(other)
		if err != nil || got != nil {
			t.Fatalf("origin leak %s: %+v %v", other, got, err)
		}
	}
	raw, _ := os.ReadFile(storeFile(p, origin))
	if strings.Contains(string(raw), "secret password") {
		t.Fatal("saved password")
	}
	other := "http://localhost:7071"
	os.WriteFile(storeFile(p, other), raw, 0600)
	if _, err := p.Load(other); err == nil {
		t.Fatal("accepted an origin-swapped credential file")
	}
	expired := storedAccessSession{Version: 1, Origin: origin, Cookie: c}
	expired.Cookie.Expires = time.Now().Add(-time.Hour)
	data, _ := json.Marshal(expired)
	os.WriteFile(storeFile(p, origin), data, 0600)
	if got, err := p.Load(origin); err != nil || got != nil {
		t.Fatalf("loaded expired token: %+v %v", got, err)
	}
	os.WriteFile(storeFile(p, origin), []byte("corrupt"), 0600)
	if _, err := p.Load(origin); err == nil {
		t.Fatal("accepted corrupt session")
	}
	if runtime.GOOS != "windows" {
		os.Chmod(storeFile(p, origin), 0644)
		if _, err := p.Load(origin); err == nil {
			t.Fatal("accepted public credential file")
		}
	}
}
