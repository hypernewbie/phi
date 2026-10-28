package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
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

// Auth credentials must never reach application output. These tests drive
// successful and failing auth requests through the production middleware and
// handlers with synthetic passwords and tokens, capture everything written to
// the standard logger and to slog, and assert that no secret survives.
//
// The optional-trace half lives in auth_observability_otel_test.go behind the
// `otel` build tag; it inspects the spans otelhttp actually emits.

// syncBuffer collects log output from the goroutines the handlers start.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureAccessLogs redirects both logging front ends into one sink for the
// rest of the test. slog is set to Debug so the obs.Span trace lines — the
// only structured output an auth request can produce — are captured too.
func captureAccessLogs(t *testing.T) *syncBuffer {
	t.Helper()
	sink := &syncBuffer{}
	previousWriter := log.Writer()
	previousFlags := log.Flags()
	previousLogger := slog.Default()
	log.SetOutput(sink)
	log.SetFlags(0)
	slog.SetDefault(slog.New(slog.NewTextHandler(sink, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
		slog.SetDefault(previousLogger)
	})
	return sink
}

// observabilitySecrets is one run's credential material. Every field must stay
// out of captured output.
type observabilitySecrets struct {
	passwords []string
	tokens    []string
	verifier  string
	// handles are refresh handles: the wire form of the rotating credential.
	handles []string
	// stateValues are the durable forms of the same material — the derived
	// refresh key, family digests and record binding read back from the state
	// file. A debug dump of the journal would leak these even though the wire
	// format never carries them.
	stateValues []string
}

func (s observabilitySecrets) check(t *testing.T, where, output string) {
	t.Helper()
	for _, password := range s.passwords {
		if strings.Contains(output, password) {
			t.Errorf("%s leaked a password", where)
		}
	}
	for _, token := range s.tokens {
		if token == "" {
			continue
		}
		if strings.Contains(output, token) {
			t.Errorf("%s leaked a token", where)
		}
	}
	for _, handle := range s.handles {
		if handle == "" {
			continue
		}
		if strings.Contains(output, handle) {
			t.Errorf("%s leaked a refresh handle", where)
		}
	}
	for _, value := range s.stateValues {
		if value == "" {
			continue
		}
		if strings.Contains(output, value) {
			t.Errorf("%s leaked a state-file value", where)
		}
	}
	if s.verifier != "" && strings.Contains(output, s.verifier) {
		t.Errorf("%s leaked a derived verifier", where)
	}
	// The full Authorization value and any token-bearing URL would carry one
	// of the secrets above, but assert the shapes too so a future redaction
	// mistake fails here even if the token is not in the list.
	for _, shape := range []string{
		"Bearer ",
		"token=",
		accessRefreshCookie + "=",
		accessAssetCookie + "=",
		accessSocketTokenHeader + ": ",
	} {
		if strings.Contains(output, shape) {
			t.Errorf("%s leaked a credential-bearing header, cookie or URL (%q)", where, shape)
		}
	}
}

func TestAccessObservabilityLogsNoCredentials(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	hub := testAccessUseHub(t)

	const (
		firstPassword   = "obs-first-pass-4a71"
		rotatedPassword = "obs-rotated-pass-77d0"
	)
	secrets := observabilitySecrets{passwords: []string{firstPassword, rotatedPassword}}

	// A real pane, events, and control handler: the query-token transport is
	// only exercised by an actual upgrade on each route.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	manager := pty.NewManager()
	t.Cleanup(func() { manager.Shutdown(2 * time.Second) })
	shell, args := testMainShell()
	instance, err := manager.SpawnWithOptions(context.Background(), home, shell, args, "pi", "obs-sid", pty.SpawnOptions{ID: "obs-pane"})
	if err != nil {
		t.Fatalf("spawn observability pane: %v", err)
	}

	sink := captureAccessLogs(t)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/status", handleAccessAuthStatus)
	mux.HandleFunc("/api/auth/login", handleAccessAuthLogin)
	mux.HandleFunc("/api/auth/password", handleAccessPassword)
	mux.HandleFunc("/api/auth/v2/status", handleAccessV2Status)
	mux.HandleFunc("/api/auth/v2/login", handleAccessV2Login)
	mux.HandleFunc("/api/auth/v2/password", handleAccessV2Password)
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/ws/pane/obs-pane", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, instance, manager, hub)
	})
	mux.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, hub)
	})
	mux.HandleFunc("/ws/control", ws.HandleControl(hub, rpc.NewManager(), func() string { return home }))
	server := httptest.NewServer(accessAuthMiddleware(mux))
	defer server.Close()

	var bodies []string
	record := func(w *httptest.ResponseRecorder) *httptest.ResponseRecorder {
		bodies = append(bodies, w.Body.String())
		return w
	}

	// Enable access with the v2 password route: the response carries the
	// first bearer.
	enableBody, err := json.Marshal(map[string]string{"password": firstPassword})
	if err != nil {
		t.Fatal(err)
	}
	enabled := record(testAccessV2PasswordRequest(t, string(enableBody), ""))
	if enabled.Code != http.StatusOK {
		t.Fatalf("enable password: %d %s", enabled.Code, enabled.Body.String())
	}
	var enableResponse struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, enabled, &enableResponse)
	firstToken := enableResponse.Token
	secrets.tokens = append(secrets.tokens, firstToken)

	// v1 login: derive the verifier locally, as the browser does, and post a
	// one-time proof. The server issues a session cookie.
	_, saltB64, challenge, iterations, err := accessAuth.statusAndChallenge()
	if err != nil {
		t.Fatalf("status challenge: %v", err)
	}
	salt, err := base64.RawURLEncoding.DecodeString(saltB64)
	if err != nil {
		t.Fatalf("decode salt: %v", err)
	}
	verifier, err := deriveAccessVerifier(firstPassword, salt, iterations)
	if err != nil {
		t.Fatalf("derive verifier: %v", err)
	}
	secrets.verifier = base64.RawURLEncoding.EncodeToString(verifier)
	loginBody, err := json.Marshal(map[string]string{
		"challenge": challenge,
		"proof":     testAccessProof(t, verifier, challenge),
	})
	if err != nil {
		t.Fatal(err)
	}
	v1Login := record(testAccessServe(handleAccessAuthLogin, httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(loginBody))))
	if v1Login.Code != http.StatusOK {
		t.Fatalf("v1 login: %d %s", v1Login.Code, v1Login.Body.String())
	}
	var sessionCookie string
	for _, cookie := range v1Login.Result().Cookies() {
		if cookie.Name == accessSessionCookie {
			sessionCookie = cookie.Value
		}
	}
	if sessionCookie == "" {
		t.Fatal("v1 login issued no session cookie")
	}
	secrets.tokens = append(secrets.tokens, sessionCookie)

	// v2 login with the same password, then a failed one.
	v2Login := record(testAccessV2LoginRequest(t, firstPassword, "198.51.100.11:41000"))
	if v2Login.Code != http.StatusOK {
		t.Fatalf("v2 login: %d %s", v2Login.Code, v2Login.Body.String())
	}
	var v2LoginResponse struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, v2Login, &v2LoginResponse)
	secrets.tokens = append(secrets.tokens, v2LoginResponse.Token)
	record(testAccessV2LoginRequest(t, "obs-wrong-pass-0000", "198.51.100.12:41001"))
	secrets.passwords = append(secrets.passwords, "obs-wrong-pass-0000")

	// v2 status, then rotate the password through the bearer-only route.
	v2StatusRequest := httptest.NewRequest(http.MethodGet, "/api/auth/v2/status", nil)
	v2StatusRequest.Header.Set("Authorization", "Bearer "+firstToken)
	record(testAccessServe(handleAccessV2Status, v2StatusRequest))
	rotateBody, err := json.Marshal(map[string]string{"password": rotatedPassword})
	if err != nil {
		t.Fatal(err)
	}
	rotated := record(testAccessV2PasswordRequest(t, string(rotateBody), firstToken))
	if rotated.Code != http.StatusOK {
		t.Fatalf("rotate password: %d %s", rotated.Code, rotated.Body.String())
	}
	var rotateResponse struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, rotated, &rotateResponse)
	secrets.tokens = append(secrets.tokens, rotateResponse.Token)

	// Bearer and cookie credentials against the real middleware, including
	// the shapes that must fail closed.
	do := func(path string, mutate func(*http.Request)) int {
		request, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if mutate != nil {
			mutate(request)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode
	}
	withBearer := func(token string) func(*http.Request) {
		return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+token) }
	}
	if code := do("/api/config", withBearer(rotateResponse.Token)); code != http.StatusNoContent {
		t.Fatalf("bearer config: %d", code)
	}
	if code := do("/api/config", func(r *http.Request) {
		r.AddCookie(&http.Cookie{Name: accessSessionCookie, Value: sessionCookie})
	}); code != http.StatusUnauthorized {
		t.Fatalf("rotated v1 cookie config: %d", code)
	}
	if code := do("/api/config", nil); code != http.StatusUnauthorized {
		t.Fatalf("anonymous config: %d", code)
	}
	// Two Authorization values are invalid rather than "first one wins".
	if code := do("/api/config", func(r *http.Request) {
		r.Header.Add("Authorization", "Bearer "+rotateResponse.Token)
		r.Header.Add("Authorization", "Bearer "+firstToken)
	}); code != http.StatusUnauthorized {
		t.Fatalf("duplicate authorization: %d", code)
	}
	// A bearer and a query token on the same request are invalid.
	if code := do("/api/config?token="+url.QueryEscape(rotateResponse.Token), withBearer(rotateResponse.Token)); code != http.StatusUnauthorized {
		t.Fatalf("bearer plus query token: %d", code)
	}
	// A query token is a WebSocket transport only.
	if code := do("/api/config?token="+url.QueryEscape(rotateResponse.Token), nil); code != http.StatusUnauthorized {
		t.Fatalf("query token on an API path: %d", code)
	}
	// A bearer is an API transport only.
	if code := do("/ws/md-events", withBearer(rotateResponse.Token)); code != http.StatusUnauthorized {
		t.Fatalf("bearer on a socket path: %d", code)
	}

	// Every socket route accepts the query token, and every one rejects a
	// stale token after the rotation.
	dial := func(path, subprotocol, token string) (*websocket.Conn, error) {
		dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
		conn, _, err := dialer.Dial(
			"ws"+strings.TrimPrefix(server.URL, "http")+path+"?token="+url.QueryEscape(token),
			nil,
		)
		if err != nil {
			return nil, err
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn, nil
	}
	routes := []struct {
		path        string
		subprotocol string
		// A pane attach sends a first frame; the events and control sockets
		// stay quiet until there is something to say.
		firstFrame bool
	}{
		{"/ws/pane/obs-pane", wireproto.TerminalSubprotocol, true},
		{"/ws/md-events", wireproto.EventsSubprotocol, false},
		{"/ws/control", wireproto.ControlSubprotocol, false},
	}
	for _, route := range routes {
		conn, err := dial(route.path, route.subprotocol, rotateResponse.Token)
		if err != nil {
			t.Fatalf("dial %s: %v", route.path, err)
		}
		if route.firstFrame {
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			if _, _, err := conn.ReadMessage(); err != nil {
				t.Fatalf("%s did not attach: %v", route.path, err)
			}
		} else {
			expectOpen(t, conn)
		}
		if _, err := dial(route.path, route.subprotocol, firstToken); err == nil {
			t.Fatalf("%s accepted the rotated token", route.path)
		}
		if _, err := dial(route.path, route.subprotocol, ""); err == nil {
			t.Fatalf("%s accepted an empty token", route.path)
		}
	}

	// The responses themselves must not echo a password either. Tokens do
	// appear in the two issuing responses, so only passwords are checked here.
	for _, body := range bodies {
		for _, password := range secrets.passwords {
			if strings.Contains(body, password) {
				t.Errorf("auth response body leaked a password")
			}
		}
	}

	secrets.check(t, "captured logs", sink.String())
}

// TestAccessObservabilityLogsNoRefreshOrCookieCredentials covers the credential
// classes the first log test does not reach: the rotating refresh handle, the
// two scoped cookies, the host-only socket header carrier, and the persistence
// failure path. It also asserts the durable side stays out of output — the
// state file holds the derived refresh key and digest evidence, which a debug
// dump of the journal would publish even though the wire format never carries
// it.
func TestAccessObservabilityLogsNoRefreshOrCookieCredentials(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	hub := testAccessUseHub(t)

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	manager := pty.NewManager()
	t.Cleanup(func() { manager.Shutdown(2 * time.Second) })
	shell, args := testMainShell()
	instance, err := manager.SpawnWithOptions(context.Background(), home, shell, args, "pi", "obs2-sid", pty.SpawnOptions{ID: "obs2-pane"})
	if err != nil {
		t.Fatalf("spawn observability pane: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/v2/status", handleAccessV2Status)
	mux.HandleFunc("/api/auth/v2/login", handleAccessV2Login)
	mux.HandleFunc("/api/auth/v2/password", handleAccessV2Password)
	mux.HandleFunc("/api/auth/v2/refresh", handleAccessV2Refresh)
	mux.HandleFunc("/api/auth/v2/logout", handleAccessV2Logout)
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/ws/pane/obs2-pane", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, instance, manager, hub)
	})
	mux.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, hub)
	})
	mux.HandleFunc("/ws/control", ws.HandleControl(hub, rpc.NewManager(), func() string { return home }))
	server := httptest.NewServer(accessAuthMiddleware(mux))
	defer server.Close()

	sink := captureAccessLogs(t)

	const (
		enablePassword  = "obs-refresh-pass-51c8"
		changedPassword = "obs-changed-pass-90ae"
		unknownHandle   = "obs-unknown-handle-0001"
	)
	secrets := observabilitySecrets{passwords: []string{enablePassword, changedPassword}}
	var bodies []string

	// post drives one v2 route through the production middleware, so the obs
	// span lines for those requests are captured too.
	post := func(path, bearer, body string, cookies ...*http.Cookie) (*http.Response, string) {
		t.Helper()
		request, err := http.NewRequest(http.MethodPost, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(accessV2Header, accessV2HeaderValue)
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		for _, cookie := range cookies {
			request.AddCookie(cookie)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		t.Cleanup(func() { response.Body.Close() })
		payload, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		bodies = append(bodies, string(payload))
		return response, string(payload)
	}
	tokenOf := func(response *http.Response, body string) string {
		t.Helper()
		if response.StatusCode != http.StatusOK {
			return ""
		}
		var payload struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			t.Fatalf("decode bundle: %v", err)
		}
		return payload.Token
	}
	cookieOf := func(response *http.Response, name string) string {
		for _, cookie := range response.Cookies() {
			if cookie.Name == name {
				return cookie.Value
			}
		}
		return ""
	}

	enableResponse, enableBody := post("/api/auth/v2/password", "", `{"password":"`+enablePassword+`"}`)
	enableToken := tokenOf(enableResponse, enableBody)
	if enableToken == "" {
		t.Fatalf("enable password: %d %s", enableResponse.StatusCode, enableBody)
	}
	secrets.tokens = append(secrets.tokens, enableToken, cookieOf(enableResponse, accessAssetCookie))
	secrets.handles = append(secrets.handles, cookieOf(enableResponse, accessRefreshCookie))

	loginResponse, loginBody := post("/api/auth/v2/login", "", `{"password":"`+enablePassword+`"}`)
	loginToken := tokenOf(loginResponse, loginBody)
	if loginToken == "" {
		t.Fatalf("v2 login: %d %s", loginResponse.StatusCode, loginBody)
	}
	firstHandle := cookieOf(loginResponse, accessRefreshCookie)
	if firstHandle == "" {
		t.Fatal("v2 login installed no refresh handle")
	}
	secrets.tokens = append(secrets.tokens, loginToken, cookieOf(loginResponse, accessAssetCookie))
	secrets.handles = append(secrets.handles, firstHandle)

	refreshCookie := func(handle string) *http.Cookie {
		return &http.Cookie{Name: accessRefreshCookie, Value: handle}
	}
	refreshResponse, refreshBody := post("/api/auth/v2/refresh", "", `{}`, refreshCookie(firstHandle))
	rotatedToken := tokenOf(refreshResponse, refreshBody)
	if rotatedToken == "" {
		t.Fatalf("refresh: %d %s", refreshResponse.StatusCode, refreshBody)
	}
	secrets.tokens = append(secrets.tokens, rotatedToken, cookieOf(refreshResponse, accessAssetCookie))
	secrets.handles = append(secrets.handles, cookieOf(refreshResponse, accessRefreshCookie))

	// A replay inside the grace window succeeds; the handle in the request and
	// the one it reissues are both credentials that must stay out of output.
	replayResponse, replayBody := post("/api/auth/v2/refresh", "", `{}`, refreshCookie(firstHandle))
	if replayResponse.StatusCode != http.StatusOK {
		t.Fatalf("grace replay: %d %s", replayResponse.StatusCode, replayBody)
	}
	secrets.handles = append(secrets.handles, cookieOf(replayResponse, accessRefreshCookie))

	// An unknown handle is the terminal rejection, and it must not echo the
	// handle the caller presented.
	unknownResponse, _ := post("/api/auth/v2/refresh", "", `{}`, refreshCookie(unknownHandle))
	if unknownResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown handle: %d", unknownResponse.StatusCode)
	}
	secrets.handles = append(secrets.handles, unknownHandle)

	// A bearer on the refresh route is a carrier mix-up, not a credential.
	if mixedResponse, _ := post("/api/auth/v2/refresh", rotatedToken, `{}`); mixedResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bearer on refresh: %d", mixedResponse.StatusCode)
	}

	// A state write that fails must report failure without issuing or logging
	// the credential it had prepared.
	previousWrite := writeAccessV2StateFile
	writeAccessV2StateFile = func(string, []byte, os.FileMode) error {
		return errors.New("injected observability state write failure")
	}
	failedLogin, _ := post("/api/auth/v2/login", "", `{"password":"`+enablePassword+`"}`)
	writeAccessV2StateFile = previousWrite
	if failedLogin.StatusCode != http.StatusInternalServerError {
		t.Fatalf("failed state write login: %d", failedLogin.StatusCode)
	}
	if issued := failedLogin.Cookies(); len(issued) != 0 {
		t.Errorf("failed state write issued %d cookies", len(issued))
	}

	// The durable forms of the same material, read back while the families are
	// still live, are credentials the journal must never print.
	stateBytes, err := os.ReadFile(accessV2StatePath())
	if err != nil {
		t.Fatalf("read state file: %v", err)
	}
	var state accessV2StateFile
	if err := json.Unmarshal(stateBytes, &state); err != nil {
		t.Fatalf("decode state file: %v", err)
	}
	secrets.stateValues = append(secrets.stateValues, state.Active.RecordBinding, state.Active.RecordID)
	if state.Active.RefreshKey != nil {
		secrets.stateValues = append(secrets.stateValues, *state.Active.RefreshKey)
	}
	for _, family := range state.Active.Families {
		secrets.stateValues = append(secrets.stateValues, family.ID, family.ActiveDigest)
		for _, consumed := range family.Consumed {
			secrets.stateValues = append(secrets.stateValues, consumed.Digest)
		}
	}

	// Every socket route accepts the host-only carrier, and none accepts a
	// bearer: the transports stay separate.
	socketURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dial := func(path, subprotocol string, mutate func(http.Header)) (*websocket.Conn, error) {
		headers := http.Header{}
		if mutate != nil {
			mutate(headers)
		}
		dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
		conn, _, err := dialer.Dial(socketURL+path, headers)
		if err != nil {
			return nil, err
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn, nil
	}
	for _, route := range []struct {
		path        string
		subprotocol string
		firstFrame  bool
	}{
		{"/ws/pane/obs2-pane", wireproto.TerminalSubprotocol, true},
		{"/ws/md-events", wireproto.EventsSubprotocol, false},
		{"/ws/control", wireproto.ControlSubprotocol, false},
	} {
		conn, err := dial(route.path, route.subprotocol, func(h http.Header) {
			h.Set(accessSocketTokenHeader, rotatedToken)
		})
		if err != nil {
			t.Fatalf("header carrier on %s: %v", route.path, err)
		}
		if route.firstFrame {
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			if _, _, err := conn.ReadMessage(); err != nil {
				t.Fatalf("%s did not attach: %v", route.path, err)
			}
		} else {
			expectOpen(t, conn)
		}
		if _, err := dial(route.path, route.subprotocol, func(h http.Header) {
			h.Set("Authorization", "Bearer "+rotatedToken)
		}); err == nil {
			t.Fatalf("%s accepted a bearer", route.path)
		}
	}

	// The carrier is not an HTTP credential, on the protected route or on a v2
	// route that reads its own carriers.
	do := func(path string, mutate func(*http.Request)) int {
		request, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if mutate != nil {
			mutate(request)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode
	}
	if code := do("/api/config", func(r *http.Request) {
		r.Header.Set(accessSocketTokenHeader, rotatedToken)
	}); code != http.StatusUnauthorized {
		t.Fatalf("socket carrier on an API path: %d", code)
	}

	// Logout current, then everything. Both accept the bearer and neither may
	// echo a credential.
	if logoutResponse, body := post("/api/auth/v2/logout", rotatedToken, `{"all":false}`); logoutResponse.StatusCode != http.StatusOK {
		t.Fatalf("logout current: %d %s", logoutResponse.StatusCode, body)
	}
	if allResponse, body := post("/api/auth/v2/logout", enableToken, `{"all":true}`); allResponse.StatusCode != http.StatusOK {
		t.Fatalf("logout all: %d %s", allResponse.StatusCode, body)
	}

	for _, body := range bodies {
		for _, password := range secrets.passwords {
			if strings.Contains(body, password) {
				t.Errorf("auth response body leaked a password")
			}
		}
		for _, handle := range secrets.handles {
			if handle != "" && strings.Contains(body, handle) {
				t.Errorf("auth response body leaked a refresh handle")
			}
		}
	}

	secrets.check(t, "captured logs", sink.String())
}
