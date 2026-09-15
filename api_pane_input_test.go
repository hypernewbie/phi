package main

import (
	"context"
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
