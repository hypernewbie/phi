package phiaccess

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
	"time"
)

// AccessSessionCookieName is the server-issued access-session cookie.
// phic and phi-cmd both store and replay exactly this cookie.
const AccessSessionCookieName = "phi_access_session"

// SessionStore persists the server-issued access-session cookie next to
// the profiles document (phic-access-sessions/). Only the server-issued
// session is persisted, never a password or verifier: an owner-only
// token file, not encryption or an OS credential store. phic and
// phi-cmd share one store so a login in either is a login in both.
type SessionStore struct{ dir string }

type storedAccessSession struct {
	Version int         `json:"version"`
	Origin  string      `json:"origin"`
	Cookie  http.Cookie `json:"cookie"`
}

// NewSessionStore places the store beside the profiles document, the
// same rule phic has always used.
func NewSessionStore(profiles string) *SessionStore {
	return &SessionStore{dir: filepath.Join(filepath.Dir(profiles), "phic-access-sessions")}
}

// Dir is the store directory (owner-only). Exposed for clients that
// need to reason about the store location itself.
func (p *SessionStore) Dir() string { return p.dir }

func (p *SessionStore) file(origin string) string {
	return filepath.Join(p.dir, fmt.Sprintf("%x.session", sha256.Sum256([]byte(origin))))
}

func (p *SessionStore) privateDir(create bool) error {
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

// ValidRememberedCookie reports whether a cookie may be persisted and
// replayed for this origin.
func ValidRememberedCookie(origin string, c http.Cookie) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return c.Name == AccessSessionCookieName && c.Value != "" && len(c.Value) <= 4096 && c.HttpOnly && c.Path == "/" && c.Domain == "" && c.MaxAge >= 0 && (!c.Secure || u.Scheme == "https") && sessionExpiry(c).After(time.Now())
}

// Save persists a server-issued session atomically (temp file + rename).
func (p *SessionStore) Save(origin string, c http.Cookie) error {
	if !ValidRememberedCookie(origin, c) {
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

// Load returns the remembered cookie for an origin, or nil when none is
// valid. An unsafe or corrupt store is an error, never a silent ignore.
func (p *SessionStore) Load(origin string) (*http.Cookie, error) {
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
	if !ValidRememberedCookie(origin, v.Cookie) {
		return nil, nil
	}
	return &v.Cookie, nil
}

// Remove drops a remembered session (used on explicit logout/401).
func (p *SessionStore) Remove(origin string) error {
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
