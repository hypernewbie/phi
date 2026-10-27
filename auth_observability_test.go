package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	if s.verifier != "" && strings.Contains(output, s.verifier) {
		t.Errorf("%s leaked a derived verifier", where)
	}
	// The full Authorization value and any token-bearing URL would carry one
	// of the secrets above, but assert the shapes too so a future redaction
	// mistake fails here even if the token is not in the list.
	for _, shape := range []string{"Bearer ", "token="} {
		if strings.Contains(output, shape) {
			t.Errorf("%s leaked a credential-bearing header or URL (%q)", where, shape)
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
