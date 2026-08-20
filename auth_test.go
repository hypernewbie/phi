package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func useTestAccessAuth(t *testing.T) *accessAuthManager {
	t.Helper()
	previous := accessAuth
	accessAuth = newAccessAuthManager()
	t.Cleanup(func() { accessAuth = previous })
	return accessAuth
}

func testAccessHash() string {
	salt := bytes.Repeat([]byte{0x11}, accessPasswordSaltBytes)
	verifier := bytes.Repeat([]byte{0x22}, accessPasswordVerifierBytes)
	return accessPasswordRecord{Salt: salt, Verifier: verifier}.encoded()
}

func testAccessProof(t *testing.T, verifier []byte, challenge string) string {
	t.Helper()
	mac := hmac.New(sha256.New, verifier)
	_, _ = mac.Write([]byte(challenge))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestAccessPasswordHashRoundTripAndRejectsInvalidValues(t *testing.T) {
	record, err := parseAccessPasswordHash(testAccessHash())
	if err != nil {
		t.Fatalf("parse valid verifier: %v", err)
	}
	if record == nil || len(record.Salt) != accessPasswordSaltBytes || len(record.Verifier) != accessPasswordVerifierBytes {
		t.Fatalf("parsed invalid record: %#v", record)
	}
	if record.encoded() != testAccessHash() {
		t.Errorf("round trip: got %q want %q", record.encoded(), testAccessHash())
	}
	for _, invalid := range []string{
		"v1.pbkdf2-sha256.1.salt.verifier",
		"v2.pbkdf2-sha256.600000.salt.verifier",
		"v1.pbkdf2-sha1.600000.salt.verifier",
		"not-a-record",
	} {
		if _, err := parseAccessPasswordHash(invalid); err == nil {
			t.Errorf("parseAccessPasswordHash(%q) unexpectedly succeeded", invalid)
		}
	}
	if record, err := parseAccessPasswordHash(""); err != nil || record != nil {
		t.Errorf("empty verifier = disabled: record=%#v err=%v", record, err)
	}
}

func TestAccessAuthMiddlewareDisabledAndEnabledCoverage(t *testing.T) {
	auth := useTestAccessAuth(t)
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	handler := accessAuthMiddleware(next)

	for _, path := range []string{"/api/coders", "/ws/pane/a"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusNoContent {
			t.Errorf("disabled auth %s: got %d want 204", path, w.Code)
		}
	}
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/coders", "/api/auth/password", "/ws/pane/a"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusUnauthorized {
			t.Errorf("protected %s: got %d want 401", path, w.Code)
		}
	}
	for _, path := range []string{"/", "/app.js", "/livez", "/healthz", "/readyz", "/api/auth/status", "/api/auth/login"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusNoContent {
			t.Errorf("public %s: got %d want 204", path, w.Code)
		}
	}
}

func TestAccessLoginUsesOneTimeProofAndIssuesSession(t *testing.T) {
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}

	statusW := httptest.NewRecorder()
	handleAccessAuthStatus(statusW, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if statusW.Code != http.StatusOK {
		t.Fatalf("status: got %d body=%s", statusW.Code, statusW.Body.String())
	}
	var status map[string]any
	if err := json.Unmarshal(statusW.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status["enabled"] != true || status["salt"] == "" || status["challenge"] == "" {
		t.Fatalf("status missing public KDF data: %v", status)
	}
	if _, leaked := status["verifier"]; leaked {
		t.Fatalf("status leaked verifier: %v", status)
	}

	record, err := parseAccessPasswordHash(testAccessHash())
	if err != nil {
		t.Fatal(err)
	}
	challenge := status["challenge"].(string)
	loginBody := `{"challenge":"` + challenge + `","proof":"` + testAccessProof(t, record.Verifier, challenge) + `"}`
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(loginBody))
	loginReq.RemoteAddr = "192.0.2.14:12345"
	loginW := httptest.NewRecorder()
	handleAccessAuthLogin(loginW, loginReq)
	if loginW.Code != http.StatusOK {
		t.Fatalf("login: got %d body=%s", loginW.Code, loginW.Body.String())
	}
	cookies := loginW.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != accessSessionCookie || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("unexpected session cookie: %#v", cookies)
	}

	protected := accessAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	protectedReq := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	protectedReq.AddCookie(cookies[0])
	protectedW := httptest.NewRecorder()
	protected.ServeHTTP(protectedW, protectedReq)
	if protectedW.Code != http.StatusNoContent {
		t.Errorf("session did not authorize protected request: %d", protectedW.Code)
	}
	statusReq := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	statusReq.AddCookie(cookies[0])
	statusWithSessionW := httptest.NewRecorder()
	handleAccessAuthStatus(statusWithSessionW, statusReq)
	var statusWithSession map[string]any
	if err := json.Unmarshal(statusWithSessionW.Body.Bytes(), &statusWithSession); err != nil || statusWithSession["authenticated"] != true {
		t.Errorf("status did not recognize durable session: body=%s err=%v", statusWithSessionW.Body.String(), err)
	}

	// A proof is tied to one challenge and cannot be replayed.
	replayReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(loginBody))
	replayReq.RemoteAddr = "192.0.2.14:12345"
	replayW := httptest.NewRecorder()
	handleAccessAuthLogin(replayW, replayReq)
	if replayW.Code != http.StatusUnauthorized {
		t.Errorf("replayed proof: got %d want 401", replayW.Code)
	}
}

func TestAccessPasswordHandlerPersistsAndInvalidatesSessions(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)

	setReq := httptest.NewRequest(http.MethodPost, "/api/auth/password", strings.NewReader(`{"password_hash":"`+testAccessHash()+`"}`))
	setW := httptest.NewRecorder()
	handleAccessPassword(setW, setReq)
	if setW.Code != http.StatusOK {
		t.Fatalf("set password: got %d body=%s", setW.Code, setW.Body.String())
	}
	firstCookie := setW.Result().Cookies()[0]
	if got := loadConfig().AccessPasswordHash; got != testAccessHash() {
		t.Errorf("saved hash: got %q want %q", got, testAccessHash())
	}
	configW := httptest.NewRecorder()
	handleConfig(configW, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if strings.Contains(configW.Body.String(), "access_password_hash") || strings.Contains(configW.Body.String(), testAccessHash()) {
		t.Errorf("/api/config leaked the access verifier: %s", configW.Body.String())
	}

	// Generate a valid different verifier rather than relying on base64 text.
	changedHash := accessPasswordRecord{
		Salt:     bytes.Repeat([]byte{0x33}, accessPasswordSaltBytes),
		Verifier: bytes.Repeat([]byte{0x44}, accessPasswordVerifierBytes),
	}.encoded()
	changeReq := httptest.NewRequest(http.MethodPost, "/api/auth/password", strings.NewReader(`{"password_hash":"`+changedHash+`"}`))
	changeReq.AddCookie(firstCookie)
	changeW := httptest.NewRecorder()
	handleAccessPassword(changeW, changeReq)
	if changeW.Code != http.StatusOK {
		t.Fatalf("change password: got %d body=%s", changeW.Code, changeW.Body.String())
	}

	protected := accessAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	oldSessionReq := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	oldSessionReq.AddCookie(firstCookie)
	oldSessionW := httptest.NewRecorder()
	protected.ServeHTTP(oldSessionW, oldSessionReq)
	if oldSessionW.Code != http.StatusUnauthorized {
		t.Errorf("old session survived password change: got %d", oldSessionW.Code)
	}

	clearReq := httptest.NewRequest(http.MethodPost, "/api/auth/password", strings.NewReader(`{"password_hash":""}`))
	clearReq.AddCookie(changeW.Result().Cookies()[0])
	clearW := httptest.NewRecorder()
	handleAccessPassword(clearW, clearReq)
	if clearW.Code != http.StatusOK {
		t.Fatalf("clear password: got %d body=%s", clearW.Code, clearW.Body.String())
	}
	if got := loadConfig().AccessPasswordHash; got != "" || accessAuth.enabled() {
		t.Errorf("clear did not disable access password: config=%q enabled=%v", got, accessAuth.enabled())
	}
}

func TestAccessSessionSurvivesServerRestart(t *testing.T) {
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}

	record, err := parseAccessPasswordHash(testAccessHash())
	if err != nil {
		t.Fatal(err)
	}

	_, _, challenge, err := auth.statusAndChallenge()
	if err != nil {
		t.Fatal(err)
	}

	token, err := auth.login(challenge, testAccessProof(t, record.Verifier, challenge), "127.0.0.1:12345")
	if err != nil || token == "" {
		t.Fatalf("login failed: token=%q err=%v", token, err)
	}

	cookie := &http.Cookie{Name: accessSessionCookie, Value: token}

	// Simulate server process restart: re-create manager with empty in-memory sessions
	restartedAuth := newAccessAuthManager()
	if err := restartedAuth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	accessAuth = restartedAuth

	protected := accessAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	protected.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("session failed to survive server restart: got %d want 204", w.Code)
	}

	statusReq := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	statusReq.AddCookie(cookie)
	statusW := httptest.NewRecorder()
	handleAccessAuthStatus(statusW, statusReq)
	var status map[string]any
	if err := json.Unmarshal(statusW.Body.Bytes(), &status); err != nil || status["authenticated"] != true {
		t.Fatalf("status did not recognize session after restart: %v", status)
	}
}

func TestAccessSessionRejectsTamperedOrInvalidTokens(t *testing.T) {
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}

	protected := accessAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, invalidToken := range []string{
		"not-a-valid-token",
		"nonce.invalidexpiry.signature",
		"nonce.0.signature", // Expired unix timestamp
		"nonce.9999999999.badsig",
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
		req.AddCookie(&http.Cookie{Name: accessSessionCookie, Value: invalidToken})
		w := httptest.NewRecorder()
		protected.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("token %q unexpectedly succeeded: got %d want 401", invalidToken, w.Code)
		}
	}
}
