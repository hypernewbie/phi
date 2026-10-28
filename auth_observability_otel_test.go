//go:build otel

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/hypernewbie/phi/pkg/obs"
)

// The optional-trace half of the auth observability contract: with the otel
// tag compiled in, main.go serves obs.WrapHTTP(accessAuthMiddleware(mux)), so
// every auth request produces an otelhttp server span. Those spans must not
// carry a password, a token, an Authorization value, or a token-bearing URL —
// notably not the WebSocket query credential.
//
// The attributes asserted here are the ones otelhttp v0.70 actually emits
// (semconv URLPath, not a hand-rolled URLPath attribute); the URL query is
// never recorded. A future otelhttp upgrade that starts recording url.query or
// url.full would fail this test rather than silently leak tokens.

func withInMemoryTraces(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exporter)),
	)
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	})
	return exporter
}

// spanStrings flattens every string a span exposes, so a secret cannot hide in
// an attribute value, an event, a link, or an error description.
func spanStrings(span tracetest.SpanStub) []string {
	out := []string{span.Name, span.Status.Description}
	add := func(attrs []attribute.KeyValue) {
		for _, attr := range attrs {
			out = append(out, string(attr.Key), attr.Value.AsString(), attr.Value.String())
		}
	}
	add(span.Attributes)
	for _, event := range span.Events {
		out = append(out, event.Name)
		add(event.Attributes)
	}
	for _, link := range span.Links {
		add(link.Attributes)
	}
	return out
}

func TestAccessObservabilitySpansCarryNoCredentials(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	exporter := withInMemoryTraces(t)

	const (
		firstPassword   = "otel-first-pass-8c31"
		rotatedPassword = "otel-rotated-pass-2b94"
	)
	passwords := []string{firstPassword, rotatedPassword}
	var tokens []string

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/status", handleAccessAuthStatus)
	mux.HandleFunc("/api/auth/login", handleAccessAuthLogin)
	mux.HandleFunc("/api/auth/password", handleAccessPassword)
	mux.HandleFunc("/api/auth/v2/status", handleAccessV2Status)
	mux.HandleFunc("/api/auth/v2/login", handleAccessV2Login)
	mux.HandleFunc("/api/auth/v2/password", handleAccessV2Password)
	mux.HandleFunc("/api/auth/v2/refresh", handleAccessV2Refresh)
	mux.HandleFunc("/api/auth/v2/logout", handleAccessV2Logout)
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	// The socket handlers are stubs here: the trace contract is about the
	// middleware's credential handling and the URL it records. The real
	// handlers are covered by auth_observability_test.go and
	// auth_websocket_test.go.
	for _, path := range []string{"/ws/pane/otel-pane", "/ws/md-events", "/ws/control"} {
		mux.HandleFunc(path, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	}
	// Same order as main.go.
	server := httptest.NewServer(obs.WrapHTTP(accessAuthMiddleware(mux)))
	defer server.Close()

	post := func(path, bearer, body string) *http.Response {
		request, err := http.NewRequest(http.MethodPost, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		// The same CSRF guard the browser sends; without it a v2 route
		// answers 403 before it parses anything.
		request.Header.Set(accessV2Header, accessV2HeaderValue)
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		t.Cleanup(func() { response.Body.Close() })
		return response
	}
	get := func(path string, headers map[string]string) *http.Response {
		request, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		t.Cleanup(func() { response.Body.Close() })
		return response
	}
	decodeToken := func(response *http.Response) string {
		t.Helper()
		var payload struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil || payload.Token == "" {
			t.Fatalf("decode token: %v", err)
		}
		return payload.Token
	}

	enableBody, err := json.Marshal(map[string]string{"password": firstPassword})
	if err != nil {
		t.Fatal(err)
	}
	enabled := post("/api/auth/v2/password", "", string(enableBody))
	if enabled.StatusCode != http.StatusOK {
		t.Fatalf("enable password: %d", enabled.StatusCode)
	}
	firstToken := decodeToken(enabled)
	tokens = append(tokens, firstToken)

	loginBody, err := json.Marshal(map[string]string{"password": firstPassword})
	if err != nil {
		t.Fatal(err)
	}
	login := post("/api/auth/v2/login", "", string(loginBody))
	if login.StatusCode != http.StatusOK {
		t.Fatalf("v2 login: %d", login.StatusCode)
	}
	tokens = append(tokens, decodeToken(login))
	// The refresh handle is a cookie, not body material: it is the credential
	// the refresh route carries, so it must be absent from every span too.
	handle := ""
	for _, cookie := range login.Cookies() {
		if cookie.Name == accessRefreshCookie {
			handle = cookie.Value
		}
	}
	if handle == "" {
		t.Fatal("v2 login installed no refresh handle")
	}
	tokens = append(tokens, handle)

	// The refresh route is the one carrier of the handle, and a rejected
	// handle must not be echoed back into a span.
	refresh := func(handle string) *http.Response {
		request, err := http.NewRequest(http.MethodPost, server.URL+"/api/auth/v2/refresh", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(accessV2Header, accessV2HeaderValue)
		request.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatalf("POST /api/auth/v2/refresh: %v", err)
		}
		t.Cleanup(func() { response.Body.Close() })
		return response
	}
	refreshed := refresh(handle)
	if refreshed.StatusCode != http.StatusOK {
		t.Fatalf("refresh: %d", refreshed.StatusCode)
	}
	for _, cookie := range refreshed.Cookies() {
		if cookie.Name == accessRefreshCookie {
			tokens = append(tokens, cookie.Value)
		}
	}
	const unknownHandle = "otel-unknown-handle-0001"
	if rejected := refresh(unknownHandle); rejected.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown refresh handle: %d", rejected.StatusCode)
	}
	tokens = append(tokens, unknownHandle)

	// A failed login and an unauthenticated request produce error spans.
	if response := post("/api/auth/v2/login", "", `{"password":"otel-wrong-pass-0000"}`); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("failed v2 login: %d", response.StatusCode)
	}
	passwords = append(passwords, "otel-wrong-pass-0000")
	if response := get("/api/config", nil); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous config: %d", response.StatusCode)
	}

	// Bearer on an API path, query token on every socket path, and the
	// rotation that replaces the bearer.
	if response := get("/api/config", map[string]string{"Authorization": "Bearer " + firstToken}); response.StatusCode != http.StatusNoContent {
		t.Fatalf("bearer config: %d", response.StatusCode)
	}
	for _, path := range []string{"/ws/pane/otel-pane", "/ws/md-events", "/ws/control"} {
		if response := get(path+"?token="+url.QueryEscape(firstToken), nil); response.StatusCode != http.StatusNoContent {
			t.Fatalf("query token on %s: %d", path, response.StatusCode)
		}
	}
	rotateBody, err := json.Marshal(map[string]string{"password": rotatedPassword})
	if err != nil {
		t.Fatal(err)
	}
	rotated := post("/api/auth/v2/password", firstToken, string(rotateBody))
	if rotated.StatusCode != http.StatusOK {
		t.Fatalf("rotate password: %d", rotated.StatusCode)
	}
	rotatedToken := decodeToken(rotated)
	tokens = append(tokens, rotatedToken)

	// The host-only socket carrier authenticates an upgrade; the stub handlers
	// answer the GET so the span exists without a real upgrade.
	for _, path := range []string{"/ws/pane/otel-pane", "/ws/md-events", "/ws/control"} {
		if response := get(path, map[string]string{accessSocketTokenHeader: rotatedToken}); response.StatusCode != http.StatusNoContent {
			t.Fatalf("socket carrier on %s: %d", path, response.StatusCode)
		}
	}

	// Logout takes the bearer and answers a fixed shape.
	if logout := post("/api/auth/v2/logout", rotatedToken, `{"all":false}`); logout.StatusCode != http.StatusOK {
		t.Fatalf("logout: %d", logout.StatusCode)
	}

	spans := exporter.GetSpans()
	if len(spans) == 0 {
		t.Fatal("no spans were exported")
	}
	paths := map[string]bool{}
	for _, span := range spans {
		for _, attr := range span.Attributes {
			if attr.Key == "url.path" {
				paths[attr.Value.AsString()] = true
			}
			if attr.Key == "url.query" || attr.Key == "http.target" || attr.Key == "url.full" {
				t.Errorf("span %q records %q, which can carry a query credential", span.Name, attr.Key)
			}
		}
		for _, value := range spanStrings(span) {
			for _, password := range passwords {
				if strings.Contains(value, password) {
					t.Errorf("span %q leaked a password", span.Name)
				}
			}
			for _, token := range tokens {
				if strings.Contains(value, token) {
					t.Errorf("span %q leaked a token", span.Name)
				}
			}
			if strings.Contains(value, "Bearer ") || strings.Contains(value, "token=") {
				t.Errorf("span %q leaked a credential-bearing value", span.Name)
			}
		}
	}
	for _, path := range []string{"/api/auth/v2/login", "/api/auth/v2/password", "/api/auth/v2/refresh", "/api/auth/v2/logout", "/api/config", "/ws/pane/otel-pane", "/ws/md-events", "/ws/control"} {
		if !paths[path] {
			t.Errorf("no span recorded url.path %q (paths seen: %s)", path, fmt.Sprint(paths))
		}
	}
}
