package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	accessPasswordHashVersion    = "v1"
	accessPasswordHashAlgorithm  = "pbkdf2-sha256"
	accessPasswordHashIterations = 600000
	accessPasswordSaltBytes      = 16
	accessPasswordVerifierBytes  = 32
	accessChallengeTTL           = 5 * time.Minute
	accessSessionTTL             = 365 * 24 * time.Hour
	accessSessionCookie          = "phi_access_session"
	maxAccessChallenges          = 1024
)

var (
	errAccessUnauthorized = errors.New("access authentication required")
	errAccessRateLimited  = errors.New("too many failed password attempts; try again shortly")
)

type accessPasswordRecord struct {
	Salt     []byte
	Verifier []byte
}

func (r accessPasswordRecord) encoded() string {
	return strings.Join([]string{
		accessPasswordHashVersion,
		accessPasswordHashAlgorithm,
		strconv.Itoa(accessPasswordHashIterations),
		base64.RawURLEncoding.EncodeToString(r.Salt),
		base64.RawURLEncoding.EncodeToString(r.Verifier),
	}, ".")
}

// parseAccessPasswordHash accepts the only verifier format Phi writes. The
// browser derives the verifier; Phi stores it without ever receiving the raw
// password. The salt and work factor are public KDF parameters, while the
// derived verifier remains secret and is never returned by an API.
func parseAccessPasswordHash(encoded string) (*accessPasswordRecord, error) {
	if encoded == "" {
		return nil, nil
	}
	parts := strings.Split(encoded, ".")
	if len(parts) != 5 || parts[0] != accessPasswordHashVersion || parts[1] != accessPasswordHashAlgorithm {
		return nil, errors.New("invalid access password hash format")
	}
	iterations, err := strconv.Atoi(parts[2])
	if err != nil || iterations != accessPasswordHashIterations {
		return nil, errors.New("unsupported access password hash parameters")
	}
	salt, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(salt) != accessPasswordSaltBytes {
		return nil, errors.New("invalid access password hash salt")
	}
	verifier, err := base64.RawURLEncoding.DecodeString(parts[4])
	if err != nil || len(verifier) != accessPasswordVerifierBytes {
		return nil, errors.New("invalid access password hash verifier")
	}
	return &accessPasswordRecord{Salt: salt, Verifier: verifier}, nil
}

type accessLoginAttempt struct {
	Failures    int
	RetryAt     time.Time
	LastFailure time.Time
}

type accessAuthManager struct {
	mu         sync.Mutex
	record     *accessPasswordRecord
	challenges map[string]time.Time
	sessions   map[string]time.Time
	attempts   map[string]accessLoginAttempt
}

func newAccessAuthManager() *accessAuthManager {
	return &accessAuthManager{
		challenges: make(map[string]time.Time),
		sessions:   make(map[string]time.Time),
		attempts:   make(map[string]accessLoginAttempt),
	}
}

var accessAuth = newAccessAuthManager()

func (m *accessAuthManager) configure(encoded string) error {
	record, err := parseAccessPasswordHash(encoded)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.record = record
	m.challenges = make(map[string]time.Time)
	m.sessions = make(map[string]time.Time)
	m.attempts = make(map[string]accessLoginAttempt)
	return nil
}

func (m *accessAuthManager) enabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.record != nil
}

// statusAndChallenge returns public KDF parameters and a single-use login
// challenge from one locked snapshot, so a concurrent password change cannot
// pair an old salt with a challenge for the new verifier.
func (m *accessAuthManager) statusAndChallenge() (enabled bool, salt, challenge string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.record == nil {
		return false, "", "", nil
	}
	now := time.Now()
	m.cleanExpiredLocked(now)
	if len(m.challenges) >= maxAccessChallenges {
		return false, "", "", errors.New("too many pending login attempts")
	}
	challenge, err = randomAccessToken()
	if err != nil {
		return false, "", "", err
	}
	m.challenges[challenge] = now.Add(accessChallengeTTL)
	return true, base64.RawURLEncoding.EncodeToString(m.record.Salt), challenge, nil
}

func (m *accessAuthManager) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(accessSessionCookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expiresAt, ok := m.sessions[cookie.Value]
	if !ok || !expiresAt.After(time.Now()) {
		delete(m.sessions, cookie.Value)
		return false
	}
	return true
}

func (m *accessAuthManager) login(challenge, proof, remoteAddr string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.cleanExpiredLocked(now)
	if m.record == nil {
		return "", nil
	}

	client := accessClientIP(remoteAddr)
	if attempt, ok := m.attempts[client]; ok && attempt.RetryAt.After(now) {
		return "", errAccessRateLimited
	}

	expiresAt, ok := m.challenges[challenge]
	delete(m.challenges, challenge) // one-time, including bad attempts
	if !ok || !expiresAt.After(now) {
		m.recordFailureLocked(client, now)
		return "", errAccessUnauthorized
	}
	got, err := base64.RawURLEncoding.DecodeString(proof)
	if err != nil || len(got) != sha256.Size {
		m.recordFailureLocked(client, now)
		return "", errAccessUnauthorized
	}
	mac := hmac.New(sha256.New, m.record.Verifier)
	_, _ = mac.Write([]byte(challenge))
	want := mac.Sum(nil)
	if subtle.ConstantTimeCompare(got, want) != 1 {
		m.recordFailureLocked(client, now)
		return "", errAccessUnauthorized
	}

	delete(m.attempts, client)
	return m.newSessionLocked(now)
}

// updatePassword atomically prevents an unauthenticated caller from replacing
// a password that became enabled between middleware evaluation and this
// handler. A new verifier invalidates all prior sessions.
func (m *accessAuthManager) updatePassword(encoded string, authorized bool) (token string, revokeLiveConnections bool, err error) {
	record, err := parseAccessPasswordHash(encoded)
	if err != nil {
		return "", false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.record != nil && !authorized {
		return "", false, errAccessUnauthorized
	}
	revokeLiveConnections = m.record != nil || record != nil
	m.record = record
	m.challenges = make(map[string]time.Time)
	m.sessions = make(map[string]time.Time)
	m.attempts = make(map[string]accessLoginAttempt)
	if record == nil {
		return "", revokeLiveConnections, nil
	}
	token, err = m.newSessionLocked(time.Now())
	return token, revokeLiveConnections, err
}

func (m *accessAuthManager) newSessionLocked(now time.Time) (string, error) {
	m.cleanExpiredLocked(now)
	token, err := randomAccessToken()
	if err != nil {
		return "", err
	}
	m.sessions[token] = now.Add(accessSessionTTL)
	return token, nil
}

func (m *accessAuthManager) recordFailureLocked(client string, now time.Time) {
	attempt := m.attempts[client]
	attempt.Failures++
	// 1, 2, 4, ... seconds, capped at a minute. This is deliberately
	// in-memory: restart resets it, matching Phi's no-account design.
	delay := time.Second << min(attempt.Failures-1, 6)
	attempt.RetryAt = now.Add(delay)
	attempt.LastFailure = now
	m.attempts[client] = attempt
}

func (m *accessAuthManager) cleanExpiredLocked(now time.Time) {
	for challenge, expiresAt := range m.challenges {
		if !expiresAt.After(now) {
			delete(m.challenges, challenge)
		}
	}
	for session, expiresAt := range m.sessions {
		if !expiresAt.After(now) {
			delete(m.sessions, session)
		}
	}
	for client, attempt := range m.attempts {
		if !attempt.LastFailure.Add(15 * time.Minute).After(now) {
			delete(m.attempts, client)
		}
	}
}

func randomAccessToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func accessClientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}
	return remoteAddr
}

func accessAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if accessAuthPublicPath(r.URL.Path) || !accessAuth.enabled() || accessAuth.authenticated(r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "access authentication required", http.StatusUnauthorized)
	})
}

func accessAuthPublicPath(path string) bool {
	switch path {
	case "/api/auth/status", "/api/auth/login", "/livez", "/healthz", "/readyz":
		return true
	}
	return !strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/ws/")
}

func handleAccessAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	enabled, salt, challenge, err := accessAuth.statusAndChallenge()
	if err != nil {
		http.Error(w, "Unable to start login: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	payload := map[string]interface{}{
		"enabled":       enabled,
		"authenticated": enabled && accessAuth.authenticated(r),
	}
	if enabled {
		payload["version"] = accessPasswordHashVersion
		payload["algorithm"] = accessPasswordHashAlgorithm
		payload["iterations"] = accessPasswordHashIterations
		payload["salt"] = salt
		payload["challenge"] = challenge
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func handleAccessAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Challenge string `json:"challenge"`
		Proof     string `json:"proof"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "Invalid login request", http.StatusBadRequest)
		return
	}
	token, err := accessAuth.login(req.Challenge, req.Proof, r.RemoteAddr)
	if err != nil {
		if errors.Is(err, errAccessRateLimited) {
			http.Error(w, err.Error(), http.StatusTooManyRequests)
			return
		}
		if errors.Is(err, errAccessUnauthorized) {
			http.Error(w, "Invalid password", http.StatusUnauthorized)
			return
		}
		http.Error(w, "Unable to login", http.StatusInternalServerError)
		return
	}
	if token != "" {
		setAccessSessionCookie(w, r, token)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func handleAccessPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PasswordHash string `json:"password_hash"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		return
	}
	if len(req.PasswordHash) > 512 {
		http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		return
	}
	authorized := accessAuth.authenticated(r)
	token, revokeLiveConnections, err := accessAuth.updatePassword(req.PasswordHash, authorized)
	if err != nil {
		if errors.Is(err, errAccessUnauthorized) {
			http.Error(w, "access authentication required", http.StatusUnauthorized)
			return
		}
		http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	cfg.AccessPasswordHash = req.PasswordHash
	saveConfig(cfg)
	if revokeLiveConnections && wsHub != nil {
		// Sessions are invalidated above; close already-upgraded sockets too so
		// an old browser cannot keep driving a terminal until it reconnects.
		wsHub.CloseAllClients()
	}
	if token == "" {
		clearAccessSessionCookie(w, r)
	} else {
		setAccessSessionCookie(w, r, token)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": token != ""})
}

func setAccessSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     accessSessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  time.Now().Add(accessSessionTTL),
		MaxAge:   int(accessSessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearAccessSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     accessSessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
