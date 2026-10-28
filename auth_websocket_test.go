package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// The production pane, events, and control handlers must each consult the
// access fence themselves: removing an AdmitAuth call from one handler must
// fail a test here, not only a fencer unit test.

func dialAuthSocket(t *testing.T, serverURL, path, subprotocol string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
	conn, _, err := dialer.Dial(
		"ws"+strings.TrimPrefix(serverURL, "http")+path,
		nil,
	)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func expectClosed(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		_ = conn.SetReadDeadline(deadline)
		_, _, err := conn.ReadMessage()
		if err == nil {
			// Frames queued before the close drain first.
			continue
		}
		var netErr interface{ Timeout() bool }
		if errors.As(err, &netErr) && netErr.Timeout() {
			t.Fatal("stale socket stayed open: read timed out")
		}
		return
	}
}

func expectOpen(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, err := conn.ReadMessage()
	var netErr interface{ Timeout() bool }
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("current socket closed or errored: %v", err)
	}
}

func fencedHandler(fence ws.AuthFence, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		next(w, r.WithContext(ws.WithAuthFence(r.Context(), fence)))
	}
}

// expectStillOpen accepts output frames but fails on a close: pane sockets
// stream, so a timeout is the only proof that no close arrived.
func expectStillOpen(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		var netErr interface{ Timeout() bool }
		if errors.As(err, &netErr) && netErr.Timeout() {
			return
		}
		t.Fatalf("socket closed unexpectedly: %v", err)
	}
}

// newAuthSocketServer serves the three client-facing socket routes behind the
// production middleware. Tests that need to control every header dial it
// directly; newAuthSocketFixture wraps it for the credential-only cases.
func newAuthSocketServer(t *testing.T) (*ws.Hub, string) {
	t.Helper()
	hub := testAccessUseHub(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	manager := pty.NewManager()
	t.Cleanup(func() { manager.Shutdown(2 * time.Second) })
	shell, args := testMainShell()
	instance, err := manager.SpawnWithOptions(context.Background(), home, shell, args, "pi", "rotate-sid", pty.SpawnOptions{ID: "rotate-pane"})
	if err != nil {
		t.Fatalf("spawn rotate pane: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/pane/rotate-pane", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, instance, manager, hub)
	})
	mux.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, hub)
	})
	mux.HandleFunc("/ws/control", ws.HandleControl(hub, rpc.NewManager(), func() string { return home }))
	server := httptest.NewServer(accessAuthMiddleware(mux))
	t.Cleanup(server.Close)

	return hub, "ws" + strings.TrimPrefix(server.URL, "http")
}

// newAuthSocketFixture serves the same three routes and returns a dialer that
// carries one credential: a v2 query token or a v1 cookie, never both.
func newAuthSocketFixture(t *testing.T) (*ws.Hub, func(path, subprotocol, token, cookie string) *websocket.Conn) {
	t.Helper()
	hub, socketURL := newAuthSocketServer(t)
	return hub, func(path, subprotocol, token, cookie string) *websocket.Conn {
		t.Helper()
		url := socketURL + path
		if token != "" {
			url += "?token=" + neturl.QueryEscape(token)
		}
		header := http.Header{}
		if cookie != "" {
			header.Set("Cookie", accessSessionCookie+"="+cookie)
		}
		dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
		conn, _, err := dialer.Dial(url, header)
		if err != nil {
			t.Fatalf("dial %s: %v", path, err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	}
}

func TestAccessWSPaneFenceRejectsStaleUpgrade(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	manager := pty.NewManager()
	t.Cleanup(func() { manager.Shutdown(2 * time.Second) })
	shell, args := testMainShell()
	instance, err := manager.SpawnWithOptions(context.Background(), home, shell, args, "pi", "fence-sid", pty.SpawnOptions{ID: "fence-pane"})
	if err != nil {
		t.Fatalf("spawn fence pane: %v", err)
	}
	hub := ws.NewHub(0)
	t.Cleanup(func() { _ = hub.Close() })
	hub.RotateAuth(2)

	stale := httptest.NewServer(fencedHandler(ws.AuthFence{Generation: 1}, func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, instance, manager, hub)
	}))
	defer stale.Close()
	conn := dialAuthSocket(t, stale.URL, "/ws/pane/fence-pane", wireproto.TerminalSubprotocol)
	expectClosed(t, conn)
	if _, ok := hub.LookupPane("fence-pane"); ok {
		t.Fatal("stale pane upgrade registered a client")
	}

	current := httptest.NewServer(fencedHandler(ws.AuthFence{Generation: 2}, func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, instance, manager, hub)
	}))
	defer current.Close()
	conn = dialAuthSocket(t, current.URL, "/ws/pane/fence-pane", wireproto.TerminalSubprotocol)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("current pane upgrade did not attach: %v", err)
	}
	if _, ok := hub.LookupPane("fence-pane"); !ok {
		t.Fatal("current pane upgrade did not register a client")
	}
}

func TestAccessWSEventsFenceRejectsStaleUpgrade(t *testing.T) {
	hub := ws.NewHub(0)
	t.Cleanup(func() { _ = hub.Close() })
	hub.RotateAuth(2)

	stale := httptest.NewServer(fencedHandler(ws.AuthFence{Generation: 1}, func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, hub)
	}))
	defer stale.Close()
	expectClosed(t, dialAuthSocket(t, stale.URL, "/ws/md-events", wireproto.EventsSubprotocol))

	current := httptest.NewServer(fencedHandler(ws.AuthFence{Generation: 2}, func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, hub)
	}))
	defer current.Close()
	expectOpen(t, dialAuthSocket(t, current.URL, "/ws/md-events", wireproto.EventsSubprotocol))
}

func TestAccessWSControlFenceRejectsStaleUpgrade(t *testing.T) {
	hub := ws.NewHub(0)
	t.Cleanup(func() { _ = hub.Close() })
	hub.RotateAuth(2)
	manager := rpc.NewManager()
	handler := func(fence ws.AuthFence) http.HandlerFunc {
		return fencedHandler(fence, ws.HandleControl(hub, manager, func() string { return "" }))
	}

	stale := httptest.NewServer(handler(ws.AuthFence{Generation: 1}))
	defer stale.Close()
	expectClosed(t, dialAuthSocket(t, stale.URL, "/ws/control", wireproto.ControlSubprotocol))

	current := httptest.NewServer(handler(ws.AuthFence{Generation: 2}))
	defer current.Close()
	expectOpen(t, dialAuthSocket(t, current.URL, "/ws/control", wireproto.ControlSubprotocol))
}

// A real password change must close sockets admitted at the previous
// generation on all three routes, through the production middleware, hub,
// and handlers, and the new credential must connect afterwards.
func TestAccessWSHandlersCloseOnPasswordChange(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	_, dial := newAuthSocketFixture(t)
	token := testAccessEnableV2(t, testAccessPassword)

	pane := dial("/ws/pane/rotate-pane", wireproto.TerminalSubprotocol, token, "")
	_ = pane.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := pane.ReadMessage(); err != nil {
		t.Fatalf("pane attach before rotation: %v", err)
	}
	events := dial("/ws/md-events", wireproto.EventsSubprotocol, token, "")
	control := dial("/ws/control", wireproto.ControlSubprotocol, token, "")

	response := testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, token)
	if response.Code != http.StatusOK {
		t.Fatalf("change password: %d %s", response.Code, response.Body.String())
	}
	expectClosed(t, pane)
	expectClosed(t, events)
	expectClosed(t, control)

	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Token == "" {
		t.Fatalf("replacement token: %v %q", err, response.Body.String())
	}
	expectOpen(t, dial("/ws/md-events", wireproto.EventsSubprotocol, body.Token, ""))
}

// Every successful record replacement retires both credential types, so a v1
// cookie socket and a v2 bearer socket must close together. A failed write
// changes nothing and must leave them connected.
func TestAccessWSSocketsFollowEveryRecordChange(t *testing.T) {
	bearer := func(token string) accessCredential {
		return accessCredential{State: accessCredentialPresent, Token: token}
	}
	cases := []struct {
		name    string
		mutate  func(t *testing.T, auth *accessAuthManager, token string)
		changed bool
	}{
		{
			name: "encoded v1 change",
			mutate: func(t *testing.T, auth *accessAuthManager, token string) {
				if _, err := auth.setEncodedPassword(testAccessHash(), bearer(token)); err != nil {
					t.Fatalf("encoded change: %v", err)
				}
			},
			changed: true,
		},
		{
			name: "raw v2 change",
			mutate: func(t *testing.T, auth *accessAuthManager, token string) {
				if _, err := auth.setRawPassword("test-pass-5678", bearer(token)); err != nil {
					t.Fatalf("raw change: %v", err)
				}
			},
			changed: true,
		},
		{
			name: "clear",
			mutate: func(t *testing.T, auth *accessAuthManager, token string) {
				if _, err := auth.clearPassword(bearer(token)); err != nil {
					t.Fatalf("clear: %v", err)
				}
			},
			changed: true,
		},
		{
			name: "failed write",
			mutate: func(t *testing.T, auth *accessAuthManager, token string) {
				previous := writeConfigFile
				writeConfigFile = func(string, []byte, os.FileMode) error { return errors.New("disk full") }
				t.Cleanup(func() { writeConfigFile = previous })
				if _, err := auth.setRawPassword("test-pass-5678", bearer(token)); err == nil {
					t.Fatal("failed write reported success")
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withTempConfig(t)
			auth := useTestAccessAuth(t)
			_, dial := newAuthSocketFixture(t)
			token := testAccessEnableV2(t, testAccessPassword)
			cookie := testAccessCookieFor(t, auth).Value

			pane := dial("/ws/pane/rotate-pane", wireproto.TerminalSubprotocol, "", cookie)
			_ = pane.SetReadDeadline(time.Now().Add(2 * time.Second))
			if _, _, err := pane.ReadMessage(); err != nil {
				t.Fatalf("pane attach: %v", err)
			}
			events := dial("/ws/md-events", wireproto.EventsSubprotocol, "", cookie)
			bearerEvents := dial("/ws/md-events", wireproto.EventsSubprotocol, token, "")
			control := dial("/ws/control", wireproto.ControlSubprotocol, token, "")

			tc.mutate(t, auth, token)
			for _, conn := range []*websocket.Conn{pane, events, bearerEvents, control} {
				if tc.changed {
					expectClosed(t, conn)
				} else {
					expectStillOpen(t, conn)
				}
			}
		})
	}
}

// A stale record rehashed by a successful login is a record replacement: the
// sockets admitted under the old record must close.
func TestAccessWSSocketsCloseOnStaleRecordRehash(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub, dial := newAuthSocketFixture(t)
	if err := auth.configure(testAccessStaleHash(t)); err != nil {
		t.Fatalf("configure stale record: %v", err)
	}
	// Production startup syncs the hub to the configured generation; without
	// this the sockets would be rejected before the rehash could revoke them.
	hub.RotateAuth(auth.accessGeneration())
	cookie := testAccessCookieFor(t, auth).Value
	token := testAccessSignedToken(t, auth)
	events := dial("/ws/md-events", wireproto.EventsSubprotocol, token, "")
	cookieEvents := dial("/ws/md-events", wireproto.EventsSubprotocol, "", cookie)
	// Registration proves admission without a client read, which would leave
	// the Gorilla connection poisoned for the later close check.
	waitForEventsClients(t, hub, 2)

	if _, err := auth.loginPassword(testAccessPassword, "192.0.2.60:1"); err != nil {
		t.Fatalf("rehash login: %v", err)
	}
	expectClosed(t, events)
	expectClosed(t, cookieEvents)
}

// waitForEventsClients polls the hub until the events route has attached the
// expected clients.
func waitForEventsClients(t *testing.T, hub *ws.Hub, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if count, _, _ := hub.PaneStats(ws.EventsPaneID); count >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("events route did not attach %d clients", want)
}

// dialAfterGate dials one fenced route whose handler waits for release after
// the middleware has already authorized the request. The rotation happens in
// that window, so the handler registers with a stale generation.
func dialAfterGate(t *testing.T, serverURL, path, subprotocol, token string) (*websocket.Conn, error) {
	t.Helper()
	url := "ws" + strings.TrimPrefix(serverURL, "http") + path + "?token=" + neturl.QueryEscape(token)
	dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
	conn, _, err := dialer.Dial(url, nil)
	return conn, err
}

func gatedEventsHandler(hub *ws.Hub, gate, release chan struct{}, once *sync.Once) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(gate) })
		<-release
		ws.HandleEventsWS(w, r, hub)
	}
}

func expectRejectedUpgrade(t *testing.T, conn *websocket.Conn, err error) {
	t.Helper()
	if err != nil {
		return // handshake refused before the upgrade
	}
	expectClosed(t, conn)
}

// A request authorized before the first password enable must not register a
// socket after it: the enable advances the generation.
func TestAccessWSLateRegistrationAfterEnableIsRejected(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	hub := testAccessUseHub(t)
	gate, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(accessAuthMiddleware(gatedEventsHandler(hub, gate, release, &once)))
	defer server.Close()

	type result struct {
		conn *websocket.Conn
		err  error
	}
	done := make(chan result, 1)
	go func() {
		conn, err := dialAfterGate(t, server.URL, "/ws/md-events", wireproto.EventsSubprotocol, "")
		done <- result{conn, err}
	}()
	<-gate
	token := testAccessEnableV2(t, testAccessPassword)
	close(release)
	out := <-done
	if out.conn != nil {
		t.Cleanup(func() { _ = out.conn.Close() })
	}
	expectRejectedUpgrade(t, out.conn, out.err)

	// The credential minted by the enable still connects.
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.EventsSubprotocol}}
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/md-events?token=" + neturl.QueryEscape(token)
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("fresh credential after enable: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	expectOpen(t, conn)
}

// The same window after a password rotation must also reject the late
// registration, through the production middleware and handler.
func TestAccessWSLateRegistrationAfterRotationIsRejected(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	hub := testAccessUseHub(t)
	token := testAccessEnableV2(t, testAccessPassword)
	gate, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(accessAuthMiddleware(gatedEventsHandler(hub, gate, release, &once)))
	defer server.Close()

	type result struct {
		conn *websocket.Conn
		err  error
	}
	done := make(chan result, 1)
	go func() {
		conn, err := dialAfterGate(t, server.URL, "/ws/md-events", wireproto.EventsSubprotocol, token)
		done <- result{conn, err}
	}()
	<-gate
	response := testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, token)
	if response.Code != http.StatusOK {
		t.Fatalf("change password: %d %s", response.Code, response.Body.String())
	}
	close(release)
	out := <-done
	if out.conn != nil {
		t.Cleanup(func() { _ = out.conn.Close() })
	}
	expectRejectedUpgrade(t, out.conn, out.err)
}

// --- M1c: admission identity, deadlines, and family revocation ---

// testAccessFamilyOf returns the family a v2 token names.
func testAccessFamilyOf(t *testing.T, auth *accessAuthManager, token string) string {
	t.Helper()
	auth.mu.Lock()
	defer auth.mu.Unlock()
	claims, err := parseAccessJWT(auth.jwtKey, token, time.Now(), 0)
	if err != nil {
		t.Fatalf("parse access token: %v", err)
	}
	return claims.FamilyID
}

// testAccessShortLivedToken mints a token for an existing family that expires
// after lifetime, so a socket deadline can be observed without waiting an hour.
func testAccessShortLivedToken(t *testing.T, auth *accessAuthManager, familyID string, lifetime time.Duration) string {
	t.Helper()
	auth.mu.Lock()
	defer auth.mu.Unlock()
	family, ok := auth.v2.families[familyID]
	if !ok {
		t.Fatalf("family %q is not live", familyID)
	}
	now := time.Now()
	issuedAt := now.Unix()
	expiresAt := now.Add(lifetime).Unix()
	// exp is a whole second: truncating a sub-second lifetime can land on the
	// current second, which is already expired. Round up instead.
	if !time.Unix(expiresAt, 0).After(now) {
		expiresAt = issuedAt + 1
	}
	token, err := formatAccessJWT(auth.jwtKey, issuedAt, expiresAt, family.CurrentAccess.Nonce, accessJWTRevocation{
		RecordID: auth.v2.recordID,
		Epoch:    auth.v2.epoch,
		FamilyID: familyID,
	})
	if err != nil {
		t.Fatalf("sign short-lived token: %v", err)
	}
	return token
}

// testAccessV2LoginOnce logs in and returns the access token and the refresh
// handle of the new family.
func testAccessV2LoginOnce(t *testing.T, password string) (string, string) {
	t.Helper()
	w := testAccessV2LoginRequest(t, password, "192.0.2.61:1")
	if w.Code != http.StatusOK {
		t.Fatalf("v2 login: %d %s", w.Code, w.Body.String())
	}
	var response struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, w, &response)
	if response.Token == "" {
		t.Fatalf("login body = %s", w.Body.String())
	}
	return response.Token, testAccessRefreshHandle(t, w)
}

// Every socket transport must resolve its credential exactly the way the HTTP
// routes do: one explicit v2 token in the query, a v1 cookie as the fallback,
// and no acceptance of a wrong-transport or duplicated credential.
func TestAccessWSCredentialMatrix(t *testing.T) {
	routes := []struct {
		path        string
		subprotocol string
	}{
		{"/ws/md-events", wireproto.EventsSubprotocol},
		{"/ws/control", wireproto.ControlSubprotocol},
		{"/ws/pane/rotate-pane", wireproto.TerminalSubprotocol},
	}
	for _, route := range routes {
		t.Run(route.path, func(t *testing.T) {
			withTempConfig(t)
			auth := useTestAccessAuth(t)
			_, socketURL := newAuthSocketServer(t)
			token := testAccessEnableV2(t, testAccessPassword)
			cookie := testAccessCookieFor(t, auth).Value
			_, handle := testAccessV2LoginOnce(t, testAccessPassword)

			dial := func(headers http.Header, rawQuery string) (*websocket.Conn, error) {
				dialer := websocket.Dialer{Subprotocols: []string{route.subprotocol}}
				conn, response, err := dialer.Dial(socketURL+route.path+rawQuery, headers)
				if err != nil && response != nil && response.StatusCode == http.StatusForbidden {
					return nil, err
				}
				return conn, err
			}
			expectAdmitted := func(conn *websocket.Conn, err error) {
				t.Helper()
				if err != nil {
					t.Fatalf("credential rejected: %v", err)
				}
				t.Cleanup(func() { _ = conn.Close() })
				expectStillOpen(t, conn)
			}
			expectRefused := func(conn *websocket.Conn, err error) {
				t.Helper()
				if conn != nil {
					t.Cleanup(func() { _ = conn.Close() })
					expectClosed(t, conn)
					return
				}
				if err == nil {
					t.Fatal("credential accepted")
				}
			}

			conn, err := dial(nil, "")
			expectRefused(conn, err)

			conn, err = dial(http.Header{"Cookie": {accessSessionCookie + "=" + cookie}}, "")
			expectAdmitted(conn, err)

			conn, err = dial(nil, "?token="+neturl.QueryEscape(token))
			expectAdmitted(conn, err)

			// Same-origin: gorilla compares Origin to the request host, so the
			// socket's own origin must be accepted.
			sameOrigin := http.Header{}
			sameOrigin.Set("Origin", "http://"+strings.TrimPrefix(socketURL, "ws://"))
			conn, err = dial(sameOrigin, "?token="+neturl.QueryEscape(token))
			expectAdmitted(conn, err)

			// One explicit token next to a cookie is bearer priority, not a
			// carrier mix-up: the token decides.
			conn, err = dial(http.Header{"Cookie": {accessSessionCookie + "=" + cookie}}, "?token="+neturl.QueryEscape(token))
			expectAdmitted(conn, err)

			for _, tc := range []struct {
				name    string
				headers http.Header
				query   string
			}{
				{name: "malformed token", query: "?token=not-a-jwt"},
				{name: "empty token", query: "?token="},
				{name: "duplicate token", query: "?token=" + neturl.QueryEscape(token) + "&token=" + neturl.QueryEscape(token)},
				{name: "refresh handle as bearer", query: "?token=" + neturl.QueryEscape(handle)},
				{name: "stale token and valid cookie", query: "?token=not-a-jwt"},
				{name: "foreign origin", query: "?token=" + neturl.QueryEscape(token)},
			} {
				t.Run(tc.name, func(t *testing.T) {
					headers := tc.headers
					if headers == nil {
						headers = http.Header{}
					}
					if tc.name == "foreign origin" {
						headers.Set("Origin", "https://attacker.example")
					}
					conn, err := dial(headers, tc.query)
					expectRefused(conn, err)
				})
			}
		})
	}
}

// A socket admitted with a v2 token closes at its admitted exp - exactly, with
// no HTTP allowance - and a fresh token reconnects afterwards.
func TestAccessWSSocketClosesAtAdmittedExpiry(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub, dial := newAuthSocketFixture(t)
	token := testAccessEnableV2(t, testAccessPassword)
	familyID := testAccessFamilyOf(t, auth, token)

	shortLived := testAccessShortLivedToken(t, auth, familyID, 700*time.Millisecond)
	expiring := dial("/ws/md-events", wireproto.EventsSubprotocol, shortLived, "")
	waitForEventsClients(t, hub, 1)
	expectClosed(t, expiring)

	reconnect := dial("/ws/md-events", wireproto.EventsSubprotocol, token, "")
	expectOpen(t, reconnect)
}

// The family's own deadline closes a socket earlier than the access token
// expiry would.
func TestAccessWSSocketClosesAtFamilyDeadline(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub, dial := newAuthSocketFixture(t)
	token := testAccessEnableV2(t, testAccessPassword)
	familyID := testAccessFamilyOf(t, auth, token)

	auth.mu.Lock()
	auth.v2.families[familyID].IdleExpiresAt = time.Now().Add(700 * time.Millisecond).Unix()
	auth.mu.Unlock()

	socket := dial("/ws/md-events", wireproto.EventsSubprotocol, token, "")
	waitForEventsClients(t, hub, 1)
	expectClosed(t, socket)
}

// A v1 cookie socket has no v2 deadline: the hourly access expiry must not
// close it.
func TestAccessWSV1SocketSurvivesV2AdmissionExpiry(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	_, dial := newAuthSocketFixture(t)
	token := testAccessEnableV2(t, testAccessPassword)
	familyID := testAccessFamilyOf(t, auth, token)
	cookie := testAccessCookieFor(t, auth).Value

	v1 := dial("/ws/md-events", wireproto.EventsSubprotocol, "", cookie)
	v2 := dial("/ws/md-events", wireproto.EventsSubprotocol, testAccessShortLivedToken(t, auth, familyID, 500*time.Millisecond), "")
	expectClosed(t, v2)
	expectStillOpen(t, v1)
}

// A family logout closes that family's sockets and leaves another family's
// sockets and every v1 socket connected. Logout-all closes the remaining v2
// sockets and still leaves v1 alone.
func TestAccessWSFamilyLogoutClosesOnlyItsSockets(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub, dial := newAuthSocketFixture(t)
	first := testAccessEnableV2(t, testAccessPassword)
	second, _ := testAccessV2LoginOnce(t, testAccessPassword)
	if testAccessFamilyOf(t, auth, first) == testAccessFamilyOf(t, auth, second) {
		t.Fatal("two logins shared one family")
	}
	cookie := testAccessCookieFor(t, auth).Value

	dial("/ws/md-events", wireproto.EventsSubprotocol, "", cookie)
	firstSocket := dial("/ws/md-events", wireproto.EventsSubprotocol, first, "")
	secondSocket := dial("/ws/md-events", wireproto.EventsSubprotocol, second, "")
	waitForEventsClients(t, hub, 3)

	if w := testAccessV2LogoutRequest(t, `{"all":false}`, first); w.Code != http.StatusOK {
		t.Fatalf("family logout: %d %s", w.Code, w.Body.String())
	}
	expectClosed(t, firstSocket)
	// Survival is checked with fresh connections: a client read that already
	// timed out stays poisoned in the Gorilla read state.
	expectOpen(t, dial("/ws/md-events", wireproto.EventsSubprotocol, second, ""))
	expectOpen(t, dial("/ws/md-events", wireproto.EventsSubprotocol, "", cookie))

	if w := testAccessV2LogoutRequest(t, `{"all":true}`, second); w.Code != http.StatusOK {
		t.Fatalf("logout all: %d %s", w.Code, w.Body.String())
	}
	expectClosed(t, secondSocket)
	// v1 keeps its cookie and its sockets: a v2 logout-all is not a record
	// change.
	expectOpen(t, dial("/ws/md-events", wireproto.EventsSubprotocol, "", cookie))
}

// A replayed refresh handle outside the grace window revokes the family, so its
// sockets close immediately.
func TestAccessWSReplayRevocationClosesFamilySockets(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub, dial := newAuthSocketFixture(t)
	enableToken := testAccessEnableV2(t, testAccessPassword)
	unrelatedFamily := testAccessFamilyOf(t, auth, enableToken)
	token, handle := testAccessV2LoginOnce(t, testAccessPassword)
	revokedFamily := testAccessFamilyOf(t, auth, token)
	if revokedFamily == unrelatedFamily {
		t.Fatal("two logins shared one family")
	}

	socket := dial("/ws/md-events", wireproto.EventsSubprotocol, token, "")
	waitForEventsClients(t, hub, 1)

	if w := testAccessV2RefreshRequest(t, handle); w.Code != http.StatusOK {
		t.Fatalf("first refresh: %d %s", w.Code, w.Body.String())
	}
	// Outside the grace window the retired handle is a reuse signal.
	replayedAt := time.Now().Add(accessRefreshGrace + time.Second)
	auth.mu.Lock()
	previous := auth.now
	auth.now = func() time.Time { return replayedAt }
	auth.mu.Unlock()
	t.Cleanup(func() {
		auth.mu.Lock()
		auth.now = previous
		auth.mu.Unlock()
	})
	if w := testAccessV2RefreshRequest(t, handle); w.Code != http.StatusUnauthorized {
		t.Fatalf("replayed refresh: %d %s", w.Code, w.Body.String())
	}
	expectClosed(t, socket)
	if _, ok := authFamilyExists(t, auth, unrelatedFamily); !ok {
		t.Fatal("unrelated family was revoked")
	}
	if _, ok := authFamilyExists(t, auth, revokedFamily); ok {
		t.Fatal("replayed family survived")
	}
}

// Removing a family from durable state closes its sockets. Pruning, expiry, and
// capacity eviction all remove families through commitActiveLocked, so this is
// the one closure path for all three.
func TestAccessWSFamilyRemovalClosesSockets(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub, dial := newAuthSocketFixture(t)
	kept := testAccessEnableV2(t, testAccessPassword)
	keptFamily := testAccessFamilyOf(t, auth, kept)
	dropped, _ := testAccessV2LoginOnce(t, testAccessPassword)
	droppedFamily := testAccessFamilyOf(t, auth, dropped)
	if keptFamily == droppedFamily {
		t.Fatal("two logins shared one family")
	}

	keptSocket := dial("/ws/md-events", wireproto.EventsSubprotocol, kept, "")
	droppedSocket := dial("/ws/md-events", wireproto.EventsSubprotocol, dropped, "")
	waitForEventsClients(t, hub, 2)

	auth.mu.Lock()
	active := auth.snapshotLocked()
	if !evictAccessFamily(active, droppedFamily) {
		auth.mu.Unlock()
		t.Fatal("family was not in the snapshot")
	}
	err := auth.commitActiveLocked(active)
	auth.mu.Unlock()
	if err != nil {
		t.Fatalf("commit removal: %v", err)
	}
	expectClosed(t, droppedSocket)
	expectStillOpen(t, keptSocket)
}

// authFamilyExists reports whether the manager still holds a live family.
func authFamilyExists(t *testing.T, auth *accessAuthManager, familyID string) (struct{}, bool) {
	t.Helper()
	auth.mu.Lock()
	defer auth.mu.Unlock()
	_, ok := auth.v2.families[familyID]
	return struct{}{}, ok
}

// A fence whose admitted exp has passed must be refused at registration, even
// when the middleware authorized it earlier: this is the expiry-to-registration
// window, driven by a clock jump rather than a sleep.
func TestAccessWSLateExpiryRegistrationIsRejected(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub := testAccessUseHub(t)
	hub.SetAuthValidator(auth.admitsFence)
	token := testAccessEnableV2(t, testAccessPassword)
	gate, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(accessAuthMiddleware(gatedEventsHandler(hub, gate, release, &once)))
	defer server.Close()

	type result struct {
		conn *websocket.Conn
		err  error
	}
	done := make(chan result, 1)
	go func() {
		conn, err := dialAfterGate(t, server.URL, "/ws/md-events", wireproto.EventsSubprotocol, token)
		done <- result{conn, err}
	}()
	<-gate
	// The middleware already authorized this request; jump past the admitted exp
	// before the handler registers, which is what an expired token sees.
	auth.mu.Lock()
	previous := auth.now
	auth.now = func() time.Time { return time.Now().Add(2 * accessJWTLifetime) }
	auth.mu.Unlock()
	close(release)
	out := <-done
	if out.conn != nil {
		t.Cleanup(func() { _ = out.conn.Close() })
	}
	expectRejectedUpgrade(t, out.conn, out.err)
	auth.mu.Lock()
	auth.now = previous
	auth.mu.Unlock()

	// The clock is restored, so the same credential connects again.
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.EventsSubprotocol}}
	conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/md-events?token="+neturl.QueryEscape(token), nil)
	if err != nil {
		t.Fatalf("reconnect after clock restore: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	expectOpen(t, conn)
}

// --- M1c gap-fill: logout-all, refresh reconnect, clear/rehash, enable/disable ---

// dialSocketRaw dials one fenced route and returns the handshake error rather
// than failing: the refusal cases must see the error itself.
func dialSocketRaw(t *testing.T, socketURL, path, subprotocol, token, cookie string) (*websocket.Conn, error) {
	t.Helper()
	url := socketURL + path
	if token != "" {
		url += "?token=" + neturl.QueryEscape(token)
	}
	header := http.Header{}
	if cookie != "" {
		header.Set("Cookie", accessSessionCookie+"="+cookie)
	}
	dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
	conn, _, err := dialer.Dial(url, header)
	if conn != nil {
		t.Cleanup(func() { _ = conn.Close() })
	}
	return conn, err
}

// requireDialed dials one route and fails unless the handshake was accepted.
// It never reads, so the connection stays usable for a later close check.
func requireDialed(t *testing.T, socketURL, path, subprotocol, token, cookie string) *websocket.Conn {
	t.Helper()
	conn, err := dialSocketRaw(t, socketURL, path, subprotocol, token, cookie)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	return conn
}

// testAccessExpiryOf returns the admitted exp a token names.
func testAccessExpiryOf(t *testing.T, auth *accessAuthManager, token string) time.Time {
	t.Helper()
	auth.mu.Lock()
	defer auth.mu.Unlock()
	claims, err := parseAccessJWT(auth.jwtKey, token, time.Now(), accessJWTClockAllowance)
	if err != nil {
		t.Fatalf("parse access token: %v", err)
	}
	return claims.ExpiresAt
}

// Logout-all is a v2-only revocation: every v2 socket closes, while the v1
// socket keeps streaming and the v1 cookie keeps authorizing requests. v1 has
// no epoch, so nothing about it is retired.
func TestAccessWSLogoutAllClosesOnlyV2Sockets(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub, socketURL := newAuthSocketServer(t)
	first := testAccessEnableV2(t, testAccessPassword)
	second, _ := testAccessV2LoginOnce(t, testAccessPassword)
	if testAccessFamilyOf(t, auth, first) == testAccessFamilyOf(t, auth, second) {
		t.Fatal("two logins shared one family")
	}
	cookie := auth.mustTestCookie(t).Value

	firstSocket := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, first, "")
	secondSocket := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, second, "")
	cookieSocket := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, "", cookie)
	waitForEventsClients(t, hub, 3)

	if w := testAccessV2LogoutRequest(t, `{"all":true}`, first); w.Code != http.StatusOK {
		t.Fatalf("logout all: %d %s", w.Code, w.Body.String())
	}
	expectClosed(t, firstSocket)
	expectClosed(t, secondSocket)
	expectStillOpen(t, cookieSocket)

	// The v1 credential itself is untouched: a fresh socket still attaches with
	// the same cookie, and a protected request still authorizes.
	expectStillOpen(t, requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, "", cookie))
	r := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	r.AddCookie(&http.Cookie{Name: accessSessionCookie, Value: cookie})
	if w := testAccessServe(testAccessProtected().ServeHTTP, r); w.Code != http.StatusNoContent {
		t.Fatalf("logout-all invalidated the v1 cookie: %d", w.Code)
	}
}

// A socket closed at its admitted exp reconnects with the token a refresh
// issues: the new admission carries the refreshed exp and the current protocol
// selection, while the expired token stays refused.
func TestAccessWSReconnectUsesRefreshedToken(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	hub, socketURL := newAuthSocketServer(t)
	testAccessEnableV2(t, testAccessPassword)
	token, handle := testAccessV2LoginOnce(t, testAccessPassword)
	familyID := testAccessFamilyOf(t, auth, token)

	expiring := testAccessShortLivedToken(t, auth, familyID, 700*time.Millisecond)
	previousExpiry := testAccessExpiryOf(t, auth, expiring)
	first := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, expiring, "")
	waitForEventsClients(t, hub, 1)
	expectClosed(t, first)

	// The consumed-token window is over: the same credential cannot come back.
	if conn, err := dialSocketRaw(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, expiring, ""); err == nil {
		expectClosed(t, conn)
	}

	w := testAccessV2RefreshRequest(t, handle)
	if w.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", w.Code, w.Body.String())
	}
	var refreshed struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, w, &refreshed)
	if refreshed.Token == "" || refreshed.Token == expiring {
		t.Fatalf("refresh issued no replacement token")
	}

	reconnected := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, refreshed.Token, "")
	if got := reconnected.Subprotocol(); got != wireproto.EventsSubprotocol {
		t.Fatalf("reconnect negotiated %q, want %q", got, wireproto.EventsSubprotocol)
	}
	waitForEventsClients(t, hub, 1)
	// The new admission carries the refreshed exp, not the old one: it outlives
	// the instant the previous admission closed at.
	_ = reconnected.SetReadDeadline(previousExpiry.Add(500 * time.Millisecond))
	_, _, err := reconnected.ReadMessage()
	var netErr interface{ Timeout() bool }
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("refreshed admission did not survive the previous exp: %v", err)
	}
}

// Clearing the password disables access, and every socket admitted by either
// credential closes. A same-encoded legacy submission is a state-only record
// rotation: the epoch and every family are replaced, so v2 sockets for every
// family close with the v1 sockets the record ownership covers.
func TestAccessWSClearAndRehashCloseSockets(t *testing.T) {
	t.Run("clear", func(t *testing.T) {
		withTempConfig(t)
		auth := useTestAccessAuth(t)
		hub, socketURL := newAuthSocketServer(t)
		token := testAccessEnableV2(t, testAccessPassword)
		cookie := auth.mustTestCookie(t).Value

		cookieSocket := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, "", cookie)
		bearerSocket := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, token, "")
		waitForEventsClients(t, hub, 2)

		w := testAccessV2PasswordRequest(t, `{"password":""}`, token)
		if w.Code != http.StatusOK {
			t.Fatalf("clear: %d %s", w.Code, w.Body.String())
		}
		var cleared struct {
			Enabled bool `json:"enabled"`
		}
		testAccessJSONBody(t, w, &cleared)
		if cleared.Enabled {
			t.Fatalf("clear reported enabled=%v", cleared.Enabled)
		}
		expectClosed(t, cookieSocket)
		expectClosed(t, bearerSocket)

		// Disabled is not "closed for business": an unauthenticated socket is
		// admitted again, so the closures above came from the clear itself.
		expectStillOpen(t, requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, "", ""))
	})

	t.Run("same-encoded legacy rehash", func(t *testing.T) {
		withTempConfig(t)
		auth := useTestAccessAuth(t)
		hub, socketURL := newAuthSocketServer(t)
		first := testAccessEnableV2(t, testAccessPassword)
		unrelated, _ := testAccessV2LoginOnce(t, testAccessPassword)
		cookie := auth.mustTestCookie(t).Value

		auth.mu.Lock()
		encoded := auth.record.encoded()
		recordID := auth.v2.recordID
		families := len(auth.v2.families)
		auth.mu.Unlock()
		if families != 2 {
			t.Fatalf("families before rehash = %d, want 2", families)
		}

		// A same-encoded submission must not touch Config: the deterministic v1
		// signature cannot rotate, so only the state file changes.
		previousWriter := writeConfigFile
		configWrites := 0
		writeConfigFile = func(path string, data []byte, mode os.FileMode) error {
			configWrites++
			return previousWriter(path, data, mode)
		}
		t.Cleanup(func() { writeConfigFile = previousWriter })

		cookieSocket := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, "", cookie)
		firstSocket := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, first, "")
		unrelatedSocket := requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, unrelated, "")
		waitForEventsClients(t, hub, 3)

		// The bytes already on disk are resubmitted, so this is the same-encoded
		// case: one state replacement, no Config write.
		if _, err := auth.setEncodedPassword(encoded, accessCredential{State: accessCredentialPresent, Token: first}); err != nil {
			t.Fatalf("same-encoded rehash: %v", err)
		}
		expectClosed(t, firstSocket)
		// The epoch advance replaced every family, so the unrelated family goes
		// too; M1c keeps record rotation as an all-generation revocation.
		expectClosed(t, unrelatedSocket)
		expectClosed(t, cookieSocket)

		auth.mu.Lock()
		nextRecordID := auth.v2.recordID
		nextFamilies := len(auth.v2.families)
		auth.mu.Unlock()
		if configWrites != 0 {
			t.Fatalf("same-encoded rehash rewrote Config %d times", configWrites)
		}
		if nextRecordID == recordID {
			t.Fatal("record identity survived the rehash")
		}
		if nextFamilies != 0 {
			t.Fatalf("families after rehash = %d, want 0", nextFamilies)
		}

		// The password itself is unchanged, so a fresh login re-establishes
		// state and its credentials connect.
		replacement, _ := testAccessV2LoginOnce(t, testAccessPassword)
		requireDialed(t, socketURL, "/ws/md-events", wireproto.EventsSubprotocol, replacement, "")
	})
}

// The admission fence is generation-based in both directions: a request the
// middleware authorized before the transition must not register afterwards.
func TestAccessWSEnableDisableAdmissionFence(t *testing.T) {
	// A socket authorized while access is disabled must not attach once an
	// enable retires the generation it snapshotted.
	t.Run("disabled to enabled", func(t *testing.T) {
		withTempConfig(t)
		useTestAccessAuth(t)
		hub := testAccessUseHub(t)
		gate, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		server := httptest.NewServer(accessAuthMiddleware(gatedEventsHandler(hub, gate, release, &once)))
		defer server.Close()

		type result struct {
			conn *websocket.Conn
			err  error
		}
		done := make(chan result, 1)
		go func() {
			conn, err := dialAfterGate(t, server.URL, "/ws/md-events", wireproto.EventsSubprotocol, "")
			done <- result{conn, err}
		}()
		<-gate
		token := testAccessEnableV2(t, testAccessPassword)
		close(release)
		out := <-done
		expectRejectedUpgrade(t, out.conn, out.err)

		// The credential the enable issued is admitted, so the refusal above was
		// the stale generation and not a broken server.
		dialer := websocket.Dialer{Subprotocols: []string{wireproto.EventsSubprotocol}}
		conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/md-events?token="+neturl.QueryEscape(token), nil)
		if err != nil {
			t.Fatalf("fresh credential after enable: %v", err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		expectOpen(t, conn)
	})

	// A socket authorized while access is enabled must not attach once a clear
	// disables it and retires the generation it snapshotted.
	t.Run("enabled to disabled", func(t *testing.T) {
		withTempConfig(t)
		useTestAccessAuth(t)
		hub := testAccessUseHub(t)
		token := testAccessEnableV2(t, testAccessPassword)
		gate, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		server := httptest.NewServer(accessAuthMiddleware(gatedEventsHandler(hub, gate, release, &once)))
		defer server.Close()

		type result struct {
			conn *websocket.Conn
			err  error
		}
		done := make(chan result, 1)
		go func() {
			conn, err := dialAfterGate(t, server.URL, "/ws/md-events", wireproto.EventsSubprotocol, token)
			done <- result{conn, err}
		}()
		<-gate
		if w := testAccessV2PasswordRequest(t, `{"password":""}`, token); w.Code != http.StatusOK {
			t.Fatalf("clear: %d %s", w.Code, w.Body.String())
		}
		close(release)
		out := <-done
		expectRejectedUpgrade(t, out.conn, out.err)

		// Disabled admits again without a credential, so the rejection above was
		// the retired generation and not a severed server.
		expectStillOpen(t, requireDialed(t, "ws"+strings.TrimPrefix(server.URL, "http"), "/ws/md-events", wireproto.EventsSubprotocol, "", ""))
	})
}
