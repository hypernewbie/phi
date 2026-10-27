package main

import (
	"bytes"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	accessPasswordHashVersion    = "v1"
	accessPasswordHashAlgorithm  = "pbkdf2-sha256"
	accessPasswordHashIterations = 600000
	accessPasswordMinIterations  = 100000
	accessPasswordMaxIterations  = 10000000
	accessPasswordSaltBytes      = 16
	accessPasswordVerifierBytes  = 32
	accessChallengeTTL           = 5 * time.Minute
	accessSessionTTL             = 100 * 365 * 24 * time.Hour
	accessSessionCookie          = "phi_access_session"
	maxAccessChallenges          = 1024
	accessJWTAlgorithm           = "HS256"
	accessJWTProtocol            = "v2"
	accessJWTType                = "JWT"
	accessJWTIssuer              = "phi"
	accessJWTKeyBytes            = 32
	accessJWTNonceBytes          = 32
	accessJWTInfo                = "phi/access-jwt/v1"
	accessJWTLifetime            = accessSessionTTL
	accessPasswordMinBytes       = 8
	accessPasswordMaxBytes       = 1024
	accessPasswordBodyLimit      = 8192
)

var (
	errAccessUnauthorized = errors.New("access authentication required")
	errAccessRateLimited  = errors.New("too many failed password attempts; try again shortly")
	errAccessJWTInvalid   = errors.New("invalid access token")
	errAccessPersistence  = errors.New("unable to persist access password")
	errAccessNotEnabled   = errors.New("access password is not enabled")
)

type accessPasswordRecord struct {
	Iterations int
	Salt       []byte
	Verifier   []byte
}

func (r accessPasswordRecord) encoded() string {
	return strings.Join([]string{
		accessPasswordHashVersion,
		accessPasswordHashAlgorithm,
		strconv.Itoa(r.Iterations),
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
	if err != nil || iterations < accessPasswordMinIterations || iterations > accessPasswordMaxIterations {
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
	return &accessPasswordRecord{Iterations: iterations, Salt: salt, Verifier: verifier}, nil
}

// deriveAccessVerifier runs PBKDF2-SHA256 at the record's own iteration count.
func deriveAccessVerifier(password string, salt []byte, iterations int) ([]byte, error) {
	return pbkdf2.Key(sha256.New, password, salt, iterations, accessPasswordVerifierBytes)
}

// newAccessPasswordRecord builds a record at the current parameters from a raw
// password. The salt is fresh, so an identical password yields a new verifier.
func newAccessPasswordRecord(password string) (*accessPasswordRecord, error) {
	salt := make([]byte, accessPasswordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	verifier, err := deriveAccessVerifier(password, salt, accessPasswordHashIterations)
	if err != nil {
		return nil, err
	}
	return &accessPasswordRecord{Iterations: accessPasswordHashIterations, Salt: salt, Verifier: verifier}, nil
}

// matchesPassword compares a raw password with the stored verifier at the
// record's iteration count in constant time.
func (r accessPasswordRecord) matchesPassword(password string) (bool, error) {
	candidate, err := deriveAccessVerifier(password, r.Salt, r.Iterations)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(candidate, r.Verifier) == 1, nil
}

// rehashed returns a replacement record when the stored work factor is stale,
// so a successful password login can upgrade it without a separate migration.
func (r accessPasswordRecord) rehashed(password string) (*accessPasswordRecord, bool, error) {
	if r.Iterations == accessPasswordHashIterations {
		return nil, false, nil
	}
	record, err := newAccessPasswordRecord(password)
	if err != nil {
		return nil, false, err
	}
	return record, true, nil
}

// accessJWTKey derives the HS256 signing key from the stored verifier, so a
// record change rotates every outstanding token without extra state.
func accessJWTKey(record *accessPasswordRecord) ([]byte, error) {
	if record == nil {
		return nil, nil
	}
	return hkdf.Key(sha256.New, record.Verifier, record.Salt, accessJWTInfo, accessJWTKeyBytes)
}

type accessJWTHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
}

type accessJWTPayload struct {
	Issuer    string `json:"iss"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	Nonce     string `json:"jti"`
}

// accessJWTClaims is the verified content of a v2 access token.
type accessJWTClaims struct {
	IssuedAt  time.Time
	ExpiresAt time.Time
	Nonce     string
}

// formatAccessJWT signs explicit claims. Production callers use mintAccessJWT,
// which supplies a random nonce; tests use this form for fixed vectors.
func formatAccessJWT(key []byte, issuedAt, expiresAt int64, nonce string) (string, error) {
	header, err := json.Marshal(accessJWTHeader{Algorithm: accessJWTAlgorithm, Type: accessJWTType})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(accessJWTPayload{
		Issuer:    accessJWTIssuer,
		IssuedAt:  issuedAt,
		ExpiresAt: expiresAt,
		Nonce:     nonce,
	})
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func mintAccessJWT(key []byte, now time.Time) (string, error) {
	nonce := make([]byte, accessJWTNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return formatAccessJWT(key, now.Unix(), now.Add(accessJWTLifetime).Unix(), base64.RawURLEncoding.EncodeToString(nonce))
}

// parseAccessJWT verifies the signature first, then enforces the exact header
// and payload shape. Every failure returns the same error so callers cannot
// distinguish a malformed token from a forged one.
func parseAccessJWT(key []byte, token string, now time.Time) (*accessJWTClaims, error) {
	if len(key) != accessJWTKeyBytes {
		return nil, errAccessJWTInvalid
	}
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		return nil, errAccessJWTInvalid
	}
	header, err := decodeAccessJWTSegment(segments[0])
	if err != nil {
		return nil, errAccessJWTInvalid
	}
	payload, err := decodeAccessJWTSegment(segments[1])
	if err != nil {
		return nil, errAccessJWTInvalid
	}
	signature, err := decodeAccessJWTSegment(segments[2])
	if err != nil || len(signature) != sha256.Size {
		return nil, errAccessJWTInvalid
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(segments[0] + "." + segments[1]))
	if subtle.ConstantTimeCompare(signature, mac.Sum(nil)) != 1 {
		return nil, errAccessJWTInvalid
	}

	headerMembers, err := scanAccessJSONObject(header)
	if err != nil || !accessJWTHasExactKeys(headerMembers, "alg", "typ") {
		return nil, errAccessJWTInvalid
	}
	var verifiedHeader accessJWTHeader
	if err := json.Unmarshal(header, &verifiedHeader); err != nil {
		return nil, errAccessJWTInvalid
	}
	if verifiedHeader.Algorithm != accessJWTAlgorithm || verifiedHeader.Type != accessJWTType {
		return nil, errAccessJWTInvalid
	}

	payloadMembers, err := scanAccessJSONObject(payload)
	if err != nil || !accessJWTHasExactKeys(payloadMembers, "iss", "iat", "exp", "jti") {
		return nil, errAccessJWTInvalid
	}
	// null leaves a plain int64 at zero, so decode the timestamps through
	// pointers and require both to be present as integers.
	var claims struct {
		Issuer    string `json:"iss"`
		IssuedAt  *int64 `json:"iat"`
		ExpiresAt *int64 `json:"exp"`
		Nonce     string `json:"jti"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.IssuedAt == nil || claims.ExpiresAt == nil {
		return nil, errAccessJWTInvalid
	}
	if claims.Issuer != accessJWTIssuer {
		return nil, errAccessJWTInvalid
	}
	nonce, err := decodeAccessJWTSegment(claims.Nonce)
	if err != nil || len(nonce) != accessJWTNonceBytes {
		return nil, errAccessJWTInvalid
	}
	expiresAt := time.Unix(*claims.ExpiresAt, 0)
	if !expiresAt.After(now) {
		return nil, errAccessJWTInvalid
	}
	return &accessJWTClaims{
		IssuedAt:  time.Unix(*claims.IssuedAt, 0),
		ExpiresAt: expiresAt,
		Nonce:     claims.Nonce,
	}, nil
}

// decodeAccessJWTSegment rejects noncanonical base64url so one token cannot be
// spelled two ways.
func decodeAccessJWTSegment(segment string) ([]byte, error) {
	if segment == "" {
		return nil, errAccessJWTInvalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != segment {
		return nil, errAccessJWTInvalid
	}
	return decoded, nil
}

// scanAccessJSONObject decodes one JSON object and rejects duplicate keys,
// non-string keys, and trailing values. Unmarshalling into a map would keep the
// last duplicate silently.
func scanAccessJSONObject(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errAccessJWTInvalid
	}
	members := make(map[string]json.RawMessage, 4)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errAccessJWTInvalid
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errAccessJWTInvalid
		}
		if _, duplicate := members[key]; duplicate {
			return nil, errAccessJWTInvalid
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errAccessJWTInvalid
		}
		members[key] = value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, errAccessJWTInvalid
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errAccessJWTInvalid
	}
	return members, nil
}

func accessJWTHasExactKeys(members map[string]json.RawMessage, keys ...string) bool {
	if len(members) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := members[key]; !ok {
			return false
		}
	}
	return true
}

// accessCredentialState records whether a request carries a usable explicit v2
// credential, carries one that cannot be used here, or carries none.
type accessCredentialState int

const (
	accessCredentialNone accessCredentialState = iota
	accessCredentialPresent
	accessCredentialInvalid
)

// accessCredential is the raw credential material of one request. It is
// captured before taking the auth mutex and re-evaluated under it, so a record
// change between middleware and handler cannot reuse a stale decision.
type accessCredential struct {
	State  accessCredentialState
	Token  string
	Cookie string
}

// accessCredentialFromRequest applies the transport rules: a bearer on an API
// path, a token query on a WebSocket path, never both, never the other
// transport, never a duplicate or empty value. Anything else is invalid rather
// than absent, so it fails closed instead of falling back to the cookie.
func accessCredentialFromRequest(r *http.Request) accessCredential {
	credential := accessCredential{}
	if cookie, err := r.Cookie(accessSessionCookie); err == nil {
		credential.Cookie = cookie.Value
	}
	authorization := r.Header.Values("Authorization")
	query, queryErr := url.ParseQuery(r.URL.RawQuery)
	tokenValues, hasQueryToken := query["token"]
	websocket := strings.HasPrefix(r.URL.Path, "/ws/")

	switch {
	case len(authorization) > 1 || len(tokenValues) > 1:
		credential.State = accessCredentialInvalid
	case len(authorization) == 1 && hasQueryToken:
		credential.State = accessCredentialInvalid
	case websocket && len(authorization) == 1:
		credential.State = accessCredentialInvalid
	case !websocket && hasQueryToken:
		credential.State = accessCredentialInvalid
	case queryErr != nil:
		// A malformed query can hide a token, so selection cannot prove that
		// the request has no explicit credential.
		credential.State = accessCredentialInvalid
	case len(authorization) == 1:
		token, ok := parseAccessBearer(authorization[0])
		if !ok {
			credential.State = accessCredentialInvalid
			return credential
		}
		credential.State = accessCredentialPresent
		credential.Token = token
	case hasQueryToken:
		token := tokenValues[0]
		if token == "" {
			credential.State = accessCredentialInvalid
			return credential
		}
		credential.State = accessCredentialPresent
		credential.Token = token
	}
	return credential
}

func parseAccessBearer(value string) (string, bool) {
	const prefix = "Bearer "
	if len(value) <= len(prefix) || !strings.EqualFold(value[:len(prefix)], prefix) {
		return "", false
	}
	token := value[len(prefix):]
	if strings.ContainsAny(token, " \t") {
		return "", false
	}
	return token, true
}

type accessLoginAttempt struct {
	Failures    int
	RetryAt     time.Time
	LastFailure time.Time
}

type accessAuthManager struct {
	mu         sync.Mutex
	record     *accessPasswordRecord
	jwtKey     []byte
	generation uint64
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

// configure activates the persisted record without rewriting it. The signing
// key is derived from that record, so restart reproduces the same tokens' key.
func (m *accessAuthManager) configure(encoded string) error {
	record, err := parseAccessPasswordHash(encoded)
	if err != nil {
		return err
	}
	key, err := accessJWTKey(record)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.record = record
	m.jwtKey = key
	m.generation++
	m.challenges = make(map[string]time.Time)
	m.sessions = make(map[string]time.Time)
	m.attempts = make(map[string]accessLoginAttempt)
	return nil
}

// accessGeneration fences WebSocket upgrades against record changes.
func (m *accessAuthManager) accessGeneration() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.generation
}

func (m *accessAuthManager) enabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.record != nil
}

// statusAndChallenge returns public KDF parameters and a single-use login
// challenge from one locked snapshot, so a concurrent password change cannot
// pair an old salt with a challenge for the new verifier.
func (m *accessAuthManager) statusAndChallenge() (enabled bool, salt, challenge string, iterations int, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.record == nil {
		return false, "", "", 0, nil
	}
	now := time.Now()
	m.cleanExpiredLocked(now)
	if len(m.challenges) >= maxAccessChallenges {
		return false, "", "", 0, errors.New("too many pending login attempts")
	}
	challenge, err = randomAccessToken()
	if err != nil {
		return false, "", "", 0, err
	}
	m.challenges[challenge] = now.Add(accessChallengeTTL)
	return true, base64.RawURLEncoding.EncodeToString(m.record.Salt), challenge, m.record.Iterations, nil
}

func (m *accessAuthManager) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(accessSessionCookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cookieValidLocked(cookie.Value, time.Now())
}

// cookieValidLocked verifies a v1 session token against the current verifier.
// Callers hold the mutex.
func (m *accessAuthManager) cookieValidLocked(token string, now time.Time) bool {
	if m.record == nil || token == "" {
		return false
	}
	expiresAt, ok := m.sessions[token]
	if ok {
		if expiresAt.After(now) {
			return true
		}
		delete(m.sessions, token)
		return false
	}
	// Stateless token verification across server restarts. The token is
	// signed with the current verifier, so it remains valid across restarts
	// until expiry whilst any password change automatically invalidates it.
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	expiresUnix, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return false
	}
	tokenExpiry := time.Unix(expiresUnix, 0)
	if !tokenExpiry.After(now) {
		return false
	}
	gotSig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(gotSig) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, m.record.Verifier)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	wantSig := mac.Sum(nil)
	if subtle.ConstantTimeCompare(gotSig, wantSig) != 1 {
		return false
	}
	m.sessions[token] = tokenExpiry
	return true
}

// jwtValidLocked verifies an explicit v2 token against the current key.
// Callers hold the mutex.
func (m *accessAuthManager) jwtValidLocked(token string, now time.Time) bool {
	if len(m.jwtKey) != accessJWTKeyBytes || token == "" {
		return false
	}
	_, err := parseAccessJWT(m.jwtKey, token, now)
	return err == nil
}

// requestAuthorized applies the explicit-credential priority table. An explicit
// v2 credential decides the result on its own and never falls back to a cookie.
func (m *accessAuthManager) requestAuthorized(r *http.Request) bool {
	credential := accessCredentialFromRequest(r)
	if credential.State == accessCredentialInvalid {
		return false
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if credential.State == accessCredentialPresent {
		return m.jwtValidLocked(credential.Token, now)
	}
	return m.cookieValidLocked(credential.Cookie, now)
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

// setEncodedPassword applies a v1 password change. The request credential is
// re-evaluated under the lock, so a record change between middleware evaluation
// and this call still rejects an unauthorized caller.
func (m *accessAuthManager) setEncodedPassword(encoded string, credential accessCredential) (accessPasswordOutcome, error) {
	record, err := parseAccessPasswordHash(encoded)
	if err != nil {
		return accessPasswordOutcome{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if !m.authorizedForPasswordLocked(credential, now) {
		return accessPasswordOutcome{}, errAccessUnauthorized
	}
	return m.commitPasswordLocked(record, now)
}

// setRawPassword applies a v2 set or change. Clearing uses clearPassword.
func (m *accessAuthManager) setRawPassword(password string, credential accessCredential) (accessPasswordOutcome, error) {
	record, err := newAccessPasswordRecord(password)
	if err != nil {
		return accessPasswordOutcome{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if !m.authorizedForPasswordLocked(credential, now) {
		return accessPasswordOutcome{}, errAccessUnauthorized
	}
	return m.commitPasswordLocked(record, now)
}

// clearPassword disables authentication. Callers pass only the explicit v2
// bearer, so a cookie alone cannot disable a v2 password.
func (m *accessAuthManager) clearPassword(credential accessCredential) (accessPasswordOutcome, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if m.record == nil {
		return accessPasswordOutcome{}, errAccessNotEnabled
	}
	if !m.authorizedForPasswordLocked(credential, now) {
		return accessPasswordOutcome{}, errAccessUnauthorized
	}
	return m.commitPasswordLocked(nil, now)
}

// loginPassword verifies a raw password and returns a JWT signed with the
// committed key. A stale work factor is rehashed: the replacement is persisted
// before activation, so a failed write leaves the old record and key valid.
func (m *accessAuthManager) loginPassword(password, remoteAddr string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.cleanExpiredLocked(now)
	if m.record == nil {
		return "", errAccessUnauthorized
	}

	client := accessClientIP(remoteAddr)
	if attempt, ok := m.attempts[client]; ok && attempt.RetryAt.After(now) {
		return "", errAccessRateLimited
	}
	matched, err := m.record.matchesPassword(password)
	if err != nil {
		return "", err
	}
	if !matched {
		m.recordFailureLocked(client, now)
		return "", errAccessUnauthorized
	}

	replacement, changed, err := m.record.rehashed(password)
	if err != nil {
		return "", err
	}
	if changed {
		outcome, err := m.commitPasswordLocked(replacement, now)
		if err != nil {
			return "", err
		}
		return outcome.JWTToken, nil
	}
	delete(m.attempts, client)
	key, err := accessJWTKey(m.record)
	if err != nil {
		return "", err
	}
	return mintAccessJWT(key, now)
}

// accessPasswordOutcome reports the credentials minted by one guarded record
// change. Both tokens are empty when the change cleared the password.
type accessPasswordOutcome struct {
	CookieToken string
	JWTToken    string
	Revoked     bool
}

// authorizedForPasswordLocked re-checks the caller against the current record.
// A disabled record accepts anyone: that is the initial enable.
func (m *accessAuthManager) authorizedForPasswordLocked(credential accessCredential, now time.Time) bool {
	if m.record == nil {
		return true
	}
	switch credential.State {
	case accessCredentialInvalid:
		return false
	case accessCredentialPresent:
		return m.jwtValidLocked(credential.Token, now)
	}
	return m.cookieValidLocked(credential.Cookie, now)
}

// commitPasswordLocked persists the replacement before activating it, so a
// failed write leaves the old record, key, credentials, and sockets valid. The
// v1 session is recorded only after the write succeeds.
func (m *accessAuthManager) commitPasswordLocked(record *accessPasswordRecord, now time.Time) (accessPasswordOutcome, error) {
	key, err := accessJWTKey(record)
	if err != nil {
		return accessPasswordOutcome{}, err
	}
	var outcome accessPasswordOutcome
	if record != nil {
		if outcome.CookieToken, err = signAccessSession(record.Verifier, now); err != nil {
			return accessPasswordOutcome{}, err
		}
		if outcome.JWTToken, err = mintAccessJWT(key, now); err != nil {
			return accessPasswordOutcome{}, err
		}
	}
	encoded := ""
	if record != nil {
		encoded = record.encoded()
	}
	if err := saveAccessPasswordHash(encoded); err != nil {
		return accessPasswordOutcome{}, fmt.Errorf("%w: %v", errAccessPersistence, err)
	}
	outcome.Revoked = m.record != nil || record != nil
	m.record = record
	m.jwtKey = key
	m.generation++
	m.challenges = make(map[string]time.Time)
	m.sessions = make(map[string]time.Time)
	m.attempts = make(map[string]accessLoginAttempt)
	if outcome.CookieToken != "" {
		m.sessions[outcome.CookieToken] = now.Add(accessSessionTTL)
	}
	return outcome, nil
}

func (m *accessAuthManager) newSessionLocked(now time.Time) (string, error) {
	m.cleanExpiredLocked(now)
	if m.record == nil {
		return "", nil
	}
	token, err := signAccessSession(m.record.Verifier, now)
	if err != nil {
		return "", err
	}
	m.sessions[token] = now.Add(accessSessionTTL)
	return token, nil
}

// signAccessSession mints a v1 cookie token without storing it, so a record
// change can persist first and activate the session only after the write.
func signAccessSession(verifier []byte, now time.Time) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	nonce := base64.RawURLEncoding.EncodeToString(buf)
	expiresAt := now.Add(accessSessionTTL)
	expiresStr := strconv.FormatInt(expiresAt.Unix(), 10)
	payload := nonce + "." + expiresStr
	mac := hmac.New(sha256.New, verifier)
	_, _ = mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
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
		if accessAuthPublicPath(r.URL.Path) || !accessAuth.enabled() {
			next.ServeHTTP(w, r)
			return
		}
		if isSyncBoardPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if accessAuth.requestAuthorized(r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "access authentication required", http.StatusUnauthorized)
	})
}

// isSyncBoardPath marks the sync board as reachable without a browser session.
//
// This phi instance *is* the coordinator -- other machines POST to it -- so
// those callers have no session cookie and started failing with "access
// authentication required" once an access password was set.
//
// The board carries coordination metadata between the operator's own machines,
// and anyone who can reach this port can already reach the web UI, the
// terminals and the file tree. A separate credential here would not protect
// anything that is not already exposed; it would only break syncing.
//
// The exemption is kept narrow on purpose. It covers the message endpoints and
// nothing else -- notably not /api/config/sync-coordinator, which changes where
// this instance syncs to.
func isSyncBoardPath(path string) bool {
	return path == "/api/sync/messages" || strings.HasPrefix(path, "/api/sync/messages/")
}

func accessAuthPublicPath(path string) bool {
	switch path {
	case "/api/auth/status", "/api/auth/login",
		"/api/auth/v2/status", "/api/auth/v2/login", "/api/auth/v2/password",
		"/livez", "/healthz", "/readyz":
		return true
	}
	return !strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/ws/")
}

func handleAccessAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	enabled, salt, challenge, iterations, err := accessAuth.statusAndChallenge()
	if err != nil {
		http.Error(w, "Unable to start login: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	payload := map[string]interface{}{
		"enabled":       enabled,
		"authenticated": enabled && accessAuth.authenticated(r),
		"protocols":     []string{accessPasswordHashVersion, accessJWTProtocol},
	}
	if enabled {
		payload["version"] = accessPasswordHashVersion
		payload["algorithm"] = accessPasswordHashAlgorithm
		payload["iterations"] = iterations
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
	outcome, err := accessAuth.setEncodedPassword(req.PasswordHash, accessCredentialFromRequest(r))
	if err != nil {
		switch {
		case errors.Is(err, errAccessUnauthorized):
			http.Error(w, "access authentication required", http.StatusUnauthorized)
		case errors.Is(err, errAccessPersistence):
			http.Error(w, "Unable to save access password", http.StatusInternalServerError)
		default:
			http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		}
		return
	}

	if outcome.Revoked && wsHub != nil {
		// Sessions are invalidated above; close already-upgraded sockets too so
		// an old browser cannot keep driving a terminal until it reconnects.
		wsHub.CloseAllClients()
	}
	if outcome.CookieToken == "" {
		clearAccessSessionCookie(w, r)
	} else {
		setAccessSessionCookie(w, r, outcome.CookieToken)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": outcome.CookieToken != ""})
}

// handleAccessV2Status reports enforcement and whether the request carries a
// valid explicit bearer. A cookie never authenticates this endpoint.
func handleAccessV2Status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	enabled, authenticated := accessAuth.v2Status(r)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": enabled, "authenticated": authenticated})
}

func (m *accessAuthManager) v2Status(r *http.Request) (enabled, authenticated bool) {
	credential := accessCredentialFromRequest(r)
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	enabled = m.record != nil
	if !enabled || credential.State != accessCredentialPresent {
		return enabled, false
	}
	return enabled, m.jwtValidLocked(credential.Token, now)
}

func handleAccessV2Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	password, ok := decodeAccessPasswordBody(w, r)
	if !ok || len(password) < accessPasswordMinBytes || len(password) > accessPasswordMaxBytes {
		http.Error(w, "Invalid login request", http.StatusBadRequest)
		return
	}
	token, err := accessAuth.loginPassword(password, r.RemoteAddr)
	if err != nil {
		switch {
		case errors.Is(err, errAccessRateLimited):
			http.Error(w, err.Error(), http.StatusTooManyRequests)
		case errors.Is(err, errAccessUnauthorized):
			http.Error(w, "Invalid password", http.StatusUnauthorized)
		default:
			http.Error(w, "Unable to login", http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"token": token})
}

func handleAccessV2Password(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	password, ok := decodeAccessPasswordBody(w, r)
	if !ok {
		http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		return
	}
	// This route accepts an explicit bearer only: a cookie cannot set or clear
	// a v2 password, so it is dropped before the credential check.
	credential := accessCredentialFromRequest(r)
	credential.Cookie = ""

	var outcome accessPasswordOutcome
	var err error
	if password == "" {
		outcome, err = accessAuth.clearPassword(credential)
	} else if len(password) < accessPasswordMinBytes || len(password) > accessPasswordMaxBytes {
		http.Error(w, "Invalid password configuration", http.StatusBadRequest)
		return
	} else {
		outcome, err = accessAuth.setRawPassword(password, credential)
	}
	if err != nil {
		switch {
		case errors.Is(err, errAccessNotEnabled):
			http.Error(w, "Access password is not enabled", http.StatusBadRequest)
		case errors.Is(err, errAccessUnauthorized):
			http.Error(w, "access authentication required", http.StatusUnauthorized)
		default:
			http.Error(w, "Unable to save access password", http.StatusInternalServerError)
		}
		return
	}

	if outcome.Revoked && wsHub != nil {
		wsHub.CloseAllClients()
	}
	w.Header().Set("Content-Type", "application/json")
	if password == "" {
		_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": false})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"enabled": true, "token": outcome.JWTToken})
}

// decodeAccessPasswordBody reads the one v2 request shape: a JSON object with a
// single string password field. Unknown fields, duplicate keys, null, missing
// values, non-strings, and trailing JSON are rejected.
func decodeAccessPasswordBody(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, accessPasswordBodyLimit))
	if err != nil {
		return "", false
	}
	members, err := scanAccessJSONObject(raw)
	if err != nil || !accessJWTHasExactKeys(members, "password") {
		return "", false
	}
	var password *string
	if err := json.Unmarshal(members["password"], &password); err != nil || password == nil {
		return "", false
	}
	return *password, true
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
