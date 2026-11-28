package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// testKanbanUpstream is a mock Vikunja: it counts logins, answers the board,
// and can be told to rate-limit or to reject the session.
type testKanbanUpstream struct {
	server   *httptest.Server
	logins   atomic.Int64
	requests atomic.Int64
	// rateLimit makes every login answer 429 with a reset hint.
	rateLimit atomic.Bool
	// rejectOnce makes the first board request answer 401.
	rejectOnce atomic.Bool
}

func newTestKanbanUpstream(t *testing.T) *testKanbanUpstream {
	t.Helper()
	up := &testKanbanUpstream{}
	up.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/login":
			up.logins.Add(1)
			if up.rateLimit.Load() {
				w.Header().Set("X-Ratelimit-Limit", "10")
				w.Header().Set("X-Ratelimit-Remaining", "0")
				w.Header().Set("X-Ratelimit-Reset", "1")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"message":"Too Many Requests"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{
				"token": "test-token",
			})
		case r.URL.Path == "/api/v1/projects":
			up.requests.Add(1)
			if up.rejectOnce.CompareAndSwap(true, false) {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"message":"Unauthorized"}`))
				return
			}
			if r.Header.Get("Authorization") != "Bearer test-token" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"id":1,"title":"Demo"}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(up.server.Close)
	return up
}

// configureKanban points the server's vault at the mock instance.
func configureKanban(t *testing.T, up *testKanbanUpstream) {
	t.Helper()
	enc, err := EncryptVault("secret")
	if err != nil {
		t.Fatal(err)
	}
	cfg := testServer.loadConfig()
	cfg.KanbanURL = up.server.URL
	cfg.KanbanUsername = "tester"
	cfg.KanbanPasswordEnc = enc
	testServer.saveConfig(cfg)
}

// The session belongs to the server: many clients share one login, and the
// token never reaches the browser.
func TestKanbanSession_OneLoginServesEveryClient(t *testing.T) {
	withTempConfig(t)
	up := newTestKanbanUpstream(t)
	configureKanban(t, up)

	for round := 0; round < 3; round++ {
		req := httptest.NewRequest(http.MethodPost, "/api/kanban/session", nil)
		w := httptest.NewRecorder()
		testServer.handleKanbanSession(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("round %d: session status %d: %s", round, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "test-token") {
			t.Fatalf("round %d: the session token reached the browser: %s", round, w.Body.String())
		}
	}
	if got := up.logins.Load(); got != 1 {
		t.Fatalf("expected 1 upstream login for 3 clients, got %d", got)
	}
}

// An upstream 429 must not be walked into: the server waits out the window
// the instance asked for and answers the client with the same wait.
func TestKanbanSession_RateLimitIsHonouredNotRetried(t *testing.T) {
	withTempConfig(t)
	up := newTestKanbanUpstream(t)
	configureKanban(t, up)
	up.rateLimit.Store(true)

	req := httptest.NewRequest(http.MethodPost, "/api/kanban/session", nil)
	w := httptest.NewRecorder()
	testServer.handleKanbanSession(w, req)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Retry-After") == "" {
		t.Error("expected a Retry-After hint for the client")
	}
	if strings.Contains(w.Body.String(), "Too Many Requests") &&
		strings.Contains(w.Body.String(), "{") &&
		!strings.Contains(w.Body.String(), "\"message\"") {
		t.Errorf("expected a readable message, got %s", w.Body.String())
	}

	// The second client must not reach the upstream: the cooldown is local.
	req2 := httptest.NewRequest(http.MethodPost, "/api/kanban/session", nil)
	w2 := httptest.NewRecorder()
	testServer.handleKanbanSession(w2, req2)
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 during the cooldown, got %d", w2.Code)
	}
	if got := up.logins.Load(); got != 1 {
		t.Fatalf("expected 1 upstream login during the cooldown, got %d", got)
	}
}

// A stale token refreshes once and replays the request. The client sees the
// board, never the token.
func TestKanbanAPI_RefreshesOnceAndReplays(t *testing.T) {
	withTempConfig(t)
	up := newTestKanbanUpstream(t)
	configureKanban(t, up)
	up.rejectOnce.Store(true)

	req := httptest.NewRequest(http.MethodGet, "/api/kanban/v1/projects", nil)
	w := httptest.NewRecorder()
	testServer.handleKanbanAPI(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 after one refresh, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Demo") {
		t.Errorf("expected the board payload, got %s", w.Body.String())
	}
	if got := up.logins.Load(); got != 2 {
		t.Fatalf("expected 2 logins (one stale, one refresh), got %d", got)
	}
}

// The board request carries the server's token; the browser never sees it.
func TestKanbanAPI_KeepsTheTokenServerSide(t *testing.T) {
	withTempConfig(t)
	up := newTestKanbanUpstream(t)
	configureKanban(t, up)

	req := httptest.NewRequest(http.MethodGet, "/api/kanban/v1/projects", nil)
	w := httptest.NewRecorder()
	testServer.handleKanbanAPI(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "test-token") {
		t.Errorf("the token reached the browser: %s", w.Body.String())
	}
	if w.Header().Get("Set-Cookie") != "" {
		t.Error("an upstream cookie leaked into phi's origin")
	}
}

// A missing configuration is a client-side question, not a gateway failure.
func TestKanbanSession_WithoutCredentials(t *testing.T) {
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodPost, "/api/kanban/session", nil)
	w := httptest.NewRecorder()
	testServer.handleKanbanSession(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 without credentials, got %d: %s", w.Code, w.Body.String())
	}
}

// The login floor keeps a burst of clients to one upstream call per window.
func TestKanbanSession_LoginFloorHoldsTheBurst(t *testing.T) {
	withTempConfig(t)
	up := newTestKanbanUpstream(t)
	configureKanban(t, up)

	done := make(chan struct{})
	for worker := 0; worker < 4; worker++ {
		go func() {
			defer func() { done <- struct{}{} }()
			req := httptest.NewRequest(http.MethodPost, "/api/kanban/session", nil)
			w := httptest.NewRecorder()
			testServer.handleKanbanSession(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("concurrent session status %d: %s", w.Code, w.Body.String())
			}
		}()
	}
	for worker := 0; worker < 4; worker++ {
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("a concurrent session request never finished")
		}
	}
	if got := up.logins.Load(); got != 1 {
		t.Fatalf("expected 1 upstream login for a burst of 4 clients, got %d", got)
	}
}
