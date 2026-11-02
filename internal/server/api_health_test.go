package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestLivez — GET -> 200 "ok"; POST -> 405. Lock-free and state-independent,
// so no fixture setup needed.
func TestLivez(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/livez", nil)
	w := httptest.NewRecorder()
	HandleLivez(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /livez: got %d want 200", w.Code)
	}
	if w.Body.String() != "ok\n" {
		t.Errorf("GET /livez body: got %q want %q", w.Body.String(), "ok\n")
	}

	req = httptest.NewRequest(http.MethodPost, "/livez", nil)
	w = httptest.NewRecorder()
	HandleLivez(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /livez: got %d want 405", w.Code)
	}
}

// TestReadyzReady — ShuttingDown=false -> 200 "ready".
func TestReadyzReady(t *testing.T) {
	ShuttingDown.Store(false)
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	w := httptest.NewRecorder()
	HandleReadyz(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /readyz: got %d want 200", w.Code)
	}
	if w.Body.String() != "ready\n" {
		t.Errorf("GET /readyz body: got %q want %q", w.Body.String(), "ready\n")
	}
}

// TestReadyzDraining — ShuttingDown=true -> 503 "shutting down".
func TestReadyzDraining(t *testing.T) {
	ShuttingDown.Store(true)
	t.Cleanup(func() { ShuttingDown.Store(false) })

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	w := httptest.NewRecorder()
	HandleReadyz(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /readyz while draining: got %d want 503", w.Code)
	}
	if w.Body.String() != "shutting down\n" {
		t.Errorf("GET /readyz while draining body: got %q want %q", w.Body.String(), "shutting down\n")
	}
}

// TestReadyzRequiresGet — POST -> 405.
func TestReadyzRequiresGet(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/readyz", nil)
	w := httptest.NewRecorder()
	HandleReadyz(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /readyz: got %d want 405", w.Code)
	}
}
