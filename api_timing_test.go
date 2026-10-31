package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/pkg/obs"
)

// timingTestCookie completes the access-auth login flow and returns the
// session cookie, reusing the auth_test.go fixtures. No real credentials.
func timingTestCookie(t *testing.T) *http.Cookie {
	t.Helper()
	statusW := httptest.NewRecorder()
	handleAccessAuthStatus(statusW, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if statusW.Code != http.StatusOK {
		t.Fatalf("status: got %d", statusW.Code)
	}
	var status map[string]any
	if err := json.Unmarshal(statusW.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	record, err := parseAccessPasswordHash(testAccessHash())
	if err != nil {
		t.Fatal(err)
	}
	challenge := status["challenge"].(string)
	body := `{"challenge":"` + challenge + `","proof":"` + testAccessProof(t, record.Verifier, challenge) + `"}`
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(body))
	loginReq.RemoteAddr = "192.0.2.15:12345"
	loginW := httptest.NewRecorder()
	handleAccessAuthLogin(loginW, loginReq)
	if loginW.Code != http.StatusOK {
		t.Fatalf("login: got %d body=%s", loginW.Code, loginW.Body.String())
	}
	cookies := loginW.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %d", len(cookies))
	}
	return cookies[0]
}

func TestTimingSkipsRejectedAuthRequests(t *testing.T) {
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	reached := false
	mux := http.NewServeMux()
	mux.HandleFunc("/api/thing", func(w http.ResponseWriter, r *http.Request) { reached = true })
	handler := accessAuthMiddleware(obs.WrapTimingHTTP(mux))

	capture, ok := obs.BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/thing", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if reached {
		t.Fatal("rejected request reached the handler")
	}
	snapshot := capture.Finish()
	if snapshot.RootsSeen != 0 || snapshot.RootsAdmitted != 0 {
		t.Fatalf("rejected request was recorded: %+v", snapshot)
	}
}

func TestTimingRecordsAuthenticatedRequests(t *testing.T) {
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	cookie := timingTestCookie(t)
	reached := false
	mux := http.NewServeMux()
	mux.HandleFunc("/api/thing", func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusNoContent)
	})
	handler := accessAuthMiddleware(obs.WrapTimingHTTP(mux))

	capture, ok := obs.BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
	req.AddCookie(cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusNoContent || !reached {
		t.Fatalf("status = %d reached = %t", recorder.Code, reached)
	}
	snapshot := capture.Finish()
	if snapshot.RootsSeen != 1 || snapshot.RootsAdmitted != 1 || snapshot.RootsExported != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
	if snapshot.Roots[0].Name != "http GET /api/thing" {
		t.Fatalf("name = %q", snapshot.Roots[0].Name)
	}
}
