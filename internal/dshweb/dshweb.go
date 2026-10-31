// Package dshweb owns the DeepSeek Harness Web preview: one child process
// per opted-in Phi server, an authenticated loopback carrier, and their
// lifetime. Launch parameters come from Phi startup config only, never
// from browser input.
package dshweb

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Preview states served by /api/dsh/status.
const (
	StateDisabled    = "disabled"
	StateStarting    = "starting"
	StateReady       = "ready"
	StateUnavailable = "unavailable"
	StateStopped     = "stopped"
)

// Fixed sanitized reason codes. Never child output or paths.
const (
	ReasonNone            = ""
	ReasonInvalidConfig   = "invalid-config"
	ReasonUnsupported     = "unsupported-platform"
	ReasonSpawnFailed     = "spawn-failed"
	ReasonStartupTimeout  = "startup-timeout"
	ReasonBadAnnouncement = "bad-announcement"
	ReasonOutputOverflow  = "output-overflow"
	ReasonNotReady        = "not-ready"
	ReasonChildExited     = "child-exited"
	ReasonStopped         = "stopped"
)

// Status is the browser-facing preview snapshot. Mount is set only when
// State is ready.
type Status struct {
	Enabled bool
	State   string
	Mount   string
	Reason  string
}

// Origin is one validated, normalized DSH preview origin.
type Origin struct {
	Scheme    string // http or https
	Hostname  string // lowercased, no brackets
	Port      int    // effective port
	Authority string // host[:port] for Host matching and cookie derivation
}

// String returns the canonical origin form scheme://authority.
func (o Origin) String() string {
	return o.Scheme + "://" + o.Authority
}

// Secure reports whether the configured origin uses HTTPS.
func (o Origin) Secure() bool {
	return o.Scheme == "https"
}

// ParseOrigin validates one explicit preview origin. It rejects
// credentials, an empty host, non-HTTP(S) schemes, non-root paths,
// queries, and fragments.
func ParseOrigin(raw string) (Origin, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return Origin{}, err
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return Origin{}, errors.New("dshweb: origin must use http or https")
	}
	if u.User != nil {
		return Origin{}, errors.New("dshweb: origin must not carry credentials")
	}
	if u.Host == "" {
		return Origin{}, errors.New("dshweb: origin must have a host")
	}
	if u.Path != "" && u.Path != "/" {
		return Origin{}, errors.New("dshweb: origin must have a root path")
	}
	if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return Origin{}, errors.New("dshweb: origin must not carry a query or fragment")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return Origin{}, errors.New("dshweb: origin must have a host")
	}
	port := u.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return Origin{}, errors.New("dshweb: origin has an invalid port")
	}
	display := host
	if strings.Contains(display, ":") {
		display = "[" + display + "]"
	}
	if !isDefaultPort(scheme, n) {
		display += ":" + strconv.Itoa(n)
	}
	return Origin{Scheme: scheme, Hostname: host, Port: n, Authority: display}, nil
}

func isDefaultPort(scheme string, port int) bool {
	return (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
}

// MatchHost reports whether a browser Host header names this origin.
// Comparison is by lowercased hostname plus effective port, so an
// explicit default port matches its bare form.
func (o Origin) MatchHost(hostport string) bool {
	host, port := splitHostPort(hostport)
	if host == "" {
		return false
	}
	if !strings.EqualFold(host, o.Hostname) {
		return false
	}
	if port == "" {
		if o.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		return false
	}
	return n == o.Port
}

// MatchOrigin reports whether a browser Origin header equals this origin.
func (o Origin) MatchOrigin(origin string) bool {
	parsed, err := ParseOrigin(origin)
	if err != nil {
		return false
	}
	return parsed.String() == o.String()
}

func splitHostPort(hostport string) (host, port string) {
	if h, p, err := net.SplitHostPort(hostport); err == nil {
		return h, p
	}
	// No port, or a bare IPv6 literal. net.SplitHostPort rejects both.
	if strings.Count(hostport, ":") > 1 {
		return strings.Trim(hostport, "[]"), ""
	}
	if i := strings.LastIndex(hostport, ":"); i >= 0 {
		return hostport[:i], hostport[i+1:]
	}
	return hostport, ""
}

// CookieName derives the expected DSH browser-session cookie name for a
// browser Host under the pinned DSH authority rule: "dsh-auth-" plus
// base64url(sha256(authority)), where an HTTP authority is the normalized
// host and an HTTPS authority is the full origin.
func CookieName(scheme, browserHost string) (string, error) {
	if scheme != "http" && scheme != "https" {
		return "", errors.New("dshweb: cookie scheme must be http or https")
	}
	u, err := url.Parse(scheme + "://" + browserHost)
	if err != nil {
		return "", err
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("dshweb: cookie host is empty")
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	port := u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	authority := host
	if port != "" {
		authority += ":" + port
	}
	if scheme == "https" {
		authority = "https://" + authority
	}
	sum := sha256.Sum256([]byte(authority))
	return "dsh-auth-" + base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// Clock supplies time for startup bounds and session-expiry timers.
// Tests inject a fake; production uses systemClock.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
	AfterFunc(d time.Duration, fn func()) Timer
}

// Timer is a stoppable clock timer.
type Timer interface {
	Stop() bool
}

type systemClock struct{}

func (systemClock) Now() time.Time                         { return time.Now() }
func (systemClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (systemClock) AfterFunc(d time.Duration, fn func()) Timer {
	return time.AfterFunc(d, fn)
}

// SystemClock is the production Clock.
func SystemClock() Clock { return systemClock{} }
