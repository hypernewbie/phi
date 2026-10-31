package dshweb

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

const (
	// dialTimeout bounds loopback dials for proxy and bootstrap legs.
	dialTimeout = 3 * time.Second
	// responseHeaderTimeout bounds upstream response headers. Streams
	// carry no whole-response deadline and are never retried or replayed.
	responseHeaderTimeout = 15 * time.Second
	// fixedProxyError is the only body the carrier serves for upstream
	// failures. It never carries URLs, tokens, or child output.
	fixedProxyError = "dsh unavailable"
)

var (
	errBadHost      = errors.New("dshweb: request host does not match the configured origin")
	errBadOrigin    = errors.New("dshweb: request origin does not match the configured origin")
	errCrossSite    = errors.New("dshweb: cross-site request refused")
	errTokenQuery   = errors.New("dshweb: token query parameters are rejected")
	errStaleLease   = errors.New("dshweb: auth lease is stale")
	errNotReady     = errors.New("dshweb: service is not ready")
	errRedirectLeap = errors.New("dshweb: upstream redirect leaves the mount")
)

// newLoopbackTransport builds the dedicated carrier transport: proxy
// discovery disabled, loopback literals only, bounded dial and response
// headers, no streaming deadline.
func newLoopbackTransport() http.RoundTripper {
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.Proxy = func(*http.Request) (*url.URL, error) { return nil, nil }
	base.DialContext = loopbackDialer{dialer: &net.Dialer{Timeout: dialTimeout}}.DialContext
	base.ResponseHeaderTimeout = responseHeaderTimeout
	base.ForceAttemptHTTP2 = false
	return base
}

type loopbackDialer struct {
	dialer *net.Dialer
}

func (d loopbackDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, errors.New("dshweb: upstream must be a loopback literal")
	}
	return d.dialer.DialContext(ctx, network, addr)
}

// CheckCarrierRequest enforces the carrier contract: configured Host,
// exact Origin for upgrades and non-GET/HEAD, same-origin-or-absent
// Origin for GET/HEAD, no cross-site fetch metadata, no token query.
func CheckCarrierRequest(r *http.Request, origin Origin) error {
	if !origin.MatchHost(r.Host) {
		return errBadHost
	}
	if r.URL.Query().Has("token") {
		return errTokenQuery
	}
	upgrading := IsUpgrade(r)
	if upgrading || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		if !origin.MatchOrigin(r.Header.Get("Origin")) {
			return errBadOrigin
		}
	} else if o := r.Header.Get("Origin"); o != "" && !origin.MatchOrigin(o) {
		return errBadOrigin
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return errCrossSite
	}
	return nil
}

// IsUpgrade reports whether the request asks for a WebSocket upgrade.
func IsUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, part := range strings.Split(strings.ToLower(r.Header.Get("Connection")), ",") {
		if strings.TrimSpace(part) == "upgrade" {
			return true
		}
	}
	return false
}

// SplitMount splits a mount path into its instance segment and remainder.
// The remainder keeps its leading slash; a bare mount yields "".
func SplitMount(path string) (instance, rest string, ok bool) {
	rest, ok = strings.CutPrefix(path, "/api/dsh/")
	if !ok {
		return "", "", false
	}
	if i := strings.Index(rest, "/"); i >= 0 {
		return rest[:i], rest[i:], true
	}
	return rest, "", true
}

// FilterUpstreamCookie returns the single DSH cookie value to forward.
// ok is false when conflicting duplicate DSH cookies are present.
func FilterUpstreamCookie(r *http.Request, expected string) (value string, present bool, ok bool) {
	for _, c := range r.Cookies() {
		if c.Name != expected {
			continue
		}
		if present && value != c.Value {
			return "", true, false
		}
		value, present = c.Value, true
	}
	return value, present, true
}

type liveWorkKey struct{}

// ContextWithLiveWork stores the admitted work for the upgrade recheck.
func ContextWithLiveWork(ctx context.Context, w *liveWork) context.Context {
	return context.WithValue(ctx, liveWorkKey{}, w)
}

func liveWorkFrom(ctx context.Context) *liveWork {
	w, _ := ctx.Value(liveWorkKey{}).(*liveWork)
	return w
}

// newDSHProxy builds the per-generation carrier. The director strips the
// mount prefix exactly once and preserves the browser-facing Host and
// Origin. Errors are fixed; the raw proxy log is discarded.
func newDSHProxy(upstream *url.URL, mount string, origin Origin, live *liveRegistry, transport http.RoundTripper) *httputil.ReverseProxy {
	prefix := strings.TrimSuffix(mount, "/")
	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = upstream.Scheme
			req.URL.Host = upstream.Host
			req.URL.Path = strings.TrimPrefix(req.URL.Path, prefix)
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}
			req.URL.RawPath = ""
			// req.Host and Origin pass through untouched: DSH binds its
			// session cookie to the browser-facing authority.
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, fixedProxyError, http.StatusBadGateway)
		},
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Set("Cache-Control", "no-store")
			expected, err := CookieName(origin.Scheme, resp.Request.Host)
			if err != nil {
				return err
			}
			if err := rewriteSetCookies(resp, expected, mount, origin.Secure()); err != nil {
				return err
			}
			if resp.StatusCode == http.StatusSwitchingProtocols {
				if w := liveWorkFrom(resp.Request.Context()); w != nil && live.Stale(w) {
					return errStaleLease
				}
				return nil
			}
			if resp.StatusCode >= 300 && resp.StatusCode < 400 {
				return rewriteRedirect(resp, upstream, mount)
			}
			return nil
		},
	}
	return proxy
}

// rewriteSetCookies keeps only the expected DSH cookie, scopes its Path
// to the mount, and drops Domain. It never widens the Path.
func rewriteSetCookies(resp *http.Response, expected, mount string, secure bool) error {
	cookies := resp.Cookies()
	resp.Header.Del("Set-Cookie")
	var value string
	var found bool
	for _, c := range cookies {
		if c.Name != expected {
			continue
		}
		if found {
			if c.Value != value {
				return errNotReady
			}
			continue
		}
		value, found = c.Value, true
		out := &http.Cookie{
			Name:     c.Name,
			Value:    c.Value,
			Path:     mount,
			MaxAge:   c.MaxAge,
			Expires:  c.Expires,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteStrictMode,
		}
		resp.Header.Add("Set-Cookie", out.String())
	}
	return nil
}

// rewriteRedirect resolves an upstream redirect against the request URL
// and rewrites verified same-upstream destinations into the mount.
// External, scheme-relative escape, traversal, and token-bearing
// destinations fail with a fixed error.
func rewriteRedirect(resp *http.Response, upstream *url.URL, mount string) error {
	loc := resp.Header.Get("Location")
	if loc == "" {
		return nil
	}
	// Inspect the raw value first: URL parsing cleans dot segments away.
	rawPath := loc
	if i := strings.IndexAny(rawPath, "?#"); i >= 0 {
		rawPath = rawPath[:i]
	}
	lowerPath := strings.ToLower(rawPath)
	for _, encoded := range []string{"%25", "%2f", "%5c", "%2e"} {
		if strings.Contains(lowerPath, encoded) {
			return errRedirectLeap
		}
	}
	decodedPath, err := url.PathUnescape(rawPath)
	if err != nil || strings.ContainsAny(decodedPath, "\\\r\n") {
		return errRedirectLeap
	}
	for _, seg := range strings.Split(decodedPath, "/") {
		if seg == ".." {
			return errRedirectLeap
		}
	}
	dest, err := resp.Request.URL.Parse(loc)
	if err != nil {
		return errRedirectLeap
	}
	if dest.Scheme != upstream.Scheme || dest.Host != upstream.Host {
		return errRedirectLeap
	}
	if dest.Query().Has("token") {
		return errRedirectLeap
	}
	// Emit the verified escaped form verbatim. Routing dest.Path
	// through RequestURI would escape it a second time (% -> %25),
	// breaking any upstream redirect with encoded characters and
	// tripping the path guard when the browser follows it.
	out := mount + strings.TrimPrefix(dest.EscapedPath(), "/")
	if dest.RawQuery != "" {
		out += "?" + dest.RawQuery
	}
	if dest.Fragment != "" {
		out += "#" + dest.EscapedFragment()
	}
	resp.Header.Set("Location", out)
	return nil
}

// BootstrapExchange performs the private launch-token exchange for one
// admitted mount-root GET without a DSH cookie. It uses the dedicated
// uninstrumented transport, preserves the browser-facing Host, and
// returns only the minted cookie. Failures are fixed and token-free.
func (s *Service) BootstrapExchange(ctx context.Context, browserHost string) (*http.Cookie, error) {
	s.mu.Lock()
	upstream, token, instance, ready := s.upstream, s.token, s.instance, s.status.State == StateReady && s.upstream != nil && s.token != ""
	origin := s.origin
	s.mu.Unlock()
	if !ready {
		return nil, errNotReady
	}
	expected, err := CookieName(origin.Scheme, browserHost)
	if err != nil {
		return nil, errBadHost
	}
	u := *upstream
	u.Path = "/"
	u.RawQuery = url.Values{"token": {token}}.Encode()
	// Bootstrap is a bounded exchange, not a stream. Its body is never
	// consumed: a child that stalls after sending headers cannot hold it.
	ctx, cancel := context.WithTimeout(ctx, responseHeaderTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, errNotReady
	}
	req.Host = browserHost
	resp, err := s.transport.RoundTrip(req)
	if err != nil {
		return nil, errNotReady
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSeeOther || rewriteRedirect(resp, upstream, "/api/dsh/"+instance+"/") != nil {
		return nil, errNotReady
	}
	s.mu.Lock()
	stillReady := s.status.State == StateReady && s.instance == instance
	s.mu.Unlock()
	if !stillReady || ctx.Err() != nil {
		return nil, errNotReady
	}
	var value string
	var found bool
	for _, c := range resp.Cookies() {
		if c.Name == expected {
			if found && c.Value != value {
				return nil, errNotReady
			}
			value, found = c.Value, true
		}
	}
	for _, c := range resp.Cookies() {
		if c.Name != expected {
			continue
		}
		return &http.Cookie{
			Name:     c.Name,
			Value:    c.Value,
			Path:     "/api/dsh/" + instance + "/",
			MaxAge:   c.MaxAge,
			Expires:  c.Expires,
			HttpOnly: true,
			Secure:   origin.Secure(),
			SameSite: http.SameSiteStrictMode,
		}, nil
	}
	return nil, errNotReady
}

// trackHijacker records hijacked connections for revocation while
// preserving the streaming flush behavior.
type trackHijacker struct {
	http.ResponseWriter
	onHijack func(net.Conn)
}

func (t *trackHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := t.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("dshweb: hijack unsupported")
	}
	conn, rw, err := h.Hijack()
	if err == nil && t.onHijack != nil {
		t.onHijack(conn)
	}
	return conn, rw, err
}

func (t *trackHijacker) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// WatchHijack wraps the response writer so hijacked upgrade connections
// register for revocation. A connection admitted under a stale lease
// closes immediately instead of registering.
func (reg *liveRegistry) WatchHijack(w http.ResponseWriter, work *liveWork) http.ResponseWriter {
	return &trackHijacker{
		ResponseWriter: w,
		onHijack: func(conn net.Conn) {
			if !reg.SetConn(work, conn) {
				_ = conn.Close()
			}
		},
	}
}
