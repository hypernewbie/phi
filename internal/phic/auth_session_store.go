package phic

import (
	"net/http"
	"net/url"
	"sync"

	"github.com/hypernewbie/phi/internal/phiaccess"
)

const accessSessionCookieName = "phi_access_session"

// Only the server-issued session is persisted, never a password or
// verifier. An owner-only token file, not encryption or an OS
// credential store. The store itself lives in internal/phiaccess so
// phi-cmd shares it: a login in either client is a login in both.
type sessionPersistence = phiaccess.SessionStore

func newSessionPersistence(profiles string) *sessionPersistence {
	return phiaccess.NewSessionStore(profiles)
}

// Wrap the jar only for production console clients. Tests and transport-only
// callers remain in-memory unless they explicitly supply an isolated store.
type rememberingJar struct {
	http.CookieJar
	origin  string
	mu      sync.Mutex
	session *http.Cookie
}

func (j *rememberingJar) Cookies(u *url.URL) []*http.Cookie {
	if u.Scheme+"://"+u.Host != j.origin {
		return nil
	}
	return j.CookieJar.Cookies(u)
}
func (j *rememberingJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	if u.Scheme+"://"+u.Host != j.origin {
		return
	}
	j.CookieJar.SetCookies(u, cookies)
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, c := range cookies {
		if c.Name == accessSessionCookieName {
			copy := *c
			j.session = &copy
		}
	}
}
func (j *rememberingJar) copySession() *http.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.session == nil {
		return nil
	}
	c := *j.session
	return &c
}
func (a *apiClient) enableRememberedSession(p *sessionPersistence) {
	a.rememberMu.Lock()
	defer a.rememberMu.Unlock()
	if p == nil || a.remember != nil {
		return
	}
	a.remember = p
	j := &rememberingJar{CookieJar: a.http.Jar, origin: a.base.String()}
	a.http.Jar = j
	c, err := p.Load(a.base.String())
	if err != nil {
		a.rememberError = err.Error()
		return
	}
	if c != nil {
		j.SetCookies(a.base, []*http.Cookie{c})
	}
}
func (a *apiClient) saveRememberedSession() {
	a.rememberMu.Lock()
	defer a.rememberMu.Unlock()
	if a.remember == nil {
		return
	}
	j, ok := a.http.Jar.(*rememberingJar)
	if !ok {
		return
	}
	if c := j.copySession(); c != nil {
		if err := a.remember.Save(a.base.String(), *c); err != nil {
			a.rememberError = err.Error()
		} else {
			a.rememberError = ""
		}
	}
}
func (a *apiClient) forgetRememberedSession() {
	a.rememberMu.Lock()
	defer a.rememberMu.Unlock()
	if a.remember == nil {
		return
	}
	if err := a.remember.Remove(a.base.String()); err != nil {
		a.rememberError = err.Error()
	}
	a.http.Jar.SetCookies(a.base, []*http.Cookie{{Name: accessSessionCookieName, Path: "/", MaxAge: -1}})
}
func (a *apiClient) rememberWarning() string {
	a.rememberMu.Lock()
	defer a.rememberMu.Unlock()
	return a.rememberError
}
