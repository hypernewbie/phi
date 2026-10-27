package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"
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
