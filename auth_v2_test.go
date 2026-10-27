package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/ws"
)

const (
	testAccessPassword        = "test-pass-1234"
	testAccessVerifier100kHex = "c8b0c844387530bca51e274c4e4e23aa4f5fd1daa43c52049f0f640041485404"
	testAccessVerifier600kHex = "a5905483f9c280f6213bf99b80d651d17ff85bef07aa9a572d6cdd10507a456a"
	testAccessJWTKeyHex       = "8351c1f8f8f34c7843cd0484f5cfe906d502e2b66de55c43e7b6fc083a229e6b"
	testAccessJWTNonce        = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM"
	testAccessJWTFrozen       = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJwaGkiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6NDg1MzYwMDAwMCwianRpIjoiTXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TSJ9.Z92aWHlvUPkKTcyC_WGaHiApRDyJGW4scY9OgjKX9Nw"
	testAccessJWTIssuedAt     = int64(1700000000)
	testAccessJWTExpiresAt    = int64(4853600000)
	testAccessJWTValidHeader  = `{"alg":"HS256","typ":"JWT"}`
)

func testAccessJWTValidPayload() string {
	return `{"iss":"phi","iat":` + strconv.FormatInt(testAccessJWTIssuedAt, 10) +
		`,"exp":` + strconv.FormatInt(testAccessJWTExpiresAt, 10) + `,"jti":"` + testAccessJWTNonce + `"}`
}

// testAccessJWTSigningRecord is the frozen-vector record: it exercises key
// derivation and signing, not a password.
func testAccessJWTSigningRecord() *accessPasswordRecord {
	return &accessPasswordRecord{
		Iterations: accessPasswordHashIterations,
		Salt:       bytes.Repeat([]byte{0x11}, accessPasswordSaltBytes),
		Verifier:   bytes.Repeat([]byte{0x22}, accessPasswordVerifierBytes),
	}
}

func testAccessJWTSigningKey(t *testing.T) []byte {
	t.Helper()
	key, err := accessJWTKey(testAccessJWTSigningRecord())
	if err != nil {
		t.Fatalf("derive signing key: %v", err)
	}
	if hex.EncodeToString(key) != testAccessJWTKeyHex {
		t.Fatalf("signing key = %s want %s", hex.EncodeToString(key), testAccessJWTKeyHex)
	}
	return key
}

// signTestAccessJWT signs arbitrary header and payload JSON with the real key so
// a parser defect cannot hide behind a bad signature.
func signTestAccessJWT(key []byte, header, payload string) string {
	signingInput := base64.RawURLEncoding.EncodeToString([]byte(header)) + "." +
		base64.RawURLEncoding.EncodeToString([]byte(payload))
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestParserAcceptsSupportedIterationCounts(t *testing.T) {
	salt := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, accessPasswordSaltBytes))
	verifier := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x22}, accessPasswordVerifierBytes))
	for _, iterations := range []int{accessPasswordMinIterations, accessPasswordHashIterations, accessPasswordMaxIterations} {
		encoded := "v1.pbkdf2-sha256." + strconv.Itoa(iterations) + "." + salt + "." + verifier
		record, err := parseAccessPasswordHash(encoded)
		if err != nil {
			t.Fatalf("parse %d iterations: %v", iterations, err)
		}
		if record.Iterations != iterations {
			t.Errorf("iterations = %d want %d", record.Iterations, iterations)
		}
		if record.encoded() != encoded {
			t.Errorf("round trip %d: got %q want %q", iterations, record.encoded(), encoded)
		}
	}
}

func TestParserRejectsUnsupportedIterationCounts(t *testing.T) {
	salt := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, accessPasswordSaltBytes))
	verifier := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x22}, accessPasswordVerifierBytes))
	for _, iterations := range []string{"0", "1", "99999", "10000001", "600000.0", "-600000", "6e5", "not-a-number", ""} {
		encoded := "v1.pbkdf2-sha256." + iterations + "." + salt + "." + verifier
		if _, err := parseAccessPasswordHash(encoded); err == nil {
			t.Errorf("iterations %q unexpectedly accepted", iterations)
		}
	}
}

func TestParserRejectsInvalidSaltAndVerifierLengths(t *testing.T) {
	salt := bytes.Repeat([]byte{0x11}, accessPasswordSaltBytes)
	verifier := bytes.Repeat([]byte{0x22}, accessPasswordVerifierBytes)
	iterations := strconv.Itoa(accessPasswordHashIterations)
	encode := base64.RawURLEncoding.EncodeToString
	cases := map[string]string{
		"short salt":        "v1.pbkdf2-sha256." + iterations + "." + encode(salt[:15]) + "." + encode(verifier),
		"long salt":         "v1.pbkdf2-sha256." + iterations + "." + encode(append(salt, 0x11)) + "." + encode(verifier),
		"short verifier":    "v1.pbkdf2-sha256." + iterations + "." + encode(salt) + "." + encode(verifier[:31]),
		"long verifier":     "v1.pbkdf2-sha256." + iterations + "." + encode(salt) + "." + encode(append(verifier, 0x22)),
		"padded salt":       "v1.pbkdf2-sha256." + iterations + "." + encode(salt) + "=." + encode(verifier),
		"not base64 salt":   "v1.pbkdf2-sha256." + iterations + ".not*base64." + encode(verifier),
		"extra segment":     "v1.pbkdf2-sha256." + iterations + "." + encode(salt) + "." + encode(verifier) + ".x",
		"missing verifier":  "v1.pbkdf2-sha256." + iterations + "." + encode(salt),
		"wrong version":     "v2.pbkdf2-sha256." + iterations + "." + encode(salt) + "." + encode(verifier),
		"wrong algorithm":   "v1.pbkdf2-sha1." + iterations + "." + encode(salt) + "." + encode(verifier),
		"uppercase version": "V1.pbkdf2-sha256." + iterations + "." + encode(salt) + "." + encode(verifier),
	}
	for name, encoded := range cases {
		if _, err := parseAccessPasswordHash(encoded); err == nil {
			t.Errorf("%s: unexpectedly accepted", name)
		}
	}
}

func TestAccessPasswordDerivationMatchesFixture(t *testing.T) {
	salt := bytes.Repeat([]byte{0x11}, accessPasswordSaltBytes)
	cases := []struct {
		iterations int
		verifier   string
	}{
		{accessPasswordMinIterations, testAccessVerifier100kHex},
		{accessPasswordHashIterations, testAccessVerifier600kHex},
	}
	for _, tc := range cases {
		derived, err := deriveAccessVerifier(testAccessPassword, salt, tc.iterations)
		if err != nil {
			t.Fatalf("%d iterations: derive: %v", tc.iterations, err)
		}
		if got := hex.EncodeToString(derived); got != tc.verifier {
			t.Fatalf("%d iterations: verifier = %s want %s", tc.iterations, got, tc.verifier)
		}
		record := accessPasswordRecord{Iterations: tc.iterations, Salt: salt, Verifier: derived}
		if ok, err := record.matchesPassword(testAccessPassword); err != nil || !ok {
			t.Errorf("%d iterations: matching password rejected: ok=%v err=%v", tc.iterations, ok, err)
		}
		if ok, err := record.matchesPassword("test-pass-1235"); err != nil || ok {
			t.Errorf("%d iterations: wrong password accepted: ok=%v err=%v", tc.iterations, ok, err)
		}
	}
}

func TestAccessPasswordRecordCreationUsesCurrentParameters(t *testing.T) {
	first, err := newAccessPasswordRecord(testAccessPassword)
	if err != nil {
		t.Fatalf("create record: %v", err)
	}
	if first.Iterations != accessPasswordHashIterations {
		t.Errorf("iterations = %d want %d", first.Iterations, accessPasswordHashIterations)
	}
	if len(first.Salt) != accessPasswordSaltBytes || len(first.Verifier) != accessPasswordVerifierBytes {
		t.Fatalf("unexpected salt/verifier sizes: %d/%d", len(first.Salt), len(first.Verifier))
	}
	if ok, err := first.matchesPassword(testAccessPassword); err != nil || !ok {
		t.Errorf("created record does not match its password: ok=%v err=%v", ok, err)
	}
	second, err := newAccessPasswordRecord(testAccessPassword)
	if err != nil {
		t.Fatalf("create second record: %v", err)
	}
	if bytes.Equal(first.Salt, second.Salt) || bytes.Equal(first.Verifier, second.Verifier) {
		t.Error("identical password produced identical salt or verifier")
	}
}

func TestAccessPasswordRehashOnlyForStaleRecords(t *testing.T) {
	salt := bytes.Repeat([]byte{0x11}, accessPasswordSaltBytes)
	staleVerifier, err := deriveAccessVerifier(testAccessPassword, salt, accessPasswordMinIterations)
	if err != nil {
		t.Fatal(err)
	}
	stale := accessPasswordRecord{Iterations: accessPasswordMinIterations, Salt: salt, Verifier: staleVerifier}

	replacement, changed, err := stale.rehashed(testAccessPassword)
	if err != nil || !changed {
		t.Fatalf("stale record did not rehash: changed=%v err=%v", changed, err)
	}
	if replacement.Iterations != accessPasswordHashIterations {
		t.Errorf("rehashed iterations = %d want %d", replacement.Iterations, accessPasswordHashIterations)
	}
	if bytes.Equal(replacement.Salt, stale.Salt) || bytes.Equal(replacement.Verifier, stale.Verifier) {
		t.Error("rehash reused the old salt or verifier")
	}
	if ok, err := replacement.matchesPassword(testAccessPassword); err != nil || !ok {
		t.Errorf("rehashed record lost the password: ok=%v err=%v", ok, err)
	}

	current := accessPasswordRecord{Iterations: accessPasswordHashIterations, Salt: salt, Verifier: staleVerifier}
	if _, changed, err := current.rehashed(testAccessPassword); changed || err != nil {
		t.Errorf("current record rehashed: changed=%v err=%v", changed, err)
	}
}

func TestAccessJWTKeyMatchesFixtureAcrossRestart(t *testing.T) {
	key := testAccessJWTSigningKey(t)

	restarted, err := parseAccessPasswordHash(testAccessJWTSigningRecord().encoded())
	if err != nil {
		t.Fatalf("reparse record: %v", err)
	}
	restartedKey, err := accessJWTKey(restarted)
	if err != nil {
		t.Fatalf("derive restarted key: %v", err)
	}
	if !bytes.Equal(key, restartedKey) {
		t.Error("restart changed the signing key for the same record")
	}
	if disabledKey, err := accessJWTKey(nil); err != nil || disabledKey != nil {
		t.Errorf("nil record key = %x err=%v want nil", disabledKey, err)
	}
}

func TestAccessJWTFrozenVector(t *testing.T) {
	key := testAccessJWTSigningKey(t)
	token, err := formatAccessJWT(key, testAccessJWTIssuedAt, testAccessJWTExpiresAt, testAccessJWTNonce)
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	if token != testAccessJWTFrozen {
		t.Fatalf("token = %s\nwant    %s", token, testAccessJWTFrozen)
	}
	claims, err := parseAccessJWT(key, token, time.Unix(testAccessJWTIssuedAt+1, 0))
	if err != nil {
		t.Fatalf("parse frozen vector: %v", err)
	}
	if claims.IssuedAt.Unix() != testAccessJWTIssuedAt || claims.ExpiresAt.Unix() != testAccessJWTExpiresAt {
		t.Errorf("claims times = %d/%d", claims.IssuedAt.Unix(), claims.ExpiresAt.Unix())
	}
	if claims.Nonce != testAccessJWTNonce {
		t.Errorf("nonce = %q want %q", claims.Nonce, testAccessJWTNonce)
	}

	now := time.Unix(testAccessJWTIssuedAt, 0)
	minted, err := mintAccessJWT(key, now)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	mintedClaims, err := parseAccessJWT(key, minted, now)
	if err != nil {
		t.Fatalf("parse minted token: %v", err)
	}
	if mintedClaims.Nonce == "" || mintedClaims.Nonce == testAccessJWTNonce {
		t.Errorf("minted token did not use a fresh nonce: %q", mintedClaims.Nonce)
	}
	if want := now.Add(accessJWTLifetime).Unix(); mintedClaims.ExpiresAt.Unix() != want {
		t.Errorf("minted expiry = %d want %d", mintedClaims.ExpiresAt.Unix(), want)
	}
}

func TestAccessJWTParseRejectsMalformedTokens(t *testing.T) {
	key := testAccessJWTSigningKey(t)
	now := time.Unix(testAccessJWTIssuedAt+1, 0)
	validPayload := testAccessJWTValidPayload()
	expiredPayload := `{"iss":"phi","iat":1700000000,"exp":1700000001,"jti":"` + testAccessJWTNonce + `"}`

	if _, err := parseAccessJWT(key, signTestAccessJWT(key, testAccessJWTValidHeader, validPayload), now); err != nil {
		t.Fatalf("valid control token rejected: %v", err)
	}

	signed := map[string]string{
		"wrong algorithm":         signTestAccessJWT(key, `{"alg":"none","typ":"JWT"}`, validPayload),
		"wrong type":              signTestAccessJWT(key, `{"alg":"HS256","typ":"JWE"}`, validPayload),
		"missing header field":    signTestAccessJWT(key, `{"alg":"HS256"}`, validPayload),
		"extra header field":      signTestAccessJWT(key, `{"alg":"HS256","typ":"JWT","kid":"x"}`, validPayload),
		"duplicate header field":  signTestAccessJWT(key, `{"alg":"HS256","typ":"JWT","typ":"JWT"}`, validPayload),
		"header not an object":    signTestAccessJWT(key, `["HS256"]`, validPayload),
		"wrong issuer":            signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"other","iat":1700000000,"exp":4853600000,"jti":"`+testAccessJWTNonce+`"}`),
		"missing expiry":          signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":1700000000,"jti":"`+testAccessJWTNonce+`"}`),
		"extra payload field":     signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":1700000000,"exp":4853600000,"jti":"`+testAccessJWTNonce+`","sub":"x"}`),
		"duplicate payload field": signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iss":"phi","iat":1700000000,"exp":4853600000,"jti":"`+testAccessJWTNonce+`"}`),
		"string issued at":        signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":"1700000000","exp":4853600000,"jti":"`+testAccessJWTNonce+`"}`),
		"null issued at":          signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":null,"exp":4853600000,"jti":"`+testAccessJWTNonce+`"}`),
		"null expiry":             signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":1700000000,"exp":null,"jti":"`+testAccessJWTNonce+`"}`),
		"null issuer":             signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":null,"iat":1700000000,"exp":4853600000,"jti":"`+testAccessJWTNonce+`"}`),
		"null nonce":              signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":1700000000,"exp":4853600000,"jti":null}`),
		"fractional expiry":       signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":1700000000,"exp":4853600000.5,"jti":"`+testAccessJWTNonce+`"}`),
		"short nonce":             signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":1700000000,"exp":4853600000,"jti":"`+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x33}, 16))+`"}`),
		"padded nonce":            signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":1700000000,"exp":4853600000,"jti":"`+testAccessJWTNonce+`="}`),
		"empty nonce":             signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":1700000000,"exp":4853600000,"jti":""}`),
		"expired":                 signTestAccessJWT(key, testAccessJWTValidHeader, expiredPayload),
		"trailing payload value":  signTestAccessJWT(key, testAccessJWTValidHeader, validPayload+`{}`),
	}
	for name, token := range signed {
		if _, err := parseAccessJWT(key, token, now); err == nil {
			t.Errorf("%s: unexpectedly accepted", name)
		}
	}

	valid := signTestAccessJWT(key, testAccessJWTValidHeader, validPayload)
	segments := strings.Split(valid, ".")
	unsigned := map[string]string{
		"two segments":         segments[0] + "." + segments[1],
		"four segments":        valid + ".extra",
		"empty signature":      segments[0] + "." + segments[1] + ".",
		"short signature":      segments[0] + "." + segments[1] + "." + segments[2][:20],
		"padded header":        segments[0] + "=." + segments[1] + "." + segments[2],
		"tampered payload":     segments[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(validPayload+" ")) + "." + segments[2],
		"garbage":              "not-a-token",
		"empty":                "",
		"wrong key signature":  signTestAccessJWT(bytes.Repeat([]byte{0x44}, accessJWTKeyBytes), testAccessJWTValidHeader, validPayload),
		"noncanonical payload": segments[0] + "." + segments[1] + "=." + segments[2],
	}
	for name, token := range unsigned {
		if _, err := parseAccessJWT(key, token, now); err == nil {
			t.Errorf("%s: unexpectedly accepted", name)
		}
	}
}

func TestAccessConfigureDerivesJWTKeyAndAdvancesGeneration(t *testing.T) {
	auth := useTestAccessAuth(t)
	start := auth.accessGeneration()
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if got := auth.accessGeneration(); got != start+1 {
		t.Errorf("generation = %d want %d", got, start+1)
	}

	auth.mu.Lock()
	key := append([]byte(nil), auth.jwtKey...)
	record := auth.record
	auth.mu.Unlock()
	if hex.EncodeToString(key) != testAccessJWTKeyHex {
		t.Errorf("configured key = %s want %s", hex.EncodeToString(key), testAccessJWTKeyHex)
	}
	if record == nil || record.encoded() != testAccessHash() {
		t.Errorf("configure rewrote the record: %v", record)
	}

	if err := auth.configure(""); err != nil {
		t.Fatalf("configure disabled: %v", err)
	}
	auth.mu.Lock()
	key = auth.jwtKey
	auth.mu.Unlock()
	if key != nil {
		t.Errorf("disabled record kept a signing key: %x", key)
	}
	if got := auth.accessGeneration(); got != start+2 {
		t.Errorf("generation after clear = %d want %d", got, start+2)
	}
}

// --- M1b: routes, credential priority, guarded record replacement ---

func testAccessServe(handler http.HandlerFunc, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	handler(w, r)
	return w
}

func testAccessJSONBody(t *testing.T, w *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), target); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
}

func testAccessV2PasswordRequest(t *testing.T, body, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/auth/v2/password", strings.NewReader(body))
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	return testAccessServe(handleAccessV2Password, r)
}

func testAccessV2LoginBody(t *testing.T, body, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/auth/v2/login", strings.NewReader(body))
	r.RemoteAddr = remoteAddr
	return testAccessServe(handleAccessV2Login, r)
}

func testAccessV2LoginRequest(t *testing.T, password, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		t.Fatal(err)
	}
	return testAccessV2LoginBody(t, string(body), remoteAddr)
}

// testAccessEnableV2 sets a password through the public v2 route.
func testAccessEnableV2(t *testing.T, password string) string {
	t.Helper()
	body, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		t.Fatal(err)
	}
	w := testAccessV2PasswordRequest(t, string(body), "")
	if w.Code != http.StatusOK {
		t.Fatalf("enable v2 password: got %d body=%s", w.Code, w.Body.String())
	}
	var response struct {
		Enabled bool   `json:"enabled"`
		Token   string `json:"token"`
	}
	testAccessJSONBody(t, w, &response)
	if !response.Enabled || response.Token == "" {
		t.Fatalf("enable response = %+v", response)
	}
	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Fatalf("v2 password route issued cookies: %v", cookies)
	}
	return response.Token
}

func testAccessProtected() http.Handler {
	return accessAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
}

func TestAccessV1StatusAdvertisesProtocols(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)

	disabled := testAccessServe(handleAccessAuthStatus, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	var disabledPayload struct {
		Enabled   bool     `json:"enabled"`
		Protocols []string `json:"protocols"`
		Salt      string   `json:"salt"`
		Challenge string   `json:"challenge"`
	}
	testAccessJSONBody(t, disabled, &disabledPayload)
	if disabledPayload.Enabled || len(disabledPayload.Protocols) != 2 ||
		disabledPayload.Protocols[0] != "v1" || disabledPayload.Protocols[1] != "v2" {
		t.Fatalf("disabled status = %+v", disabledPayload)
	}
	if disabledPayload.Salt != "" || disabledPayload.Challenge != "" {
		t.Fatalf("disabled status leaked KDF data: %+v", disabledPayload)
	}

	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	enabled := testAccessServe(handleAccessAuthStatus, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	var enabledPayload struct {
		Enabled    bool     `json:"enabled"`
		Iterations int      `json:"iterations"`
		Protocols  []string `json:"protocols"`
		Version    string   `json:"version"`
		Algorithm  string   `json:"algorithm"`
	}
	testAccessJSONBody(t, enabled, &enabledPayload)
	if !enabledPayload.Enabled || enabledPayload.Iterations != accessPasswordHashIterations {
		t.Fatalf("enabled status = %+v", enabledPayload)
	}
	if len(enabledPayload.Protocols) != 2 || enabledPayload.Version != "v1" || enabledPayload.Algorithm != "pbkdf2-sha256" {
		t.Fatalf("enabled status capabilities = %+v", enabledPayload)
	}
	if strings.Contains(enabled.Body.String(), "verifier") {
		t.Fatalf("status leaked verifier: %s", enabled.Body.String())
	}
}

func TestAccessV2PasswordLifecycle(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	protected := testAccessProtected()

	token := testAccessEnableV2(t, testAccessPassword)
	if got := loadConfig().AccessPasswordHash; got == "" {
		t.Fatal("v2 enable did not persist a record")
	}

	var statusPayload struct {
		Enabled       bool `json:"enabled"`
		Authenticated bool `json:"authenticated"`
	}
	testAccessJSONBody(t, testAccessServe(handleAccessV2Status,
		httptest.NewRequest(http.MethodGet, "/api/auth/v2/status", nil)), &statusPayload)
	if !statusPayload.Enabled || statusPayload.Authenticated {
		t.Fatalf("anonymous v2 status = %+v", statusPayload)
	}

	authedStatus := httptest.NewRequest(http.MethodGet, "/api/auth/v2/status", nil)
	authedStatus.Header.Set("Authorization", "Bearer "+token)
	testAccessJSONBody(t, testAccessServe(handleAccessV2Status, authedStatus), &statusPayload)
	if !statusPayload.Authenticated {
		t.Fatalf("bearer v2 status = %+v", statusPayload)
	}

	// A v1 cookie never authenticates the v2 status endpoint.
	record, err := parseAccessPasswordHash(loadConfig().AccessPasswordHash)
	if err != nil {
		t.Fatal(err)
	}
	_, _, challenge, _, err := auth.statusAndChallenge()
	if err != nil {
		t.Fatal(err)
	}
	loginBody := `{"challenge":"` + challenge + `","proof":"` + testAccessProof(t, record.Verifier, challenge) + `"}`
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(loginBody))
	loginReq.RemoteAddr = "192.0.2.20:1"
	loginW := testAccessServe(handleAccessAuthLogin, loginReq)
	if loginW.Code != http.StatusOK {
		t.Fatalf("v1 login: %d %s", loginW.Code, loginW.Body.String())
	}
	cookie := loginW.Result().Cookies()[0]
	cookieStatus := httptest.NewRequest(http.MethodGet, "/api/auth/v2/status", nil)
	cookieStatus.AddCookie(cookie)
	testAccessJSONBody(t, testAccessServe(handleAccessV2Status, cookieStatus), &statusPayload)
	if statusPayload.Authenticated {
		t.Fatal("v2 status authenticated a cookie-only request")
	}

	if w := testAccessV2LoginRequest(t, "test-pass-9999", "192.0.2.20:1"); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: got %d body=%s", w.Code, w.Body.String())
	}
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.21:1")
	if login.Code != http.StatusOK {
		t.Fatalf("v2 login: %d %s", login.Code, login.Body.String())
	}
	var loginPayload struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, login, &loginPayload)
	request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+loginPayload.Token)
	if w := testAccessServe(protected.ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("bearer did not authorize: %d", w.Code)
	}
	if w := testAccessServe(protected.ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("token was not reusable: %d", w.Code)
	}

	changed := testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, loginPayload.Token)
	if changed.Code != http.StatusOK {
		t.Fatalf("change: %d %s", changed.Code, changed.Body.String())
	}
	var changedPayload struct {
		Enabled bool   `json:"enabled"`
		Token   string `json:"token"`
	}
	testAccessJSONBody(t, changed, &changedPayload)
	if !changedPayload.Enabled || changedPayload.Token == "" || changedPayload.Token == loginPayload.Token {
		t.Fatalf("change response = %+v", changedPayload)
	}
	if w := testAccessServe(protected.ServeHTTP, request); w.Code != http.StatusUnauthorized {
		t.Fatalf("old token survived change: %d", w.Code)
	}
	oldCookie := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	oldCookie.AddCookie(cookie)
	if w := testAccessServe(protected.ServeHTTP, oldCookie); w.Code != http.StatusUnauthorized {
		t.Fatalf("old cookie survived change: %d", w.Code)
	}
	if w := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.22:1"); w.Code != http.StatusUnauthorized {
		t.Fatalf("old password still logs in: %d", w.Code)
	}

	clear := testAccessV2PasswordRequest(t, `{"password":""}`, changedPayload.Token)
	if clear.Code != http.StatusOK {
		t.Fatalf("clear: %d %s", clear.Code, clear.Body.String())
	}
	var clearPayload struct {
		Enabled bool   `json:"enabled"`
		Token   string `json:"token"`
	}
	testAccessJSONBody(t, clear, &clearPayload)
	if clearPayload.Enabled || clearPayload.Token != "" {
		t.Fatalf("clear response = %+v", clearPayload)
	}
	if got := loadConfig().AccessPasswordHash; got != "" {
		t.Fatalf("clear left a record: %q", got)
	}
	if w := testAccessServe(protected.ServeHTTP, httptest.NewRequest(http.MethodGet, "/api/coders", nil)); w.Code != http.StatusNoContent {
		t.Fatalf("clear did not disable enforcement: %d", w.Code)
	}
	// Disabled auth does not answer 401, so ask the manager directly.
	auth.mu.Lock()
	oldTokenValid := auth.jwtValidLocked(changedPayload.Token, time.Now())
	auth.mu.Unlock()
	if oldTokenValid {
		t.Fatal("cleared record still validated the old token")
	}

	fresh := testAccessEnableV2(t, "test-pass-9012")
	request = httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+changedPayload.Token)
	if w := testAccessServe(protected.ServeHTTP, request); w.Code != http.StatusUnauthorized {
		t.Fatalf("old token authorized a re-enabled server: %d", w.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+fresh)
	if w := testAccessServe(protected.ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("fresh token rejected: %d", w.Code)
	}
}

func TestAccessV2PasswordBodyValidation(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)

	invalid := map[string]string{
		"empty body":        ``,
		"missing field":     `{}`,
		"null password":     `{"password":null}`,
		"number password":   `{"password":12345678}`,
		"object password":   `{"password":{"value":"12345678"}}`,
		"unknown field":     `{"password":"12345678","extra":true}`,
		"duplicate field":   `{"password":"12345678","password":"87654321"}`,
		"trailing value":    `{"password":"12345678"}{}`,
		"not an object":     `["12345678"]`,
		"seven bytes":       `{"password":"1234567"}`,
		"too many bytes":    `{"password":"` + strings.Repeat("a", accessPasswordMaxBytes+1) + `"}`,
		"oversized request": `{"password":"` + strings.Repeat("a", accessPasswordBodyLimit) + `"}`,
	}
	for name, body := range invalid {
		if w := testAccessV2PasswordRequest(t, body, ""); w.Code != http.StatusBadRequest {
			t.Errorf("%s: password route got %d want 400", name, w.Code)
		}
		if w := testAccessV2LoginBody(t, body, "192.0.2.30:1"); w.Code != http.StatusBadRequest {
			t.Errorf("%s: login route got %d want 400", name, w.Code)
		}
	}

	for name, password := range map[string]string{
		"eight ascii bytes":  "12345678",
		"four multibyte":     "éééé",
		"escaped characters": `pa"ss\word`,
		"maximum bytes":      strings.Repeat("a", accessPasswordMaxBytes),
	} {
		t.Run(name, func(t *testing.T) {
			withTempConfig(t)
			useTestAccessAuth(t)
			body, err := json.Marshal(map[string]string{"password": password})
			if err != nil {
				t.Fatal(err)
			}
			if w := testAccessV2PasswordRequest(t, string(body), ""); w.Code != http.StatusOK {
				t.Fatalf("%d bytes: got %d body=%s", len(password), w.Code, w.Body.String())
			}
			if w := testAccessV2LoginRequest(t, password, "192.0.2.31:1"); w.Code != http.StatusOK {
				t.Fatalf("login with %d bytes: got %d body=%s", len(password), w.Code, w.Body.String())
			}
		})
	}
}

func TestAccessCredentialPriority(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	protected := testAccessProtected()

	cookie := accessAuth.mustTestCookie(t)

	cases := []struct {
		name    string
		path    string
		request func(*http.Request)
		want    int
	}{
		{"valid bearer", "/api/coders", func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+token) }, http.StatusNoContent},
		{"valid bearer plus cookie", "/api/coders", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+token)
			r.AddCookie(cookie)
		}, http.StatusNoContent},
		{"invalid bearer plus cookie", "/api/coders", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer not-a-token")
			r.AddCookie(cookie)
		}, http.StatusUnauthorized},
		{"empty bearer plus cookie", "/api/coders", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer ")
			r.AddCookie(cookie)
		}, http.StatusUnauthorized},
		{"duplicate bearer plus cookie", "/api/coders", func(r *http.Request) {
			r.Header.Add("Authorization", "Bearer "+token)
			r.Header.Add("Authorization", "Bearer "+token)
			r.AddCookie(cookie)
		}, http.StatusUnauthorized},
		{"bearer on websocket plus cookie", "/ws/pane/a", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+token)
			r.AddCookie(cookie)
		}, http.StatusUnauthorized},
		{"query token on api plus cookie", "/api/coders?token=" + token, func(r *http.Request) { r.AddCookie(cookie) }, http.StatusUnauthorized},
		{"valid query token on websocket", "/ws/pane/a?token=" + token, func(*http.Request) {}, http.StatusNoContent},
		{"duplicate query token", "/ws/pane/a?token=" + token + "&token=" + token, func(*http.Request) {}, http.StatusUnauthorized},
		{"empty query token plus cookie", "/ws/pane/a?token=", func(r *http.Request) { r.AddCookie(cookie) }, http.StatusUnauthorized},
		{"malformed query plus cookie", "/api/coders?token=%zz", func(r *http.Request) { r.AddCookie(cookie) }, http.StatusUnauthorized},
		{"cookie only", "/api/coders", func(r *http.Request) { r.AddCookie(cookie) }, http.StatusNoContent},
		{"no credential", "/api/coders", func(*http.Request) {}, http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, tc.path, nil)
			tc.request(r)
			if w := testAccessServe(protected.ServeHTTP, r); w.Code != tc.want {
				t.Errorf("got %d want %d", w.Code, tc.want)
			}
		})
	}
	_ = auth
}

// mustTestCookie logs in through the v1 route and returns its session cookie.
func (m *accessAuthManager) mustTestCookie(t *testing.T) *http.Cookie {
	t.Helper()
	record, err := parseAccessPasswordHash(loadConfig().AccessPasswordHash)
	if err != nil {
		t.Fatal(err)
	}
	_, _, challenge, _, err := m.statusAndChallenge()
	if err != nil {
		t.Fatal(err)
	}
	body := `{"challenge":"` + challenge + `","proof":"` + testAccessProof(t, record.Verifier, challenge) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(body))
	r.RemoteAddr = "192.0.2.40:1"
	w := testAccessServe(handleAccessAuthLogin, r)
	if w.Code != http.StatusOK {
		t.Fatalf("v1 login: %d %s", w.Code, w.Body.String())
	}
	return w.Result().Cookies()[0]
}

func TestAccessSharedRateLimit(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	// A v1 failure is recorded under the client IP, not the address:port.
	_, _, challenge, _, err := auth.statusAndChallenge()
	if err != nil {
		t.Fatal(err)
	}
	badProof := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x00}, sha256.Size))
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"challenge":"`+challenge+`","proof":"`+badProof+`"}`))
	r.RemoteAddr = "198.51.100.7:1000"
	if w := testAccessServe(handleAccessAuthLogin, r); w.Code != http.StatusUnauthorized {
		t.Fatalf("bad v1 proof: got %d", w.Code)
	}
	auth.mu.Lock()
	attempt, ok := auth.attempts["198.51.100.7"]
	auth.mu.Unlock()
	if !ok || attempt.Failures != 1 || !attempt.RetryAt.After(time.Now()) {
		t.Fatalf("v1 failure not recorded: %+v ok=%v", attempt, ok)
	}

	// A v2 failure lands in the same map under the same key.
	if w := testAccessV2LoginRequest(t, "test-pass-0000", "198.51.100.8:2000"); w.Code != http.StatusUnauthorized {
		t.Fatalf("bad v2 password: got %d", w.Code)
	}
	auth.mu.Lock()
	attempt, ok = auth.attempts["198.51.100.8"]
	auth.mu.Unlock()
	if !ok || attempt.Failures != 1 {
		t.Fatalf("v2 failure not recorded: %+v ok=%v", attempt, ok)
	}

	// While a client is in backoff, both routes reject it; another client
	// is unaffected. Pin the window so a slow KDF cannot expire it first.
	auth.mu.Lock()
	auth.attempts["198.51.100.8"] = accessLoginAttempt{
		Failures:    1,
		RetryAt:     time.Now().Add(time.Minute),
		LastFailure: time.Now(),
	}
	auth.mu.Unlock()
	if w := testAccessV2LoginRequest(t, testAccessPassword, "198.51.100.8:2000"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("v2 login ignored the shared backoff: %d", w.Code)
	}
	_, _, challenge, _, err = auth.statusAndChallenge()
	if err != nil {
		t.Fatal(err)
	}
	record, err := parseAccessPasswordHash(loadConfig().AccessPasswordHash)
	if err != nil {
		t.Fatal(err)
	}
	good := `{"challenge":"` + challenge + `","proof":"` + testAccessProof(t, record.Verifier, challenge) + `"}`
	r = httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(good))
	r.RemoteAddr = "198.51.100.8:3000"
	if w := testAccessServe(handleAccessAuthLogin, r); w.Code != http.StatusTooManyRequests {
		t.Fatalf("v1 login ignored the shared backoff: %d", w.Code)
	}
	if w := testAccessV2LoginRequest(t, testAccessPassword, "198.51.100.9:1000"); w.Code != http.StatusOK {
		t.Fatalf("independent client was rate-limited: %d", w.Code)
	}
	auth.mu.Lock()
	_, ok = auth.attempts["198.51.100.9"]
	auth.mu.Unlock()
	if ok {
		t.Fatal("successful login did not clear the client backoff")
	}
}

func TestAccessRecordTransactionFailureKeepsOldState(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	before := loadConfig().AccessPasswordHash
	generation := auth.accessGeneration()

	previousWriter := writeConfigFile
	writeConfigFile = func(string, []byte, os.FileMode) error { return errors.New("disk full") }
	t.Cleanup(func() { writeConfigFile = previousWriter })

	if w := testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, token); w.Code != http.StatusInternalServerError {
		t.Fatalf("failed write: got %d want 500 body=%s", w.Code, w.Body.String())
	}
	if got := loadConfig().AccessPasswordHash; got != before {
		t.Fatalf("failed write changed the record: %q", got)
	}
	if got := auth.accessGeneration(); got != generation {
		t.Fatalf("failed write advanced generation: %d want %d", got, generation)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("old token died on a failed write: %d", w.Code)
	}
	if w := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.50:1"); w.Code != http.StatusOK {
		t.Fatalf("old password stopped working after a failed write: %d", w.Code)
	}

	// The v1 route must fail the same way instead of reporting success.
	writeConfigFile = func(string, []byte, os.FileMode) error { return errors.New("disk full") }
	v1Body := `{"password_hash":"` + testAccessHash() + `"}`
	r := httptest.NewRequest(http.MethodPost, "/api/auth/password", strings.NewReader(v1Body))
	r.AddCookie(testAccessCookieFor(t, auth))
	if w := testAccessServe(handleAccessPassword, r); w.Code != http.StatusInternalServerError {
		t.Fatalf("v1 failed write: got %d want 500 body=%s", w.Code, w.Body.String())
	}
}

// testAccessCookieFor mints a v1 session cookie from the current record.
func testAccessCookieFor(t *testing.T, auth *accessAuthManager) *http.Cookie {
	t.Helper()
	auth.mu.Lock()
	defer auth.mu.Unlock()
	token, err := auth.newSessionLocked(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: accessSessionCookie, Value: token}
}

func TestAccessStaleCredentialRejectedAtCommit(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)

	// Capture the credential, then rotate the record before the commit path
	// runs. The stale credential must be re-evaluated under the lock.
	credential := accessCredential{State: accessCredentialPresent, Token: token}
	if _, err := auth.setRawPassword("test-pass-5678", accessCredential{}); !errors.Is(err, errAccessUnauthorized) {
		t.Fatalf("unauthorized change: got %v want %v", err, errAccessUnauthorized)
	}
	if _, err := auth.setRawPassword("test-pass-5678", credential); err != nil {
		t.Fatalf("authorized change failed: %v", err)
	}
	if _, err := auth.setEncodedPassword(testAccessHash(), credential); !errors.Is(err, errAccessUnauthorized) {
		t.Fatalf("stale credential accepted after rotation: %v", err)
	}
	if _, err := auth.setEncodedPassword(testAccessHash(), accessCredential{}); !errors.Is(err, errAccessUnauthorized) {
		t.Fatalf("anonymous change accepted while enabled: %v", err)
	}
}

func TestAccessV2LoginDoesNotRehashCurrentRecord(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)

	auth.mu.Lock()
	before := auth.record.encoded()
	auth.mu.Unlock()
	if w := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.60:1"); w.Code != http.StatusOK {
		t.Fatalf("login: %d", w.Code)
	}
	auth.mu.Lock()
	after := auth.record.encoded()
	auth.mu.Unlock()
	if before != after {
		t.Fatalf("ordinary login rewrote the record: %q -> %q", before, after)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("login invalidated an existing token: %d", w.Code)
	}
}

func TestAccessV2LoginRehashesStaleRecord(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)

	stale := testAccessStaleHash(t)
	if err := saveAccessPasswordHash(stale); err != nil {
		t.Fatal(err)
	}
	if err := auth.configure(stale); err != nil {
		t.Fatal(err)
	}
	oldRecord, err := parseAccessPasswordHash(stale)
	if err != nil {
		t.Fatal(err)
	}
	oldKey, err := accessJWTKey(oldRecord)
	if err != nil {
		t.Fatal(err)
	}
	oldToken, err := mintAccessJWT(oldKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	oldCookie := testAccessCookieFor(t, auth)

	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.70:1")
	if login.Code != http.StatusOK {
		t.Fatalf("login against stale record: %d %s", login.Code, login.Body.String())
	}
	var payload struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, login, &payload)

	persisted, err := parseAccessPasswordHash(loadConfig().AccessPasswordHash)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Iterations != accessPasswordHashIterations {
		t.Fatalf("rehash persisted %d iterations", persisted.Iterations)
	}
	if bytes.Equal(persisted.Salt, oldRecord.Salt) {
		t.Fatal("rehash kept the old salt")
	}
	if ok, err := persisted.matchesPassword(testAccessPassword); err != nil || !ok {
		t.Fatalf("rehashed record lost the password: ok=%v err=%v", ok, err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+oldToken)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusUnauthorized {
		t.Fatalf("pre-rehash token survived: %d", w.Code)
	}
	cookieRequest := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	cookieRequest.AddCookie(oldCookie)
	if w := testAccessServe(testAccessProtected().ServeHTTP, cookieRequest); w.Code != http.StatusUnauthorized {
		t.Fatalf("pre-rehash cookie survived: %d", w.Code)
	}
	newRequest := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	newRequest.Header.Set("Authorization", "Bearer "+payload.Token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, newRequest); w.Code != http.StatusNoContent {
		t.Fatalf("rehash token rejected: %d", w.Code)
	}
}

func TestAccessStaleConfigSaveKeepsAuthHash(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	snapshot := loadConfig()
	testAccessEnableV2Clear(t, "test-pass-5678")
	rotated := loadConfig().AccessPasswordHash

	saveConfig(snapshot)
	if got := loadConfig().AccessPasswordHash; got != rotated {
		t.Fatalf("stale save restored an old access hash: %q want %q", got, rotated)
	}
}

// testAccessEnableV2Clear rotates an enabled password through the v2 route.
func testAccessEnableV2Clear(t *testing.T, password string) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		t.Fatal(err)
	}
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.80:1")
	var payload struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, login, &payload)
	if w := testAccessV2PasswordRequest(t, string(body), payload.Token); w.Code != http.StatusOK {
		t.Fatalf("rotate: %d %s", w.Code, w.Body.String())
	}
}

func TestAccessRestartAfterV2Change(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)

	restarted := newAccessAuthManager()
	if err := restarted.configure(loadConfig().AccessPasswordHash); err != nil {
		t.Fatal(err)
	}
	previous := accessAuth
	accessAuth = restarted
	t.Cleanup(func() { accessAuth = previous })

	request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("token did not survive restart: %d", w.Code)
	}
	if w := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.90:1"); w.Code != http.StatusOK {
		t.Fatalf("password login after restart: %d", w.Code)
	}
}

func testAccessStaleHash(t *testing.T) string {
	t.Helper()
	salt := bytes.Repeat([]byte{0x11}, accessPasswordSaltBytes)
	verifier, err := deriveAccessVerifier(testAccessPassword, salt, accessPasswordMinIterations)
	if err != nil {
		t.Fatal(err)
	}
	return accessPasswordRecord{Iterations: accessPasswordMinIterations, Salt: salt, Verifier: verifier}.encoded()
}

// --- M1c: client-facing sockets are fenced to the access generation ---

type testAuthSocket struct {
	closed bool
}

func (s *testAuthSocket) Close() error {
	s.closed = true
	return nil
}

func testAccessUseHub(t *testing.T) *ws.Hub {
	t.Helper()
	hub := ws.NewHub(0)
	previous := wsHub
	wsHub = hub
	t.Cleanup(func() {
		wsHub = previous
		_ = hub.Close()
	})
	return hub
}

func TestAccessPasswordChangeFencesStaleSockets(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	hub := testAccessUseHub(t)

	token := testAccessEnableV2(t, testAccessPassword)
	generation := accessAuth.accessGeneration()

	stale := &testAuthSocket{}
	if !hub.AdmitAuth(stale, ws.AuthFence{Generation: generation}) {
		t.Fatal("socket was not admitted at the current generation")
	}
	// An upgrade that authenticated before a password change is refused.
	if hub.AdmitAuth(&testAuthSocket{}, ws.AuthFence{Generation: generation - 1}) {
		t.Fatal("stale generation was admitted")
	}

	if w := testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, token); w.Code != http.StatusOK {
		t.Fatalf("change: %d %s", w.Code, w.Body.String())
	}
	if !stale.closed {
		t.Fatal("password change did not close the socket admitted at the old generation")
	}

	current := &testAuthSocket{}
	now := accessAuth.accessGeneration()
	if !hub.AdmitAuth(current, ws.AuthFence{Generation: now}) {
		t.Fatal("socket was not admitted after the change")
	}
	hub.RotateAuth(now)
	if current.closed {
		t.Fatal("rotation closed a socket admitted at the current generation")
	}
}

func TestAccessFailedWriteClosesNoSockets(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	hub := testAccessUseHub(t)

	token := testAccessEnableV2(t, testAccessPassword)
	generation := accessAuth.accessGeneration()
	socket := &testAuthSocket{}
	if !hub.AdmitAuth(socket, ws.AuthFence{Generation: generation}) {
		t.Fatal("socket was not admitted at the current generation")
	}

	previousWriter := writeConfigFile
	writeConfigFile = func(string, []byte, os.FileMode) error { return errors.New("disk full") }
	t.Cleanup(func() { writeConfigFile = previousWriter })
	if w := testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, token); w.Code != http.StatusInternalServerError {
		t.Fatalf("failed write: got %d want 500", w.Code)
	}
	if socket.closed {
		t.Fatal("a failed password write closed live sockets")
	}

	writeConfigFile = previousWriter
	if w := testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, token); w.Code != http.StatusOK {
		t.Fatalf("change after failed write: %d %s", w.Code, w.Body.String())
	}
	if !socket.closed {
		t.Fatal("successful change did not close the stale socket")
	}
}

func TestAccessMiddlewareAttachesWSFence(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	cookie := testAccessCookieFor(t, accessAuth)

	var fence ws.AuthFence
	var fenced bool
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		fence, fenced = ws.AuthFenceFrom(r.Context())
	})
	w := httptest.NewRecorder()
	wsRequest := httptest.NewRequest(http.MethodGet, "/ws/pane/p1", nil)
	wsRequest.AddCookie(cookie)
	accessAuthMiddleware(next).ServeHTTP(w, wsRequest)
	if w.Code != http.StatusOK || !fenced {
		t.Fatalf("ws request: code=%d fenced=%v", w.Code, fenced)
	}
	if fence.Generation != accessAuth.accessGeneration() {
		t.Fatalf("fence generation = %d want %d", fence.Generation, accessAuth.accessGeneration())
	}

	fenced = true
	apiRequest := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	apiRequest.AddCookie(cookie)
	accessAuthMiddleware(next).ServeHTTP(httptest.NewRecorder(), apiRequest)
	if fenced {
		t.Fatal("api request carried a ws fence")
	}
}

func TestAccessDisabledPreservesOpenRequests(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	// With no password set, a malformed query must not turn into a 401: that
	// is the pre-auth behavior.
	w := testAccessServe(testAccessProtected().ServeHTTP,
		httptest.NewRequest(http.MethodGet, "/api/coders?token=%zz", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("disabled auth rejected a request: %d", w.Code)
	}
}
