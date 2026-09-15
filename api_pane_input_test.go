package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
)

// Remote keyboard (web/input.html): POST /api/terminals/:id/input writes
// to PTY stdin without touching any reader state.

func withPaneManager(t *testing.T) *pty.Manager {
	t.Helper()
	withTempConfig(t)
	m := pty.NewManager()
	orig := ptyManager
	ptyManager = m
	t.Cleanup(func() {
		ptyManager = orig
		m.Shutdown(2 * time.Second)
	})
	return m
}

func TestPaneInputPayloadBytes(t *testing.T) {
	// Byte-parity with the main UI's staged Send (sendStagedInput in
	// web/terminal.js). TUI coders only register Enter on \r — a \n
	// here is the "typed but never submitted" bug.
	cases := []struct{ in, want string }{
		{"yo", "yo\r"},
		{"  yo  ", "yo\r"}, // trimmed like the staged bar
		{"seventeen chars ok", "\x1b[200~seventeen chars ok\x1b[201~\r"}, // 18 runes: wrapped
		{"a reasonably long prompt", "\x1b[200~a reasonably long prompt\x1b[201~\r"},
		{"line one\nline two", "\x1b[200~line one\nline two\x1b[201~\r"},
	}
	for _, c := range cases {
		if got := paneInputPayload(c.in); got != c.want {
			t.Errorf("paneInputPayload(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPaneInput_PaneNotFound(t *testing.T) {
	withPaneManager(t)
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/terminals/does-not-exist/input",
		strings.NewReader(`{"text":"hi"}`),
	)
	w := httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("status: want 404, got %d — %s", w.Code, w.Body.String())
	}
}

func TestPaneInput_BadBody(t *testing.T) {
	withPaneManager(t)
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/terminals/whatever/input",
		strings.NewReader(`{bad json`),
	)
	w := httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status: want 400, got %d — %s", w.Code, w.Body.String())
	}
}

// The remote-keyboard endpoint rides the same access-auth gate as every
// other /api route: with a password set and no session cookie it must 401,
// and after a real login it must reach the handler.
func TestPaneInput_RequiresAccessAuth(t *testing.T) {
	withPaneManager(t)
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatalf("configure: %v", err)
	}

	guarded := accessAuthMiddleware(http.HandlerFunc(handleFallback))

	// No cookie: the gate rejects before the handler runs.
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/terminals/some-pane/input",
		strings.NewReader(`{"text":"yo"}`),
	)
	w := httptest.NewRecorder()
	guarded.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("no-cookie status: want 401, got %d — %s", w.Code, w.Body.String())
	}

	// Real login (challenge/proof, same dance as auth_test), then the
	// request passes the gate and reaches the handler (404: pane doesn't
	// exist, which proves it got past auth).
	statusW := httptest.NewRecorder()
	handleAccessAuthStatus(statusW, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	var status map[string]any
	if err := json.Unmarshal(statusW.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	record, err := parseAccessPasswordHash(testAccessHash())
	if err != nil {
		t.Fatal(err)
	}
	challenge := status["challenge"].(string)
	loginBody := `{"challenge":"` + challenge + `","proof":"` + testAccessProof(t, record.Verifier, challenge) + `"}`
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(loginBody))
	loginReq.RemoteAddr = "192.0.2.20:12345"
	loginW := httptest.NewRecorder()
	handleAccessAuthLogin(loginW, loginReq)
	if loginW.Code != http.StatusOK {
		t.Fatalf("login: got %d body=%s", loginW.Code, loginW.Body.String())
	}
	cookie := loginW.Result().Cookies()[0]

	req2 := httptest.NewRequest(
		http.MethodPost,
		"/api/terminals/some-pane/input",
		strings.NewReader(`{"text":"yo"}`),
	)
	req2.AddCookie(cookie)
	w2 := httptest.NewRecorder()
	guarded.ServeHTTP(w2, req2)
	if w2.Code != http.StatusNotFound {
		t.Errorf("post-login status: want 404 (past the gate, unknown pane), got %d — %s", w2.Code, w2.Body.String())
	}
}

func TestPaneInput_WritesToPty(t *testing.T) {
	// Needs a POSIX cat(1): native on unix, via PHI_TEST_POSIX_SH=1 with
	// git-bash on Windows CI/dev (CI itself is ubuntu and just runs it).
	if runtime.GOOS == "windows" && os.Getenv("PHI_TEST_POSIX_SH") == "" {
		t.Skip("needs a POSIX cat(1)")
	}
	m := withPaneManager(t)
	inst, err := m.Spawn(context.Background(), "", "cat", nil, "shell", "kb-test")
	if err != nil {
		t.Fatalf("spawn cat: %v", err)
	}

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/terminals/"+inst.ID+"/input",
		strings.NewReader(`{"text":"hello-remote"}`),
	)
	w := httptest.NewRecorder()
	handleFallback(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status: want 204, got %d — %s", w.Code, w.Body.String())
	}

	// cat echoes stdin: the handler's text+\n must come back out the
	// pane's stdout. Bounded wait so a regression fails, never hangs.
	type result struct {
		data string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		var sb strings.Builder
		buf := make([]byte, 256)
		for !strings.Contains(sb.String(), "hello-remote") {
			n, err := inst.Pty.Read(buf)
			if err != nil {
				done <- result{err: err}
				return
			}
			sb.Write(buf[:n])
		}
		done <- result{data: sb.String()}
	}()
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("pty read: %v", r.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for cat echo")
	}
}
