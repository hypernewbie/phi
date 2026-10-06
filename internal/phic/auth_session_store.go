package phic

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const accessSessionCookieName = "phi_access_session"

// Only the server-issued session is persisted, never a password or verifier.
// This is an owner-only token file, not encryption or an OS credential store.
type sessionPersistence struct{ dir string }
type storedAccessSession struct {
	Version int         `json:"version"`
	Origin  string      `json:"origin"`
	Cookie  http.Cookie `json:"cookie"`
}

func newSessionPersistence(profiles string) *sessionPersistence {
	dir := filepath.Join(filepath.Dir(profiles), "phic-access-sessions")
	return &sessionPersistence{dir: dir}
}
func (p *sessionPersistence) file(origin string) string {
	return filepath.Join(p.dir, fmt.Sprintf("%x.session", sha256.Sum256([]byte(origin))))
}
func (p *sessionPersistence) privateDir(create bool) error {
	st, err := os.Lstat(p.dir)
	if errors.Is(err, os.ErrNotExist) && create {
		if err = os.MkdirAll(p.dir, 0700); err != nil {
			return err
		}
		st, err = os.Lstat(p.dir)
	}
	if err != nil {
		return err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return errors.New("session directory is not a real directory")
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0 {
		return errors.New("session directory must be owner-only (0700)")
	}
	return nil
}
func sessionExpiry(c http.Cookie) time.Time {
	if !c.Expires.IsZero() {
		return c.Expires
	}
	// Phi's signed cookie carries its expiry as nonce.expiry.signature.
	fields := strings.Split(c.Value, ".")
	if len(fields) == 3 {
		if n, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
			return time.Unix(n, 0)
		}
	}
	return time.Time{}
}
func validRememberedCookie(origin string, c http.Cookie) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return c.Name == accessSessionCookieName && c.Value != "" && len(c.Value) <= 4096 && c.HttpOnly && c.Path == "/" && c.Domain == "" && c.MaxAge >= 0 && (!c.Secure || u.Scheme == "https") && sessionExpiry(c).After(time.Now())
}
func (p *sessionPersistence) save(origin string, c http.Cookie) error {
	if !validRememberedCookie(origin, c) {
		return errors.New("server did not provide a persistable access session")
	}
	// Persist only needed attributes, not Raw/Unparsed response headers.
	c = http.Cookie{Name: c.Name, Value: c.Value, Path: "/", HttpOnly: true, Secure: c.Secure, SameSite: c.SameSite, Expires: sessionExpiry(c)}
	// Absolute expiry is retained; MaxAge cannot restart its countdown.
	plain, err := json.Marshal(storedAccessSession{Version: 1, Origin: origin, Cookie: c})
	if err != nil {
		return err
	}
	if err = p.privateDir(true); err != nil {
		return err
	}
	f, err := os.CreateTemp(p.dir, ".session-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(plain)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, p.file(origin)); err != nil {
		return err
	}
	return nil
}
func (p *sessionPersistence) load(origin string) (*http.Cookie, error) {
	if err := p.privateDir(false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	st, err := os.Lstat(p.file(origin))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || (runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0) || st.Size() > 64<<10 {
		return nil, errors.New("unsafe access-session file")
	}
	plain, err := os.ReadFile(p.file(origin))
	if err != nil {
		return nil, err
	}
	var v storedAccessSession
	if json.Unmarshal(plain, &v) != nil || v.Version != 1 || v.Origin != origin {
		return nil, errors.New("invalid access-session identity")
	}
	if !validRememberedCookie(origin, v.Cookie) {
		return nil, nil
	}
	return &v.Cookie, nil
}
func (p *sessionPersistence) remove(origin string) error {
	if err := p.privateDir(false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	err := os.Remove(p.file(origin))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
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
	c, err := p.load(a.base.String())
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
		if err := a.remember.save(a.base.String(), *c); err != nil {
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
	if err := a.remember.remove(a.base.String()); err != nil {
		a.rememberError = err.Error()
	}
	a.http.Jar.SetCookies(a.base, []*http.Cookie{{Name: accessSessionCookieName, Path: "/", MaxAge: -1}})
}
func (a *apiClient) rememberWarning() string {
	a.rememberMu.Lock()
	defer a.rememberMu.Unlock()
	return a.rememberError
}
