package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

const (
	testAccessPassword        = "test-pass-1234"
	testAccessVerifier100kHex = "c8b0c844387530bca51e274c4e4e23aa4f5fd1daa43c52049f0f640041485404"
	testAccessVerifier600kHex = "a5905483f9c280f6213bf99b80d651d17ff85bef07aa9a572d6cdd10507a456a"
	testAccessJWTKeyHex       = "8351c1f8f8f34c7843cd0484f5cfe906d502e2b66de55c43e7b6fc083a229e6b"
	testAccessJWTNonce        = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM"
	// testAccessJWTFrozen is the retired 100-year vector. It carries no
	// record/epoch/family claims and exceeds the maximum lifetime, so it must
	// reject under the same signing key it was signed with.
	testAccessJWTFrozen      = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJwaGkiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6NDg1MzYwMDAwMCwianRpIjoiTXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TSJ9.Z92aWHlvUPkKTcyC_WGaHiApRDyJGW4scY9OgjKX9Nw"
	testAccessJWTIssuedAt    = int64(1700000000)
	testAccessJWTExpiresAt   = int64(4853600000)
	testAccessJWTValidHeader = `{"alg":"HS256","typ":"JWT"}`

	// Accepted short-lived vector: rid 0x44*32, epoch 7, fid 0x55*32. The
	// expected bytes were computed outside this package from the plan's key,
	// times, and synthetic claims, so the formatter is checked against an
	// independent calculation rather than against itself.
	testAccessJWTShortExpiresAt = int64(1700003600)
	testAccessJWTRecordID       = "REREREREREREREREREREREREREREREREREREREREREQ"
	testAccessJWTEpoch          = uint64(7)
	testAccessJWTFamilyID       = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU"
	testAccessJWTShort          = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJwaGkiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDAwMzYwMCwianRpIjoiTXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TSIsInJpZCI6IlJFUkVSRVJFUkVSRVJFUkVSRVJFUkVSRVJFUkVSRVJFUkVSRVJFUkVSRVEiLCJlcG9jaCI6NywiZmlkIjoiVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVSJ9.aMQebo6s21MFuAHzU7gRohC1sDHXCq1wAXkFzG8i1jo"
)

// testAccessJWTPayloadWith builds one payload from raw JSON fragments, so a
// rejection case can isolate exactly one defect.
func testAccessJWTPayloadWith(issuer, issuedAt, expiresAt, nonce, recordID, epoch, familyID string) string {
	return `{"iss":` + issuer + `,"iat":` + issuedAt + `,"exp":` + expiresAt +
		`,"jti":` + nonce + `,"rid":` + recordID + `,"epoch":` + epoch + `,"fid":` + familyID + `}`
}

func testAccessJWTValidPayload() string {
	return testAccessJWTPayloadWith(
		`"phi"`,
		strconv.FormatInt(testAccessJWTIssuedAt, 10),
		strconv.FormatInt(testAccessJWTShortExpiresAt, 10),
		`"`+testAccessJWTNonce+`"`,
		`"`+testAccessJWTRecordID+`"`,
		strconv.FormatUint(testAccessJWTEpoch, 10),
		`"`+testAccessJWTFamilyID+`"`,
	)
}

func testAccessJWTRevocation() accessJWTRevocation {
	return accessJWTRevocation{
		RecordID: testAccessJWTRecordID,
		Epoch:    testAccessJWTEpoch,
		FamilyID: testAccessJWTFamilyID,
	}
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

func TestAccessJWTFrozenVectorIsRejected(t *testing.T) {
	key := testAccessJWTSigningKey(t)
	// The retired vector predates the record/epoch/family claims, so it can only
	// be reproduced from its own raw payload.
	frozenPayload := `{"iss":"phi","iat":` + strconv.FormatInt(testAccessJWTIssuedAt, 10) +
		`,"exp":` + strconv.FormatInt(testAccessJWTExpiresAt, 10) + `,"jti":"` + testAccessJWTNonce + `"}`
	if token := signTestAccessJWT(key, testAccessJWTValidHeader, frozenPayload); token != testAccessJWTFrozen {
		t.Fatalf("token = %s\nwant    %s", token, testAccessJWTFrozen)
	}
	// It is signed with the key the server still uses, so only the claim and
	// lifetime rules can reject it.
	if _, err := parseAccessJWT(key, testAccessJWTFrozen, time.Unix(testAccessJWTIssuedAt+1, 0), accessJWTClockAllowance); err == nil {
		t.Fatal("retired 100-year vector was accepted")
	}
	// The two defects reject independently: the same claim-less shape with a
	// current lifetime still fails, and empty identities are never accepted.
	shortFrozen := testAccessJWTPayloadWith(`"phi"`, strconv.FormatInt(testAccessJWTIssuedAt, 10),
		strconv.FormatInt(testAccessJWTIssuedAt+3600, 10), `"`+testAccessJWTNonce+`"`, `""`, `0`, `""`)
	if _, err := parseAccessJWT(key, signTestAccessJWT(key, testAccessJWTValidHeader, shortFrozen), time.Unix(testAccessJWTIssuedAt, 0), accessJWTClockAllowance); err == nil {
		t.Fatal("empty record identity and epoch were accepted")
	}
}

func TestAccessJWTShortVectorAccepted(t *testing.T) {
	key := testAccessJWTSigningKey(t)
	revocation := testAccessJWTRevocation()
	token, err := formatAccessJWT(key, testAccessJWTIssuedAt, testAccessJWTShortExpiresAt, testAccessJWTNonce, revocation)
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	if token != testAccessJWTShort {
		t.Fatalf("token = %s\nwant    %s", token, testAccessJWTShort)
	}
	claims, err := parseAccessJWT(key, testAccessJWTShort, time.Unix(testAccessJWTIssuedAt+1, 0), accessJWTClockAllowance)
	if err != nil {
		t.Fatalf("parse accepted vector: %v", err)
	}
	if claims.IssuedAt.Unix() != testAccessJWTIssuedAt || claims.ExpiresAt.Unix() != testAccessJWTShortExpiresAt {
		t.Errorf("claims times = %d/%d", claims.IssuedAt.Unix(), claims.ExpiresAt.Unix())
	}
	if claims.Nonce != testAccessJWTNonce {
		t.Errorf("nonce = %q want %q", claims.Nonce, testAccessJWTNonce)
	}
	if claims.RecordID != testAccessJWTRecordID || claims.Epoch != testAccessJWTEpoch || claims.FamilyID != testAccessJWTFamilyID {
		t.Errorf("revocation claims = %q/%d/%q", claims.RecordID, claims.Epoch, claims.FamilyID)
	}

	// A minted token carries the same claim set and a one-hour lifetime.
	minted, err := mintAccessJWT(key, time.Unix(testAccessJWTIssuedAt, 0), revocation)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	mintedClaims, err := parseAccessJWT(key, minted, time.Unix(testAccessJWTIssuedAt, 0), accessJWTClockAllowance)
	if err != nil {
		t.Fatalf("parse minted token: %v", err)
	}
	if mintedClaims.Nonce == "" || mintedClaims.Nonce == testAccessJWTNonce {
		t.Errorf("minted token did not use a fresh nonce: %q", mintedClaims.Nonce)
	}
	if want := time.Unix(testAccessJWTIssuedAt, 0).Add(accessJWTLifetime).Unix(); mintedClaims.ExpiresAt.Unix() != want {
		t.Errorf("minted expiry = %d want %d", mintedClaims.ExpiresAt.Unix(), want)
	}
	if got := mintedClaims.ExpiresAt.Sub(mintedClaims.IssuedAt); got != time.Hour {
		t.Errorf("minted lifetime = %v want 1h", got)
	}
	if mintedClaims.RecordID != testAccessJWTRecordID || mintedClaims.Epoch != testAccessJWTEpoch || mintedClaims.FamilyID != testAccessJWTFamilyID {
		t.Errorf("minted revocation claims = %q/%d/%q", mintedClaims.RecordID, mintedClaims.Epoch, mintedClaims.FamilyID)
	}
}

func TestAccessJWTLifetimeBounds(t *testing.T) {
	key := testAccessJWTSigningKey(t)
	now := time.Unix(testAccessJWTIssuedAt, 0)
	sign := func(iat, exp int64) string {
		return signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(
			`"phi"`, strconv.FormatInt(iat, 10), strconv.FormatInt(exp, 10),
			`"`+testAccessJWTNonce+`"`, `"`+testAccessJWTRecordID+`"`,
			strconv.FormatUint(testAccessJWTEpoch, 10), `"`+testAccessJWTFamilyID+`"`))
	}

	if _, err := parseAccessJWT(key, sign(now.Unix(), now.Unix()+3600), now, accessJWTClockAllowance); err != nil {
		t.Fatalf("exact 3600-second lifetime rejected: %v", err)
	}
	for name, token := range map[string]string{
		"3601 seconds":     sign(now.Unix(), now.Unix()+3601),
		"equal times":      sign(now.Unix(), now.Unix()),
		"expiry before":    sign(now.Unix(), now.Unix()-1),
		"nonpositive iat":  sign(0, 3600),
		"nonpositive exp":  sign(-7200, -3600),
		"overflow attempt": sign(1, math.MaxInt64),
	} {
		if _, err := parseAccessJWT(key, token, now, accessJWTClockAllowance); err == nil {
			t.Errorf("%s: unexpectedly accepted", name)
		}
	}
}

func TestAccessJWTClockSkewAndExpiryAllowance(t *testing.T) {
	key := testAccessJWTSigningKey(t)
	sign := func(iat, exp int64) string {
		return signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(
			`"phi"`, strconv.FormatInt(iat, 10), strconv.FormatInt(exp, 10),
			`"`+testAccessJWTNonce+`"`, `"`+testAccessJWTRecordID+`"`,
			strconv.FormatUint(testAccessJWTEpoch, 10), `"`+testAccessJWTFamilyID+`"`))
	}
	base := int64(1700000000)

	// Future iat: 30 seconds of skew is allowed, 31 is not.
	if _, err := parseAccessJWT(key, sign(base+30, base+30+3600), time.Unix(base, 0), accessJWTClockAllowance); err != nil {
		t.Errorf("iat +30s rejected: %v", err)
	}
	if _, err := parseAccessJWT(key, sign(base+31, base+31+3600), time.Unix(base, 0), accessJWTClockAllowance); err == nil {
		t.Error("iat +31s accepted")
	}

	// Expiry: HTTP accepts up to exp+29s and rejects at exp+30s.
	expiry := base + 3600
	token := sign(base, expiry)
	if _, err := parseAccessJWT(key, token, time.Unix(expiry+29, 0), accessJWTClockAllowance); err != nil {
		t.Errorf("exp+29s rejected under the HTTP allowance: %v", err)
	}
	if _, err := parseAccessJWT(key, token, time.Unix(expiry+30, 0), accessJWTClockAllowance); err == nil {
		t.Error("exp+30s accepted")
	}
	// The allowance must not leak into socket admission: exp itself closes it.
	if _, err := parseAccessJWT(key, token, time.Unix(expiry, 0), 0); err == nil {
		t.Error("socket allowance accepted a token at exp")
	}
	// And the allowance never extends the maximum minted lifetime.
	if _, err := parseAccessJWT(key, sign(base, base+3601), time.Unix(base+3601, 0), accessJWTClockAllowance); err == nil {
		t.Error("allowance rescued an overlong lifetime")
	}
}

func TestAccessJWTParseRejectsMalformedTokens(t *testing.T) {
	key := testAccessJWTSigningKey(t)
	now := time.Unix(testAccessJWTIssuedAt+1, 0)
	validPayload := testAccessJWTValidPayload()
	issued := strconv.FormatInt(testAccessJWTIssuedAt, 10)
	shortExpiry := strconv.FormatInt(testAccessJWTShortExpiresAt, 10)
	nonce := `"` + testAccessJWTNonce + `"`
	recordID := `"` + testAccessJWTRecordID + `"`
	familyID := `"` + testAccessJWTFamilyID + `"`

	if _, err := parseAccessJWT(key, signTestAccessJWT(key, testAccessJWTValidHeader, validPayload), now, accessJWTClockAllowance); err != nil {
		t.Fatalf("valid control token rejected: %v", err)
	}

	signed := map[string]string{
		"wrong algorithm":         signTestAccessJWT(key, `{"alg":"none","typ":"JWT"}`, validPayload),
		"wrong type":              signTestAccessJWT(key, `{"alg":"HS256","typ":"JWE"}`, validPayload),
		"missing header field":    signTestAccessJWT(key, `{"alg":"HS256"}`, validPayload),
		"extra header field":      signTestAccessJWT(key, `{"alg":"HS256","typ":"JWT","kid":"x"}`, validPayload),
		"duplicate header field":  signTestAccessJWT(key, `{"alg":"HS256","typ":"JWT","typ":"JWT"}`, validPayload),
		"header not an object":    signTestAccessJWT(key, `["HS256"]`, validPayload),
		"wrong issuer":            signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"other"`, issued, shortExpiry, nonce, recordID, `7`, familyID)),
		"null issuer":             signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`null`, issued, shortExpiry, nonce, recordID, `7`, familyID)),
		"missing expiry":          signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":`+issued+`,"jti":`+nonce+`,"rid":`+recordID+`,"epoch":7,"fid":`+familyID+`}`),
		"missing record id":       signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":`+issued+`,"exp":`+shortExpiry+`,"jti":`+nonce+`,"epoch":7,"fid":`+familyID+`}`),
		"missing epoch":           signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":`+issued+`,"exp":`+shortExpiry+`,"jti":`+nonce+`,"rid":`+recordID+`,"fid":`+familyID+`}`),
		"missing family id":       signTestAccessJWT(key, testAccessJWTValidHeader, `{"iss":"phi","iat":`+issued+`,"exp":`+shortExpiry+`,"jti":`+nonce+`,"rid":`+recordID+`,"epoch":7}`),
		"extra payload field":     signTestAccessJWT(key, testAccessJWTValidHeader, validPayload[:len(validPayload)-1]+`,"sub":"x"}`),
		"duplicate payload field": signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi","iss":"phi"`, issued, shortExpiry, nonce, recordID, `7`, familyID)),
		"string issued at":        signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, `"`+issued+`"`, shortExpiry, nonce, recordID, `7`, familyID)),
		"null issued at":          signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, `null`, shortExpiry, nonce, recordID, `7`, familyID)),
		"null expiry":             signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, `null`, nonce, recordID, `7`, familyID)),
		"null record id":          signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, `null`, `7`, familyID)),
		"null epoch":              signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, recordID, `null`, familyID)),
		"null family id":          signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, recordID, `7`, `null`)),
		"zero epoch":              signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, recordID, `0`, familyID)),
		"negative epoch":          signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, recordID, `-1`, familyID)),
		"floating epoch":          signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, recordID, `7.5`, familyID)),
		"oversized epoch":         signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, recordID, `18446744073709551616`, familyID)),
		"string epoch":            signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, recordID, `"7"`, familyID)),
		"short record id":         signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, `"`+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x44}, 16))+`"`, `7`, familyID)),
		"padded family id":        signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, recordID, `7`, `"`+testAccessJWTFamilyID+`="`)),
		"empty record id":         signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, nonce, `""`, `7`, familyID)),
		"null nonce":              signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, `null`, recordID, `7`, familyID)),
		"fractional expiry":       signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry+`.5`, nonce, recordID, `7`, familyID)),
		"short nonce":             signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, `"`+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x33}, 16))+`"`, recordID, `7`, familyID)),
		"padded nonce":            signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, `"`+testAccessJWTNonce+`="`, recordID, `7`, familyID)),
		"empty nonce":             signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, shortExpiry, `""`, recordID, `7`, familyID)),
		"expired past allowance":  signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(`"phi"`, issued, strconv.FormatInt(now.Unix()-31, 10), nonce, recordID, `7`, familyID)),
		"trailing payload value":  signTestAccessJWT(key, testAccessJWTValidHeader, validPayload+`{}`),
	}
	for name, token := range signed {
		if _, err := parseAccessJWT(key, token, now, accessJWTClockAllowance); err == nil {
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
		if _, err := parseAccessJWT(key, token, now, accessJWTClockAllowance); err == nil {
			t.Errorf("%s: unexpectedly accepted", name)
		}
	}
}

// --- M1a: record, epoch, and family revocation state ---

func TestAccessJWTRevocationRequiresCurrentRecordEpochAndFamily(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	encoded := testAccessHash()
	if err := auth.configure(encoded); err != nil {
		t.Fatal(err)
	}
	// Record identity is durable state, so it is minted by a real v2 login
	// rather than by configure.
	auth.mu.Lock()
	auth.v2.recordID = testAccessJWTRecordID
	auth.v2.epoch = testAccessJWTEpoch
	if key, err := accessRefreshKey(auth.record); err == nil {
		auth.v2.refreshKey = key
	}
	auth.mu.Unlock()
	token := testAccessSignedToken(t, auth)
	now := time.Now()

	auth.mu.Lock()
	if !auth.jwtValidLocked(token, now, accessJWTClockAllowance) {
		t.Fatal("freshly minted token rejected")
	}
	recordID, epoch := auth.v2.recordID, auth.v2.epoch
	auth.mu.Unlock()
	if recordID == "" || epoch == 0 {
		t.Fatalf("minted token has no record identity: rid=%q epoch=%d", recordID, epoch)
	}
	claims, err := parseAccessJWT(mustTestAccessJWTKey(t, auth), token, now, accessJWTClockAllowance)
	if err != nil {
		t.Fatalf("parse minted token: %v", err)
	}
	if claims.RecordID != recordID || claims.Epoch != epoch {
		t.Errorf("claims = %q/%d want %q/%d", claims.RecordID, claims.Epoch, recordID, epoch)
	}

	// Reconfiguring the same record keeps the durable identity: restarting phi
	// must not sign every browser out, so record identity lives in the state
	// file rather than in memory.
	if err := auth.configure(encoded); err != nil {
		t.Fatal(err)
	}
	auth.mu.Lock()
	keptRecord := auth.v2.recordID
	restartAccepted := auth.jwtValidLocked(token, now, accessJWTClockAllowance)
	auth.mu.Unlock()
	if keptRecord != recordID {
		t.Fatalf("restart rotated the record identity: %q want %q", keptRecord, recordID)
	}
	if !restartAccepted {
		t.Error("restart rejected a live token for the unchanged record")
	}

	// A stale record identity rejects the token even when the key is unchanged.
	auth.mu.Lock()
	auth.v2.recordID = ""
	staleRecord := auth.jwtValidLocked(token, now, accessJWTClockAllowance)
	auth.v2.recordID = recordID
	auth.mu.Unlock()
	if staleRecord {
		t.Error("stale record identity accepted")
	}

	// A stale epoch rejects a token whose record and family are still current.
	liveToken := testAccessSignedToken(t, auth)
	auth.mu.Lock()
	auth.v2.epoch++
	staleEpoch := auth.jwtValidLocked(liveToken, now, accessJWTClockAllowance)
	auth.v2.epoch--
	auth.mu.Unlock()
	if staleEpoch {
		t.Error("stale epoch accepted")
	}

	// An unknown family is rejected, and so is a family past its deadline.
	liveClaims, err := parseAccessJWT(mustTestAccessJWTKey(t, auth), liveToken, now, accessJWTClockAllowance)
	if err != nil {
		t.Fatalf("parse live token: %v", err)
	}
	auth.mu.Lock()
	delete(auth.v2.families, liveClaims.FamilyID)
	auth.mu.Unlock()
	if auth.jwtValidLocked(liveToken, now, accessJWTClockAllowance) {
		t.Error("unknown family accepted")
	}
	expiring := testAccessSignedToken(t, auth)
	// The family deadline carries the same expiry allowance as the token, so
	// expire it past that allowance to prove the family itself is dead.
	deadline := now.Add(-accessJWTClockAllowance - time.Second).Unix()
	auth.mu.Lock()
	for _, family := range auth.v2.families {
		family.IdleExpiresAt = deadline
	}
	auth.mu.Unlock()
	if auth.jwtValidLocked(expiring, now, accessJWTClockAllowance) {
		t.Error("expired family accepted")
	}
}

func TestAccessJWTFullClaimsAcceptedThroughMiddleware(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)

	// The end-to-end path is the real proof that the minted claim set and the
	// exact-key parser agree; a claim added on one side only fails here.
	request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("full-claim token rejected by middleware: %d", w.Code)
	}

	// A correctly signed token missing one required claim is refused.
	key := mustTestAccessJWTKey(t, accessAuth)
	auth := accessAuth
	auth.mu.Lock()
	claims := accessJWTRevocation{RecordID: auth.v2.recordID, Epoch: auth.v2.epoch}
	familyID, _, err := auth.issueAccessFamilyLocked(time.Now())
	auth.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}

	noFamily := signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(
		`"phi"`, strconv.FormatInt(time.Now().Unix(), 10), strconv.FormatInt(time.Now().Unix()+3600, 10),
		`"`+testAccessJWTNonce+`"`, `"`+claims.RecordID+`"`, strconv.FormatUint(claims.Epoch, 10), `"`))
	request = httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+noFamily)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusUnauthorized {
		t.Fatalf("token with an empty family id authorized: %d", w.Code)
	}

	// The same identity with every claim present is accepted.
	full := signTestAccessJWT(key, testAccessJWTValidHeader, testAccessJWTPayloadWith(
		`"phi"`, strconv.FormatInt(time.Now().Unix(), 10), strconv.FormatInt(time.Now().Unix()+3600, 10),
		`"`+testAccessJWTNonce+`"`, `"`+claims.RecordID+`"`, strconv.FormatUint(claims.Epoch, 10), `"`+familyID+`"`))
	request = httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+full)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("externally signed full-claim token rejected: %d", w.Code)
	}
}

func TestAccessJWTWebsocketAdmissionUsesExpiryWithoutAllowance(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	if got := accessExpiryAllowance("/ws/panes/1"); got != 0 {
		t.Errorf("socket allowance = %v want 0", got)
	}
	if got := accessExpiryAllowance("/api/coders"); got != accessJWTClockAllowance {
		t.Errorf("api allowance = %v want %v", got, accessJWTClockAllowance)
	}

	key := mustTestAccessJWTKey(t, auth)
	auth.mu.Lock()
	// The fixed vector carries its own synthetic identity, so pin it here.
	auth.v2.recordID = testAccessJWTRecordID
	auth.v2.epoch = testAccessJWTEpoch
	revocation := accessJWTRevocation{RecordID: auth.v2.recordID, Epoch: auth.v2.epoch}
	auth.mu.Unlock()
	familyID, expiresAt, err := func() (string, time.Time, error) {
		auth.mu.Lock()
		defer auth.mu.Unlock()
		return auth.issueAccessFamilyLocked(time.Unix(testAccessJWTIssuedAt, 0))
	}()
	if err != nil {
		t.Fatal(err)
	}
	auth.mu.Lock()
	if family := auth.v2.families[familyID]; family != nil {
		family.IdleExpiresAt = expiresAt.Unix()
	}
	auth.mu.Unlock()
	revocation.FamilyID = familyID
	token, err := formatAccessJWT(key, testAccessJWTIssuedAt, testAccessJWTShortExpiresAt, testAccessJWTNonce, revocation)
	if err != nil {
		t.Fatal(err)
	}

	expiredAt := time.Unix(testAccessJWTShortExpiresAt, 0)
	if auth.jwtValidLocked(token, expiredAt, 0) {
		t.Error("socket allowance admitted a token at exp")
	}
	if !auth.jwtValidLocked(token, expiredAt.Add(-time.Second), 0) {
		t.Error("socket rejected a live token")
	}
	if !auth.jwtValidLocked(token, expiredAt.Add(29*time.Second), accessJWTClockAllowance) {
		t.Error("http allowance rejected a token inside exp+29s")
	}
	if auth.jwtValidLocked(token, expiredAt.Add(30*time.Second), accessJWTClockAllowance) {
		t.Error("http allowance admitted a token at exp+30s")
	}
}

func mustTestAccessJWTKey(t *testing.T, auth *accessAuthManager) []byte {
	t.Helper()
	auth.mu.Lock()
	defer auth.mu.Unlock()
	if len(auth.jwtKey) != accessJWTKeyBytes {
		t.Fatalf("manager has no signing key")
	}
	return append([]byte(nil), auth.jwtKey...)
}

func TestAccessConfigureDerivesJWTKeyAndAdvancesGeneration(t *testing.T) {
	withTempConfig(t)
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
	r := testAccessV2Request(http.MethodPost, "/api/auth/v2/password", body)
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	return testAccessServe(handleAccessV2Password, r)
}

// testAccessV2Request builds the request shape the v2 POST routes require: the
// non-secret custom header plus JSON. No Origin is set, which is the native
// caller case the contract allows.
func testAccessV2Request(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set(accessV2Header, accessV2HeaderValue)
	r.Header.Set("Content-Type", "application/json")
	return r
}

func testAccessV2LoginBody(t *testing.T, body, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	r := testAccessV2Request(http.MethodPost, "/api/auth/v2/login", body)
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
	// A successful set/change now issues both v2 cookies: the refresh handle
	// never travels in JSON, so the cookie is the only way it can reach a client.
	names := map[string]bool{}
	for _, cookie := range w.Result().Cookies() {
		names[cookie.Name] = true
	}
	if !names[accessRefreshCookie] || !names[accessAssetCookie] {
		t.Fatalf("v2 password route cookies = %v", names)
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
	oldTokenValid := auth.jwtValidLocked(changedPayload.Token, time.Now(), accessJWTClockAllowance)
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

// testAccessSignedToken mints a bearer from the current record without a
// login, so a socket can be admitted before the record changes.
func testAccessSignedToken(t *testing.T, auth *accessAuthManager) string {
	t.Helper()
	auth.mu.Lock()
	defer auth.mu.Unlock()
	// Production mints identity through a v2 login; a test that only needs a
	// token pins the identity directly instead.
	if auth.record != nil && auth.v2.recordID == "" {
		recordID, err := randomAccessToken()
		if err != nil {
			t.Fatal(err)
		}
		auth.v2.recordID = recordID
		auth.v2.epoch = 1
	}
	if auth.record != nil && len(auth.v2.refreshKey) != accessRefreshKeyBytes {
		key, err := accessRefreshKey(auth.record)
		if err != nil {
			t.Fatal(err)
		}
		auth.v2.refreshKey = key
	}
	token, err := auth.mintAccessJWTLocked(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if token == "" {
		t.Fatal("manager minted no token")
	}
	return token
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
	if _, err := accessJWTKey(oldRecord); err != nil {
		t.Fatal(err)
	}
	// Mint through the manager so the token belongs to a live family of the
	// record that the rehash is about to replace.
	auth.mu.Lock()
	oldToken, err := auth.mintAccessJWTLocked(time.Now())
	auth.mu.Unlock()
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
	cookie := testAccessCookieFor(t, accessAuth)

	// A second live process is refused all authentication, so a simulated
	// restart must hand the state lock over before configuring.
	testAccessReleaseStateOwnership(accessAuth)
	restarted := newAccessAuthManager()
	if err := restarted.configure(loadConfig().AccessPasswordHash); err != nil {
		t.Fatal(err)
	}
	previous := accessAuth
	accessAuth = restarted
	t.Cleanup(func() { accessAuth = previous })

	// The v1 cookie is stateless and survives restart unchanged.
	request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.AddCookie(cookie)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("v1 cookie did not survive restart: %d", w.Code)
	}
	// A v2 token carries a record identity and family that only the durable
	// state file can reproduce, so it survives a restart with that file.
	request = httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Fatalf("restarted process rejected a durable v2 token: %d", w.Code)
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

// --- M4a: non-current record and rollback-format evidence ---

// testAccessV1Login runs the legacy one-time-proof login against the current
// manager and returns the response with the iteration count the status route
// advertised for it.
func testAccessV1Login(t *testing.T) (*httptest.ResponseRecorder, int) {
	t.Helper()
	enabled, saltB64, challenge, iterations, err := accessAuth.statusAndChallenge()
	if err != nil || !enabled {
		t.Fatalf("status challenge: enabled=%v err=%v", enabled, err)
	}
	salt, err := base64.RawURLEncoding.DecodeString(saltB64)
	if err != nil {
		t.Fatalf("decode salt: %v", err)
	}
	verifier, err := deriveAccessVerifier(testAccessPassword, salt, iterations)
	if err != nil {
		t.Fatalf("derive verifier at %d: %v", iterations, err)
	}
	body, err := json.Marshal(map[string]string{
		"challenge": challenge,
		"proof":     testAccessProof(t, verifier, challenge),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	return testAccessServe(handleAccessAuthLogin, request), iterations
}

// A non-current record keeps working over v1 at its stored work factor; the
// v2 login then rehashes it, and the unchanged password still signs in
// through v1 afterwards.
func TestAccessV1LoginSurvivesV2RehashOfStaleRecord(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)

	stale := testAccessStaleHash(t)
	if err := saveAccessPasswordHash(stale); err != nil {
		t.Fatal(err)
	}
	if err := auth.configure(stale); err != nil {
		t.Fatal(err)
	}

	first, advertised := testAccessV1Login(t)
	if first.Code != http.StatusOK {
		t.Fatalf("v1 login on a non-current record: %d %s", first.Code, first.Body.String())
	}
	if advertised != accessPasswordMinIterations {
		t.Fatalf("status advertised %d iterations, want the stored %d", advertised, accessPasswordMinIterations)
	}
	if len(first.Result().Cookies()) == 0 {
		t.Fatal("v1 login on a non-current record issued no session cookie")
	}

	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.71:1")
	if login.Code != http.StatusOK {
		t.Fatalf("v2 login against the non-current record: %d %s", login.Code, login.Body.String())
	}
	persisted, err := parseAccessPasswordHash(loadConfig().AccessPasswordHash)
	if err != nil || persisted == nil {
		t.Fatalf("parse rehashed record: %v", err)
	}
	if persisted.Iterations != accessPasswordHashIterations {
		t.Fatalf("rehash persisted %d iterations", persisted.Iterations)
	}

	second, advertised := testAccessV1Login(t)
	if second.Code != http.StatusOK {
		t.Fatalf("v1 login after the rehash: %d %s", second.Code, second.Body.String())
	}
	if advertised != accessPasswordHashIterations {
		t.Fatalf("status advertised %d iterations after the rehash", advertised)
	}
}

// legacyAccessRecordMatches mirrors the pre-transition parser (the binary a
// rollback would restore): five dot-separated parts, version v1, algorithm
// pbkdf2-sha256, exactly 600000 iterations, a 16-byte salt, and a 32-byte
// verifier. It is deliberately independent of parseAccessPasswordHash so a
// change to the new parser cannot make this rollback evidence pass by
// construction.
func legacyAccessRecordMatches(encoded string) bool {
	parts := strings.Split(encoded, ".")
	if len(parts) != 5 || parts[0] != "v1" || parts[1] != "pbkdf2-sha256" || parts[2] != "600000" {
		return false
	}
	salt, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(salt) != 16 {
		return false
	}
	verifier, err := base64.RawURLEncoding.DecodeString(parts[4])
	if err != nil || len(verifier) != 32 {
		return false
	}
	return true
}

func TestAccessRollbackRecordFormatStaysLegacyCompatible(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)

	current, err := newAccessPasswordRecord(testAccessPassword)
	if err != nil {
		t.Fatalf("create current record: %v", err)
	}
	if !legacyAccessRecordMatches(current.encoded()) {
		t.Fatalf("a current record is not rollback-compatible: %q", current.encoded())
	}

	stale := testAccessStaleHash(t)
	if err := saveAccessPasswordHash(stale); err != nil {
		t.Fatal(err)
	}
	if legacyAccessRecordMatches(stale) {
		t.Fatal("an unrehashed non-current record claims to be rollback-compatible")
	}
	if err := auth.configure(stale); err != nil {
		t.Fatal(err)
	}
	if login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.72:1"); login.Code != http.StatusOK {
		t.Fatalf("v2 login against the non-current record: %d %s", login.Code, login.Body.String())
	}
	rehashed := loadConfig().AccessPasswordHash
	if !legacyAccessRecordMatches(rehashed) {
		t.Fatalf("a rehashed record is not rollback-compatible: %q", rehashed)
	}
	record, err := parseAccessPasswordHash(rehashed)
	if err != nil || record == nil || record.Iterations != accessPasswordHashIterations {
		t.Fatalf("rehashed record: %#v err=%v", record, err)
	}
	if ok, err := record.matchesPassword(testAccessPassword); err != nil || !ok {
		t.Fatalf("rehashed record lost the password: ok=%v err=%v", ok, err)
	}
}

// --- M1b: v2 route contracts, CSRF, cookies, carriers, refresh machine ---

// testAccessStart is the fixed instant clocked tests start from, so a deadline
// assertion is an exact comparison instead of a race with the wall clock.
var testAccessStart = time.Unix(1700000000, 0).UTC()

// testAccessBundleKeys is the complete documented credential-bundle shape. A
// test compares the decoded key set against it, so an added or renamed field
// fails instead of passing silently.
var testAccessBundleKeys = []string{
	"expires_at",
	"expires_in",
	"refresh_absolute_expires_at",
	"refresh_idle_expires_at",
	"token",
}

type testAccessBundle struct {
	Token                    string `json:"token"`
	ExpiresAt                int64  `json:"expires_at"`
	ExpiresIn                int64  `json:"expires_in"`
	RefreshIdleExpiresAt     int64  `json:"refresh_idle_expires_at"`
	RefreshAbsoluteExpiresAt int64  `json:"refresh_absolute_expires_at"`
}

// testAccessDecodeBundle asserts the success shape once and returns it.
func testAccessDecodeBundle(t *testing.T, w *httptest.ResponseRecorder) testAccessBundle {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("bundle response: %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("bundle content type = %q want application/json", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("bundle cache control = %q want no-store", got)
	}
	var raw map[string]json.RawMessage
	testAccessJSONBody(t, w, &raw)
	if len(raw) != len(testAccessBundleKeys) {
		t.Fatalf("bundle keys = %v want %v", raw, testAccessBundleKeys)
	}
	for _, key := range testAccessBundleKeys {
		if _, ok := raw[key]; !ok {
			t.Fatalf("bundle is missing %q: %v", key, raw)
		}
	}
	var bundle testAccessBundle
	testAccessJSONBody(t, w, &bundle)
	if bundle.Token == "" || bundle.ExpiresAt == 0 || bundle.ExpiresIn <= 0 ||
		bundle.RefreshIdleExpiresAt == 0 || bundle.RefreshAbsoluteExpiresAt == 0 {
		t.Fatalf("bundle = %+v", bundle)
	}
	if bundle.RefreshAbsoluteExpiresAt < bundle.RefreshIdleExpiresAt {
		t.Fatalf("absolute deadline precedes idle: %+v", bundle)
	}
	return bundle
}

// testAccessResponseCookie returns one Set-Cookie from a response.
func testAccessResponseCookie(t *testing.T, w *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("response has no %q cookie", name)
	return nil
}

// testAccessRefreshHandle returns the refresh handle a response installed.
func testAccessRefreshHandle(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	handle := testAccessResponseCookie(t, w, accessRefreshCookie).Value
	if handle == "" {
		t.Fatal("refresh cookie is empty")
	}
	return handle
}

// testAccessV2RefreshRequest sends the refresh route's documented shape.
func testAccessV2RefreshRequest(t *testing.T, handle string) *httptest.ResponseRecorder {
	t.Helper()
	r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh", `{}`)
	if handle != "" {
		r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
	}
	r.RemoteAddr = "192.0.2.60:1"
	return testAccessServe(handleAccessV2Refresh, r)
}

// testAccessV2LogoutRequest sends {"all":<bool>} with an optional bearer.
func testAccessV2LogoutRequest(t *testing.T, body, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	r := testAccessV2Request(http.MethodPost, "/api/auth/v2/logout", body)
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	r.RemoteAddr = "192.0.2.61:1"
	return testAccessServe(handleAccessV2Logout, r)
}

// testAccessClock drives the manager clock, so a deadline can be tested at its
// exact instant without a sleep.
type testAccessClock struct {
	now time.Time
}

func (c *testAccessClock) advance(d time.Duration) { c.now = c.now.Add(d) }

func testAccessUseClock(t *testing.T, auth *accessAuthManager, start time.Time) *testAccessClock {
	t.Helper()
	clock := &testAccessClock{now: start}
	previous := auth.now
	auth.now = func() time.Time { return clock.now }
	t.Cleanup(func() { auth.now = previous })
	return clock
}

// testAccessErrorResponse asserts the shared error envelope: the exact fixed
// body, its status, no-store, and the plain-text content type.
func testAccessErrorResponse(t *testing.T, name string, w *httptest.ResponseRecorder, wantCode int, wantBody string) {
	t.Helper()
	if w.Code != wantCode {
		t.Errorf("%s: status = %d want %d (body %q)", name, w.Code, wantCode, w.Body.String())
	}
	if got := w.Body.String(); got != wantBody {
		t.Errorf("%s: body = %q want %q", name, got, wantBody)
	}
	if got := w.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Errorf("%s: content type = %q", name, got)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("%s: cache control = %q", name, got)
	}
	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("%s: error response set cookies: %v", name, cookies)
	}
}

func TestAccessV2RouteShapes(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)

	// Status: exactly the three documented booleans, with no credential or KDF
	// field, including while authentication is disabled.
	status := testAccessServe(handleAccessV2Status, httptest.NewRequest(http.MethodGet, "/api/auth/v2/status", nil))
	if status.Code != http.StatusOK {
		t.Fatalf("status: %d %s", status.Code, status.Body.String())
	}
	if got := status.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("status cache control = %q", got)
	}
	var raw map[string]json.RawMessage
	testAccessJSONBody(t, status, &raw)
	if len(raw) != 3 {
		t.Fatalf("status keys = %v want enabled/authenticated/owned", raw)
	}
	for _, key := range []string{"enabled", "authenticated", "owned"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("status is missing %q", key)
		}
	}
	for _, forbidden := range []string{"token", "salt", "challenge", "iterations", "version", "algorithm", "protocols"} {
		if _, ok := raw[forbidden]; ok {
			t.Errorf("status leaked %q", forbidden)
		}
	}

	// Enable through the public route: bundle fields plus the enabled flag, and
	// both v2 cookies.
	enableBody, err := json.Marshal(map[string]string{"password": testAccessPassword})
	if err != nil {
		t.Fatal(err)
	}
	enable := testAccessV2PasswordRequest(t, string(enableBody), "")
	if enable.Code != http.StatusOK {
		t.Fatalf("enable: %d %s", enable.Code, enable.Body.String())
	}
	var enabled map[string]json.RawMessage
	testAccessJSONBody(t, enable, &enabled)
	for _, key := range append([]string{"enabled"}, testAccessBundleKeys...) {
		if _, ok := enabled[key]; !ok {
			t.Errorf("enable response is missing %q: %v", key, enabled)
		}
	}
	if len(enabled) != len(testAccessBundleKeys)+1 {
		t.Errorf("enable response keys = %v", enabled)
	}
	enableHandle := testAccessRefreshHandle(t, enable)
	if got := testAccessResponseCookie(t, enable, accessAssetCookie).Value; got == "" {
		t.Error("enable installed an empty asset cookie")
	}

	// Login returns the bundle without the enabled flag, and a fresh family.
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.62:1")
	loginBundle := testAccessDecodeBundle(t, login)
	loginHandle := testAccessRefreshHandle(t, login)
	if loginHandle == enableHandle {
		t.Error("login reused the existing family's refresh handle")
	}

	// Refresh returns the same bundle shape and rotates the handle.
	refreshed := testAccessV2RefreshRequest(t, loginHandle)
	refreshBundle := testAccessDecodeBundle(t, refreshed)
	rotatedHandle := testAccessRefreshHandle(t, refreshed)
	if rotatedHandle == loginHandle {
		t.Error("refresh did not rotate the handle")
	}
	if refreshBundle.Token == loginBundle.Token {
		t.Error("refresh reissued the previous access token as a new rotation")
	}

	// Clear returns {"enabled":false} and deletes both cookies. Logout runs
	// after clear's own assertions, because it revokes this token's family.
	clear := testAccessV2PasswordRequest(t, `{"password":""}`, refreshBundle.Token)
	if clear.Code != http.StatusOK {
		t.Fatalf("clear: %d %s", clear.Code, clear.Body.String())
	}
	var clearPayload map[string]json.RawMessage
	testAccessJSONBody(t, clear, &clearPayload)
	if len(clearPayload) != 1 || string(clearPayload["enabled"]) != "false" {
		t.Fatalf("clear payload = %v", clearPayload)
	}
	for _, name := range []string{accessRefreshCookie, accessAssetCookie} {
		if cookie := testAccessResponseCookie(t, clear, name); cookie.MaxAge != -1 {
			t.Errorf("clear did not delete %s: %+v", name, cookie)
		}
	}

	// Logout with the (now cleared) family: authentication is disabled, so
	// only a live bearer worked before clear. Re-enable and use a fresh token.
	token := testAccessEnableV2(t, testAccessPassword)
	logout := testAccessV2LogoutRequest(t, `{"all":false}`, token)
	if logout.Code != http.StatusOK {
		t.Fatalf("logout: %d %s", logout.Code, logout.Body.String())
	}
	var logoutPayload map[string]json.RawMessage
	testAccessJSONBody(t, logout, &logoutPayload)
	if len(logoutPayload) != 1 {
		t.Fatalf("logout keys = %v", logoutPayload)
	}
	if string(logoutPayload["ok"]) != "true" {
		t.Fatalf("logout ok = %s", logoutPayload["ok"])
	}
	for _, name := range []string{accessRefreshCookie, accessAssetCookie} {
		cookie := testAccessResponseCookie(t, logout, name)
		if cookie.Value != "" || cookie.MaxAge != -1 {
			t.Errorf("logout %s deletion = %+v", name, cookie)
		}
	}
}

func TestAccessV2RouteErrors(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	handle := testAccessRefreshHandle(t,
		testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.63:1"))

	noHeader := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		return testAccessServe(handleAccessV2Login, r)
	}

	for _, tc := range []struct {
		name     string
		w        *httptest.ResponseRecorder
		wantCode int
		wantBody string
	}{
		{"login wrong password", testAccessV2LoginRequest(t, "test-pass-0000", "192.0.2.64:1"), http.StatusUnauthorized, "Invalid password\n"},
		{"login empty body", testAccessV2LoginBody(t, ``, "192.0.2.65:1"), http.StatusBadRequest, "Invalid login request\n"},
		{"login missing custom header", noHeader(http.MethodPost, "/api/auth/v2/login", `{"password":"`+testAccessPassword+`"}`), http.StatusForbidden, "forbidden\n"},
		{"password without bearer", testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, ""), http.StatusUnauthorized, "access authentication required\n"},
		{"password invalid body", testAccessV2PasswordRequest(t, `[]`, token), http.StatusBadRequest, "Invalid password configuration\n"},
		{"refresh empty body", func() *httptest.ResponseRecorder {
			r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh", ``)
			r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
			return testAccessServe(handleAccessV2Refresh, r)
		}(), http.StatusBadRequest, "Invalid refresh request\n"},
		{"refresh non-empty body", func() *httptest.ResponseRecorder {
			r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh", `{"all":true}`)
			r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
			return testAccessServe(handleAccessV2Refresh, r)
		}(), http.StatusBadRequest, "Invalid refresh request\n"},
		{"refresh without cookie", testAccessV2RefreshRequest(t, ""), http.StatusUnauthorized, "access authentication required\n"},
		{"refresh with duplicate cookies", func() *httptest.ResponseRecorder {
			r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh", `{}`)
			r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
			r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
			return testAccessServe(handleAccessV2Refresh, r)
		}(), http.StatusUnauthorized, "access authentication required\n"},
		{"refresh with bearer", func() *httptest.ResponseRecorder {
			r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh", `{}`)
			r.Header.Set("Authorization", "Bearer "+token)
			r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
			return testAccessServe(handleAccessV2Refresh, r)
		}(), http.StatusUnauthorized, "access authentication required\n"},
		{"refresh with token query", func() *httptest.ResponseRecorder {
			r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh?token="+token, `{}`)
			r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
			return testAccessServe(handleAccessV2Refresh, r)
		}(), http.StatusUnauthorized, "access authentication required\n"},
		{"refresh unknown handle", testAccessV2RefreshRequest(t, "bm90LWEtcmVmcmVzaC1oYW5kbGUtdmFsdWUtdGhhdC1pcy0zMmI"), http.StatusUnauthorized, "access authentication required\n"},
		{"logout without bearer", testAccessV2LogoutRequest(t, `{"all":false}`, ""), http.StatusUnauthorized, "access authentication required\n"},
		{"logout invalid bearer", testAccessV2LogoutRequest(t, `{"all":false}`, "not-a-token"), http.StatusUnauthorized, "access authentication required\n"},
		{"logout missing all", testAccessV2LogoutRequest(t, `{}`, token), http.StatusBadRequest, "Invalid logout request\n"},
		{"logout non-bool all", testAccessV2LogoutRequest(t, `{"all":"yes"}`, token), http.StatusBadRequest, "Invalid logout request\n"},
		{"logout null all", testAccessV2LogoutRequest(t, `{"all":null}`, token), http.StatusBadRequest, "Invalid logout request\n"},
		{"logout trailing value", testAccessV2LogoutRequest(t, `{"all":true}{}`, token), http.StatusBadRequest, "Invalid logout request\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			testAccessErrorResponse(t, tc.name, tc.w, tc.wantCode, tc.wantBody)
		})
	}

	// A cookie never authorizes logout, even a valid refresh cookie.
	cookieOnly := testAccessV2Request(http.MethodPost, "/api/auth/v2/logout", `{"all":false}`)
	cookieOnly.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
	testAccessErrorResponse(t, "logout with refresh cookie only",
		testAccessServe(handleAccessV2Logout, cookieOnly), http.StatusUnauthorized, "access authentication required\n")

	// Wrong methods answer 405 with the Allow header the contract names.
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
		path    string
		allow   string
	}{
		{"status", handleAccessV2Status, "/api/auth/v2/status", http.MethodGet},
		{"login", handleAccessV2Login, "/api/auth/v2/login", http.MethodPost},
		{"password", handleAccessV2Password, "/api/auth/v2/password", http.MethodPost},
		{"refresh", handleAccessV2Refresh, "/api/auth/v2/refresh", http.MethodPost},
		{"logout", handleAccessV2Logout, "/api/auth/v2/logout", http.MethodPost},
	} {
		t.Run(tc.name+" method", func(t *testing.T) {
			method := http.MethodPost
			if tc.allow == http.MethodPost {
				method = http.MethodGet
			}
			w := testAccessServe(tc.handler, httptest.NewRequest(method, tc.path, nil))
			if got := w.Header().Get("Allow"); got != tc.allow {
				t.Errorf("Allow = %q want %q", got, tc.allow)
			}
			testAccessErrorResponse(t, tc.name+" method", w, http.StatusMethodNotAllowed, "Method not allowed\n")
		})
	}
}

// TestAccessV2ClearWhileDisabled covers the one documented error that needs a
// server with no password: clearing cannot enable anything.
func TestAccessV2ClearWhileDisabled(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessErrorResponse(t, "clear while disabled",
		testAccessV2PasswordRequest(t, `{"password":""}`, ""), http.StatusBadRequest, "Access password is not enabled\n")
}

func TestAccessV2BodyBounds(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)

	// Login and password keep the 8192-byte limit; refresh and logout use 1024.
	oversized := `{"password":"` + strings.Repeat("a", accessPasswordBodyLimit) + `"}`
	if got := len(oversized); got <= accessPasswordBodyLimit {
		t.Fatalf("oversized body is only %d bytes", got)
	}
	if w := testAccessV2LoginBody(t, oversized, "192.0.2.66:1"); w.Code != http.StatusBadRequest {
		t.Errorf("oversized login body: %d", w.Code)
	}
	if w := testAccessV2PasswordRequest(t, oversized, token); w.Code != http.StatusBadRequest {
		t.Errorf("oversized password body: %d", w.Code)
	}

	// The refresh/logout limit counts whitespace, so padding alone is refused.
	padded := strings.Repeat(" ", accessRefreshBodyLimit) + `{}`
	for name, handler := range map[string]http.HandlerFunc{
		"refresh": handleAccessV2Refresh,
		"logout":  handleAccessV2Logout,
	} {
		path := "/api/auth/v2/" + name
		r := testAccessV2Request(http.MethodPost, path, padded)
		r.Header.Set("Authorization", "Bearer "+token)
		r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: "handle"})
		if w := testAccessServe(handler, r); w.Code != http.StatusBadRequest {
			t.Errorf("%s padded body: got %d want 400", name, w.Code)
		}
	}

	// The password bound is measured in UTF-8 bytes, not characters.
	threeByte := strings.Repeat("\u4e16", accessPasswordMaxBytes/3)
	if w := testAccessV2PasswordRequest(t, `{"password":"`+threeByte+`"}`, token); w.Code != http.StatusOK {
		t.Errorf("%d-byte multibyte password: got %d body=%s", len(threeByte), w.Code, w.Body.String())
	}
	tooLong := threeByte + "\u4e16"
	if w := testAccessV2PasswordRequest(t, `{"password":"`+tooLong+`"}`, token); w.Code != http.StatusBadRequest {
		t.Errorf("%d-byte multibyte password: got %d want 400", len(tooLong), w.Code)
	}

	// Exactly-empty and single-pair shapes that must not sneak through.
	for name, body := range map[string]string{
		"refresh null":     `null`,
		"refresh array":    `[]`,
		"refresh string":   `"{}"`,
		"logout array":     `[false]`,
		"logout duplicate": `{"all":false,"all":false}`,
	} {
		w := testAccessV2RefreshRequest(t, "")
		if strings.HasPrefix(name, "logout") {
			w = testAccessV2LogoutRequest(t, body, token)
		} else {
			r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh", body)
			r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: "handle"})
			w = testAccessServe(handleAccessV2Refresh, r)
		}
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d want 400 (body %q)", name, w.Code, w.Body.String())
		}
	}
}

// testAccessSetOrigins writes auth_origins into the temporary config, which is
// how an operator allows a TLS-terminating proxy's external origin.
func testAccessSetOrigins(t *testing.T, origins ...string) {
	t.Helper()
	cfg := loadConfig()
	cfg.AuthOrigins = origins
	saveConfig(cfg)
	if got := loadConfig().AuthOrigins; len(got) != len(origins) {
		t.Fatalf("auth_origins = %v want %v", got, origins)
	}
}

// testAccessV2LoginWith builds the login route's request and lets one case
// adjust its headers. Every case starts from the native-caller baseline: custom
// header, JSON, no Origin.
func testAccessV2LoginWith(t *testing.T, password string, remoteAddr string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/auth/v2/login", strings.NewReader(string(body)))
	r.Header.Set(accessV2Header, accessV2HeaderValue)
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = remoteAddr
	if mutate != nil {
		mutate(r)
	}
	return testAccessServe(handleAccessV2Login, r)
}

func TestAccessV2CSRFHeaderAndContentType(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	nextIP := 0
	fresh := func() string {
		nextIP++
		return "198.51.100." + strconv.Itoa(nextIP) + ":1"
	}

	for _, tc := range []struct {
		name     string
		mutate   func(*http.Request)
		wantCode int
	}{
		{"absent custom header", func(r *http.Request) { r.Header.Del(accessV2Header) }, http.StatusForbidden},
		{"wrong custom header value", func(r *http.Request) { r.Header.Set(accessV2Header, "v1") }, http.StatusForbidden},
		{"empty custom header", func(r *http.Request) { r.Header.Set(accessV2Header, "") }, http.StatusForbidden},
		{"duplicate custom header", func(r *http.Request) {
			r.Header.Add(accessV2Header, accessV2HeaderValue)
			r.Header.Add(accessV2Header, accessV2HeaderValue)
		}, http.StatusForbidden},
		{"charset parameter", func(r *http.Request) {
			r.Header.Set("Content-Type", "application/json; charset=utf-8")
		}, http.StatusOK},
		{"charset without space", func(r *http.Request) {
			r.Header.Set("Content-Type", "application/json;charset=UTF-8")
		}, http.StatusOK},
		{"form content type", func(r *http.Request) {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}, http.StatusBadRequest},
		{"plain text content type", func(r *http.Request) {
			r.Header.Set("Content-Type", "text/plain")
		}, http.StatusBadRequest},
		{"absent content type", func(r *http.Request) { r.Header.Del("Content-Type") }, http.StatusBadRequest},
		{"duplicate content type", func(r *http.Request) {
			r.Header.Add("Content-Type", "application/json")
		}, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := testAccessV2LoginWith(t, testAccessPassword, fresh(), tc.mutate)
			if w.Code != tc.wantCode {
				t.Fatalf("got %d want %d (body %q)", w.Code, tc.wantCode, w.Body.String())
			}
		})
	}

	// The same gate guards all four POST routes: a missing custom header is a
	// 403 even when the body and credentials are otherwise valid. The password
	// is already enabled above, so log in for a bearer instead of re-enabling.
	login := testAccessV2LoginRequest(t, testAccessPassword, "198.51.100.250:1")
	var token string
	{
		var payload struct {
			Token string `json:"token"`
		}
		testAccessJSONBody(t, login, &payload)
		token = payload.Token
	}
	if login.Code != http.StatusOK || token == "" {
		t.Fatalf("login for the CSRF gate cases: %d %s", login.Code, login.Body.String())
	}
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
		path    string
		body    string
		cookie  bool
	}{
		{"login", handleAccessV2Login, "/api/auth/v2/login", `{"password":"` + testAccessPassword + `"}`, false},
		{"password", handleAccessV2Password, "/api/auth/v2/password", `{"password":"test-pass-5678"}`, false},
		{"refresh", handleAccessV2Refresh, "/api/auth/v2/refresh", `{}`, true},
		{"logout", handleAccessV2Logout, "/api/auth/v2/logout", `{"all":false}`, false},
	} {
		t.Run(tc.name+" without custom header", func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+token)
			if tc.cookie {
				r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: "handle"})
			}
			testAccessErrorResponse(t, tc.name, testAccessServe(tc.handler, r), http.StatusForbidden, "forbidden\n")
		})
	}
}

func TestAccessV2OriginAndFetchMetadata(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	testAccessSetOrigins(t, "https://phi.example", "https://proxy.example:443")

	nextIP := 0
	fresh := func() string {
		nextIP++
		return "203.0.113." + strconv.Itoa(nextIP) + ":1"
	}
	// httptest sets Host example.com and no TLS state, so the request's own
	// origin is http://example.com.
	const self = "http://example.com"

	for _, tc := range []struct {
		name     string
		mutate   func(*http.Request)
		wantCode int
	}{
		{"no browser headers", nil, http.StatusOK},
		{"own origin", func(r *http.Request) { r.Header.Set("Origin", self) }, http.StatusOK},
		{"own origin default port", func(r *http.Request) { r.Header.Set("Origin", self+":80") }, http.StatusOK},
		{"own origin uppercase host", func(r *http.Request) { r.Header.Set("Origin", "http://EXAMPLE.com") }, http.StatusOK},
		{"configured extra origin", func(r *http.Request) { r.Header.Set("Origin", "https://phi.example") }, http.StatusOK},
		{"configured default port", func(r *http.Request) { r.Header.Set("Origin", "https://proxy.example") }, http.StatusOK},
		{"scheme mismatch", func(r *http.Request) { r.Header.Set("Origin", "https://example.com") }, http.StatusForbidden},
		{"port mismatch", func(r *http.Request) { r.Header.Set("Origin", self+":8080") }, http.StatusForbidden},
		{"unconfigured origin", func(r *http.Request) { r.Header.Set("Origin", "https://other.example") }, http.StatusForbidden},
		{"opaque origin", func(r *http.Request) { r.Header.Set("Origin", "null") }, http.StatusForbidden},
		{"empty origin", func(r *http.Request) { r.Header.Set("Origin", "") }, http.StatusForbidden},
		{"origin with userinfo", func(r *http.Request) { r.Header.Set("Origin", "http://user:pw@example.com") }, http.StatusForbidden},
		{"origin with path", func(r *http.Request) { r.Header.Set("Origin", self+"/path") }, http.StatusForbidden},
		{"origin with query", func(r *http.Request) { r.Header.Set("Origin", self+"?q=1") }, http.StatusForbidden},
		{"origin with fragment", func(r *http.Request) { r.Header.Set("Origin", self+"#f") }, http.StatusForbidden},
		{"origin wildcard", func(r *http.Request) { r.Header.Set("Origin", "http://*.example.com") }, http.StatusForbidden},
		{"origin without scheme", func(r *http.Request) { r.Header.Set("Origin", "example.com") }, http.StatusForbidden},
		{"non-http origin", func(r *http.Request) { r.Header.Set("Origin", "ftp://example.com") }, http.StatusForbidden},
		{"malformed origin", func(r *http.Request) { r.Header.Set("Origin", "http://") }, http.StatusForbidden},
		{"duplicate origin", func(r *http.Request) {
			r.Header.Add("Origin", self)
			r.Header.Add("Origin", self)
		}, http.StatusForbidden},
		{"fetch metadata same-origin", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-origin") }, http.StatusOK},
		{"fetch metadata none", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "none") }, http.StatusOK},
		{"fetch metadata same-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") }, http.StatusForbidden},
		{"fetch metadata cross-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, http.StatusForbidden},
		{"fetch metadata unknown value", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "sideways") }, http.StatusForbidden},
		{"duplicate fetch metadata", func(r *http.Request) {
			r.Header.Add("Sec-Fetch-Site", "same-origin")
			r.Header.Add("Sec-Fetch-Site", "same-origin")
		}, http.StatusForbidden},
		{"good origin with bad fetch metadata", func(r *http.Request) {
			r.Header.Set("Origin", self)
			r.Header.Set("Sec-Fetch-Site", "cross-site")
		}, http.StatusForbidden},
		{"good fetch metadata with bad origin", func(r *http.Request) {
			r.Header.Set("Origin", "https://other.example")
			r.Header.Set("Sec-Fetch-Site", "same-origin")
		}, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := testAccessV2LoginWith(t, testAccessPassword, fresh(), tc.mutate)
			if w.Code != tc.wantCode {
				t.Fatalf("got %d want %d (body %q)", w.Code, tc.wantCode, w.Body.String())
			}
			if tc.wantCode == http.StatusForbidden {
				if got := w.Body.String(); got != "forbidden\n" {
					t.Fatalf("forbidden body = %q", got)
				}
			}
		})
	}
}

// TestAccessV2OriginTLSAndIPv6 covers the request shapes a proxy and a tailnet
// actually produce: a TLS connection of its own, and an IPv6 host with a port.
func TestAccessV2OriginTLSAndIPv6(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	nextIP := 0
	fresh := func() string {
		nextIP++
		return "198.18.0." + strconv.Itoa(nextIP) + ":1"
	}

	tlsRequest := func(r *http.Request) { r.TLS = &tls.ConnectionState{} }

	if w := testAccessV2LoginWith(t, testAccessPassword, fresh(), func(r *http.Request) {
		tlsRequest(r)
		r.Header.Set("Origin", "https://example.com")
	}); w.Code != http.StatusOK {
		t.Fatalf("tls own origin: %d %s", w.Code, w.Body.String())
	}
	if w := testAccessV2LoginWith(t, testAccessPassword, fresh(), func(r *http.Request) {
		tlsRequest(r)
		r.Header.Set("Origin", "http://example.com")
	}); w.Code != http.StatusForbidden {
		t.Fatalf("tls request accepted a plain-http origin: %d", w.Code)
	}
	if w := testAccessV2LoginWith(t, testAccessPassword, fresh(), func(r *http.Request) {
		r.Host = "[::1]:7070"
		r.Header.Set("Origin", "http://[::1]:7070")
	}); w.Code != http.StatusOK {
		t.Fatalf("ipv6 own origin: %d %s", w.Code, w.Body.String())
	}
	if w := testAccessV2LoginWith(t, testAccessPassword, fresh(), func(r *http.Request) {
		r.Host = "[::1]:7070"
		r.Header.Set("Origin", "http://[::1]:7071")
	}); w.Code != http.StatusForbidden {
		t.Fatalf("ipv6 port mismatch was accepted: %d", w.Code)
	}
}

// TestAccessV2MalformedConfiguredOrigin pins that a bad auth_origins entry is a
// startup error and refuses browser requests instead of silently not matching.
func TestAccessV2MalformedConfiguredOrigin(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	for _, entry := range []string{
		"https://phi.example/",
		"https://phi.example/path",
		"phi.example",
		"https://*.phi.example",
		"https://phi.example?x=1",
	} {
		t.Run(entry, func(t *testing.T) {
			testAccessSetOrigins(t, entry)
			if err := accessAuth.validateOrigins(); err == nil {
				t.Fatalf("validateOrigins accepted %q", entry)
			}
			w := testAccessV2LoginWith(t, testAccessPassword, "198.18.1.1:1", func(r *http.Request) {
				r.Header.Set("Origin", "http://example.com")
			})
			if w.Code != http.StatusForbidden {
				t.Fatalf("request with a malformed auth_origins: got %d want 403", w.Code)
			}
		})
	}

	// A well-formed list validates, and duplicate entries collapse.
	testAccessSetOrigins(t, "https://phi.example", "https://phi.example:443", "http://127.0.0.1:7070")
	if err := accessAuth.validateOrigins(); err != nil {
		t.Fatalf("validateOrigins rejected a valid list: %v", err)
	}
	origins, err := accessConfiguredOrigins()
	if err != nil {
		t.Fatal(err)
	}
	if len(origins) != 2 {
		t.Fatalf("canonical origins = %v want two entries", origins)
	}
}

// TestAccessV2CookieSecureDerivation covers the Secure rule: it follows the
// validated origin and the transport, never r.Host.
func TestAccessV2CookieSecureDerivation(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	nextIP := 0
	fresh := func() string {
		nextIP++
		return "192.0.2." + strconv.Itoa(100+nextIP) + ":1"
	}

	for _, tc := range []struct {
		name       string
		origins    []string
		mutate     func(*http.Request)
		wantSecure bool
	}{
		{"plain native caller", nil, nil, false},
		{"tls native caller", nil, func(r *http.Request) { r.TLS = &tls.ConnectionState{} }, true},
		{"plain caller with configured https origin", []string{"https://phi.example"}, nil, true},
		{"plain caller presenting a configured https origin", []string{"https://phi.example"}, func(r *http.Request) {
			r.Header.Set("Origin", "https://phi.example")
		}, true},
		{"plain caller presenting its own http origin", nil, func(r *http.Request) {
			r.Header.Set("Origin", "http://example.com")
		}, false},
		{"tls caller presenting its own https origin", nil, func(r *http.Request) {
			r.TLS = &tls.ConnectionState{}
			r.Header.Set("Origin", "https://example.com")
		}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			testAccessSetOrigins(t, tc.origins...)
			w := testAccessV2LoginWith(t, testAccessPassword, fresh(), tc.mutate)
			if w.Code != http.StatusOK {
				t.Fatalf("login: %d %s", w.Code, w.Body.String())
			}
			for _, name := range []string{accessRefreshCookie, accessAssetCookie} {
				if cookie := testAccessResponseCookie(t, w, name); cookie.Secure != tc.wantSecure {
					t.Errorf("%s Secure = %v want %v", name, cookie.Secure, tc.wantSecure)
				}
			}
		})
	}
}

// testAccessDecodeHandle asserts the refresh handle is one canonical unpadded
// 32-byte base64url value: opaque, unguessable length, and never padded.
func testAccessDecodeHandle(t *testing.T, handle string) {
	t.Helper()
	if strings.ContainsAny(handle, "=+/") {
		t.Errorf("handle is not canonical base64url: %q", handle)
	}
	raw, err := base64.RawURLEncoding.DecodeString(handle)
	if err != nil || len(raw) != accessRefreshHandleBytes {
		t.Errorf("handle decodes to %d bytes (err %v) want %d", len(raw), err, accessRefreshHandleBytes)
	}
}

func TestAccessV2CookieAttributes(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.120:1")
	bundle := testAccessDecodeBundle(t, login)

	refresh := testAccessResponseCookie(t, login, accessRefreshCookie)
	if refresh.Path != accessRefreshCookiePath {
		t.Errorf("refresh Path = %q want %q", refresh.Path, accessRefreshCookiePath)
	}
	if !refresh.HttpOnly || refresh.SameSite != http.SameSiteStrictMode {
		t.Errorf("refresh flags = %+v", refresh)
	}
	if refresh.Domain != "" {
		t.Errorf("refresh cookie is not host-only: Domain=%q", refresh.Domain)
	}
	if refresh.Expires.Unix() != bundle.RefreshIdleExpiresAt {
		t.Errorf("refresh Expires = %d want %d", refresh.Expires.Unix(), bundle.RefreshIdleExpiresAt)
	}
	if want := bundle.RefreshIdleExpiresAt - time.Now().Unix(); refresh.MaxAge > int(want) || refresh.MaxAge < int(want)-60 {
		t.Errorf("refresh MaxAge = %d want about %d", refresh.MaxAge, want)
	}
	testAccessDecodeHandle(t, refresh.Value)

	asset := testAccessResponseCookie(t, login, accessAssetCookie)
	if asset.Path != accessAssetCookiePath {
		t.Errorf("asset Path = %q want %q", asset.Path, accessAssetCookiePath)
	}
	if !asset.HttpOnly || asset.SameSite != http.SameSiteStrictMode || asset.Domain != "" {
		t.Errorf("asset cookie flags = %+v", asset)
	}
	if asset.Expires.Unix() != bundle.ExpiresAt {
		t.Errorf("asset Expires = %d want %d", asset.Expires.Unix(), bundle.ExpiresAt)
	}
	// The asset cookie carries the access token itself and no 30-second
	// extension, so its deadline is the admitted `exp`.
	if asset.Value != bundle.Token {
		t.Error("asset cookie is not the access token")
	}
	if bundle.ExpiresAt-bundle.RefreshIdleExpiresAt >= 0 {
		t.Errorf("idle deadline is not later than the access deadline: %+v", bundle)
	}
	if want := bundle.ExpiresAt - time.Now().Unix(); asset.MaxAge > int(want) || asset.MaxAge < int(want)-60 {
		t.Errorf("asset MaxAge = %d want about %d", asset.MaxAge, want)
	}
}

func TestAccessV2CookieDeletionAttributes(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)

	// Clear first: logout revokes the bearer's family, so the same token could
	// not authorize both.
	clear := testAccessV2PasswordRequest(t, `{"password":""}`, testAccessEnableV2(t, testAccessPassword))
	logout := testAccessV2LogoutRequest(t, `{"all":false}`, testAccessEnableV2(t, testAccessPassword))

	deletions := []struct {
		name string
		w    *httptest.ResponseRecorder
	}{
		{"clear", clear},
		{"logout", logout},
	}
	for _, deletion := range deletions {
		name, w := deletion.name, deletion.w
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", name, w.Code, w.Body.String())
		}
		for _, want := range []struct {
			name string
			path string
		}{
			{accessRefreshCookie, accessRefreshCookiePath},
			{accessAssetCookie, accessAssetCookiePath},
		} {
			cookie := testAccessResponseCookie(t, w, want.name)
			if cookie.Path != want.path {
				t.Errorf("%s %s Path = %q want %q", name, want.name, cookie.Path, want.path)
			}
			if cookie.Value != "" || cookie.MaxAge != -1 {
				t.Errorf("%s %s deletion = %+v", name, want.name, cookie)
			}
			if !cookie.Expires.Before(time.Now()) {
				t.Errorf("%s %s Expires = %v want a past time", name, want.name, cookie.Expires)
			}
			if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Domain != "" {
				t.Errorf("%s %s deletion attributes = %+v", name, want.name, cookie)
			}
		}
	}
}

// TestAccessV2PersistedThenAnnounced pins that a failed state write produces no
// replacement cookies: the handler reports 500 before any cookie is set.
func TestAccessV2PersistedThenAnnounced(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	handle := testAccessRefreshHandle(t,
		func() *httptest.ResponseRecorder {
			testAccessEnableV2(t, testAccessPassword)
			return testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.121:1")
		}())

	previous := writeAccessV2StateFile
	writeAccessV2StateFile = func(string, []byte, os.FileMode) error { return errors.New("disk full") }
	t.Cleanup(func() { writeAccessV2StateFile = previous })

	refresh := testAccessV2RefreshRequest(t, handle)
	testAccessErrorResponse(t, "refresh persistence failure", refresh, http.StatusInternalServerError, "Unable to refresh access session\n")

	writeAccessV2StateFile = previous
	// The handle is still the active one: nothing was consumed by the failure.
	if w := testAccessV2RefreshRequest(t, handle); w.Code != http.StatusOK {
		t.Fatalf("handle stopped working after a failed write: %d %s", w.Code, w.Body.String())
	}
}

func TestAccessV2GraceReissuesOriginalDeadlines(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)

	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.122:1")
	loginBundle := testAccessDecodeBundle(t, login)
	handle := testAccessRefreshHandle(t, login)

	rotated := testAccessV2RefreshRequest(t, handle)
	rotatedBundle := testAccessDecodeBundle(t, rotated)
	if rotatedBundle.Token == loginBundle.Token {
		t.Fatal("rotation reused the access token")
	}

	// The client lost the response, so it retries the consumed handle inside the
	// grace window. It must get the same token, handle, and deadlines back.
	clock.advance(30 * time.Second)
	replay := testAccessV2RefreshRequest(t, handle)
	replayBundle := testAccessDecodeBundle(t, replay)
	if replayBundle.Token != rotatedBundle.Token {
		t.Error("grace replay minted a different access token")
	}
	if replayBundle.ExpiresAt != rotatedBundle.ExpiresAt {
		t.Error("grace replay moved the access deadline")
	}
	if replayBundle.RefreshIdleExpiresAt != rotatedBundle.RefreshIdleExpiresAt ||
		replayBundle.RefreshAbsoluteExpiresAt != rotatedBundle.RefreshAbsoluteExpiresAt {
		t.Error("grace replay extended a refresh deadline")
	}
	if replayBundle.ExpiresIn != rotatedBundle.ExpiresIn-30 {
		t.Errorf("grace expires_in = %d want %d", replayBundle.ExpiresIn, rotatedBundle.ExpiresIn-30)
	}
	if replayHandle := testAccessRefreshHandle(t, replay); replayHandle != testAccessRefreshHandle(t, rotated) {
		t.Error("grace replay rotated the handle again")
	}
	if got := testAccessResponseCookie(t, replay, accessAssetCookie); got.Expires.Unix() != rotatedBundle.ExpiresAt {
		t.Errorf("grace asset cookie Expires = %d want %d", got.Expires.Unix(), rotatedBundle.ExpiresAt)
	}
	if got := testAccessResponseCookie(t, replay, accessRefreshCookie); got.Expires.Unix() != rotatedBundle.RefreshIdleExpiresAt {
		t.Errorf("grace refresh cookie Expires = %d want %d", got.Expires.Unix(), rotatedBundle.RefreshIdleExpiresAt)
	}
}

func TestAccessV2AssetCookieScope(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.123:1")
	bundle := testAccessDecodeBundle(t, login)
	asset := &http.Cookie{Name: accessAssetCookie, Value: bundle.Token}
	v1 := auth.mustTestCookie(t)
	protected := testAccessProtected()

	serve := func(method, path string, cookies ...*http.Cookie) int {
		r := httptest.NewRequest(method, path, nil)
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		return testAccessServe(protected.ServeHTTP, r).Code
	}

	if code := serve(http.MethodGet, accessAssetFilePath, asset); code != http.StatusNoContent {
		t.Errorf("asset cookie on GET file/asset: %d", code)
	}
	if code := serve(http.MethodHead, accessAssetMarkdownPath, asset); code != http.StatusNoContent {
		t.Errorf("asset cookie on HEAD markdown/asset: %d", code)
	}
	// Outside the exact allowlist the cookie is ignored, so an API read needs
	// a real credential.
	if code := serve(http.MethodGet, "/api/coders", asset); code != http.StatusUnauthorized {
		t.Errorf("asset cookie authorized an API read: %d", code)
	}
	// Only GET and HEAD are eligible.
	if code := serve(http.MethodPost, accessAssetFilePath, asset); code != http.StatusUnauthorized {
		t.Errorf("asset cookie authorized a mutation: %d", code)
	}
	// An invalid asset cookie on an allowed read is a 401, never a v1 fallback.
	if code := serve(http.MethodGet, accessAssetFilePath,
		&http.Cookie{Name: accessAssetCookie, Value: "not-a-token"}, v1); code != http.StatusUnauthorized {
		t.Errorf("invalid asset cookie fell back to the v1 cookie: %d", code)
	}
	// A duplicated asset cookie fails closed.
	if code := serve(http.MethodGet, accessAssetFilePath, asset, asset); code != http.StatusUnauthorized {
		t.Errorf("duplicate asset cookies were accepted: %d", code)
	}
	// The approved v1 fallback still works on the allowed read.
	if code := serve(http.MethodGet, accessAssetFilePath, v1); code != http.StatusNoContent {
		t.Errorf("v1 cookie on an asset read: %d", code)
	}
	// A valid bearer wins on the allowed read.
	r := httptest.NewRequest(http.MethodGet, accessAssetFilePath, nil)
	r.Header.Set("Authorization", "Bearer "+bundle.Token)
	r.AddCookie(&http.Cookie{Name: accessAssetCookie, Value: "not-a-token"})
	if code := testAccessServe(protected.ServeHTTP, r).Code; code != http.StatusNoContent {
		t.Errorf("bearer did not outrank an invalid asset cookie: %d", code)
	}

	// Past exp the asset cookie stops authorizing, with the browser allowance
	// being the documented thirty seconds and nothing more.
	clock := testAccessUseClock(t, auth, time.Unix(bundle.ExpiresAt, 0))
	if code := serve(http.MethodGet, accessAssetFilePath, asset); code != http.StatusNoContent {
		t.Errorf("asset cookie at exp: %d", code)
	}
	clock.advance(accessJWTClockAllowance)
	if code := serve(http.MethodGet, accessAssetFilePath, asset); code != http.StatusUnauthorized {
		t.Errorf("asset cookie at exp+allowance: %d", code)
	}
}

func TestAccessV2RefreshCookieAuthorizesNothing(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	handle := testAccessRefreshHandle(t,
		testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.124:1"))
	refresh := &http.Cookie{Name: accessRefreshCookie, Value: handle}

	protected := testAccessProtected()
	for _, path := range []string{"/api/coders", accessAssetFilePath, accessAssetMarkdownPath, "/ws/pane/p1"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.AddCookie(refresh)
		if code := testAccessServe(protected.ServeHTTP, r).Code; code != http.StatusUnauthorized {
			t.Errorf("refresh cookie authorized %s: %d", path, code)
		}
	}

	// The status route reports cookie authentication as false, and the password
	// route does not accept the refresh cookie as a bearer either.
	r := httptest.NewRequest(http.MethodGet, "/api/auth/v2/status", nil)
	r.AddCookie(refresh)
	var payload struct {
		Authenticated bool `json:"authenticated"`
	}
	testAccessJSONBody(t, testAccessServe(handleAccessV2Status, r), &payload)
	if payload.Authenticated {
		t.Error("v2 status authenticated a refresh cookie")
	}
	password := testAccessV2Request(http.MethodPost, "/api/auth/v2/password", `{"password":"test-pass-5678"}`)
	password.AddCookie(refresh)
	if code := testAccessServe(handleAccessV2Password, password).Code; code != http.StatusUnauthorized {
		t.Errorf("password route accepted a refresh cookie: %d", code)
	}
}

func TestAccessRevokedJWTWithValidV1Cookie(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	v1 := auth.mustTestCookie(t)
	protected := testAccessProtected()

	if w := testAccessV2LogoutRequest(t, `{"all":true}`, token); w.Code != http.StatusOK {
		t.Fatalf("logout all: %d %s", w.Code, w.Body.String())
	}

	// A stolen revoked bearer decides alone: the valid v1 cookie must not
	// rescue it.
	r := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.AddCookie(v1)
	if w := testAccessServe(protected.ServeHTTP, r); w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked bearer fell back to the v1 cookie: %d", w.Code)
	}

	// v1 keeps working on its own: logout-all has no v1 epoch.
	r = httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	r.AddCookie(v1)
	if w := testAccessServe(protected.ServeHTTP, r); w.Code != http.StatusNoContent {
		t.Fatalf("logout-all invalidated the v1 cookie: %d", w.Code)
	}
}

// testAccessStateFile reads the durable state the manager just wrote.
func testAccessStateFile(t *testing.T) *accessV2StateFile {
	t.Helper()
	state, err := loadAccessV2StateFile(accessV2StatePath())
	if err != nil || state == nil {
		t.Fatalf("load state file: state=%v err=%v", state, err)
	}
	return state
}

func TestAccessV2RefreshRotation(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)

	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.130:1")
	loginHandle := testAccessRefreshHandle(t, login)

	firstResponse := testAccessV2RefreshRequest(t, loginHandle)
	first := testAccessDecodeBundle(t, firstResponse)
	firstHandle := testAccessRefreshHandle(t, firstResponse)
	if firstHandle == loginHandle {
		t.Fatal("the first rotation did not change the handle")
	}

	clock.advance(time.Minute)
	second := testAccessDecodeBundle(t, testAccessV2RefreshRequest(t, firstHandle))

	if first.Token == second.Token {
		t.Error("rotations reused the access token")
	}
	if second.ExpiresAt <= first.ExpiresAt {
		t.Error("a rotation did not get a fresh access deadline")
	}
	// The idle deadline is now+30 days, capped by the absolute deadline.
	if want := testAccessStart.Add(time.Minute + accessRefreshIdle).Unix(); second.RefreshIdleExpiresAt != want {
		t.Errorf("idle deadline = %d want %d", second.RefreshIdleExpiresAt, want)
	}
	if want := testAccessStart.Add(accessRefreshAbsolute).Unix(); second.RefreshAbsoluteExpiresAt != want {
		t.Errorf("absolute deadline moved: %d want %d", second.RefreshAbsoluteExpiresAt, want)
	}

	state := testAccessStateFile(t)
	if len(state.Active.Families) != 2 {
		t.Fatalf("families = %d want 2 (enable and login)", len(state.Active.Families))
	}
	var rotated *accessV2Family
	for i := range state.Active.Families {
		if state.Active.Families[i].Generation > 0 {
			rotated = &state.Active.Families[i]
		}
	}
	if rotated == nil {
		t.Fatal("no family recorded a rotation")
	}
	if rotated.Generation != 2 {
		t.Errorf("generation = %d want 2", rotated.Generation)
	}
	if len(rotated.Consumed) != 2 {
		t.Fatalf("consumed evidence = %d want 2", len(rotated.Consumed))
	}
	if rotated.Consumed[0].ConsumedAt != testAccessStart.Unix() ||
		rotated.Consumed[1].ConsumedAt != testAccessStart.Add(time.Minute).Unix() {
		t.Errorf("consumed_at = %v want the two rotation instants", rotated.Consumed)
	}
	if rotated.LastUsedAt != testAccessStart.Add(time.Minute).Unix() {
		t.Errorf("last_used_at = %d", rotated.LastUsedAt)
	}
	if !validAccessDigest(rotated.ActiveDigest) {
		t.Error("active digest is not a digest")
	}
	// No handle, token, or password reaches the file.
	raw, err := os.ReadFile(accessV2StatePath())
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{second.Token, firstHandle, testAccessPassword, loadConfig().AccessPasswordHash} {
		if forbidden != "" && strings.Contains(string(raw), forbidden) {
			t.Error("state file contains a credential")
		}
	}
}

func TestAccessV2RefreshReplayRevokesOutsideGrace(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)

	testAccessEnableV2(t, testAccessPassword)
	handle := testAccessRefreshHandle(t, testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.131:1"))
	rotated := testAccessDecodeBundle(t, testAccessV2RefreshRequest(t, handle))
	current := testAccessRefreshHandle(t, testAccessV2RefreshRequest(t, handle))

	// One second past the grace window the retry is a reuse signal.
	clock.advance(accessRefreshGrace + time.Second)
	testAccessErrorResponse(t, "replay past grace",
		testAccessV2RefreshRequest(t, handle), http.StatusUnauthorized, "access authentication required\n")

	// The revocation is durable and immediate: the live handle and the live
	// token both stop working.
	testAccessErrorResponse(t, "handle after replay revocation",
		testAccessV2RefreshRequest(t, current), http.StatusUnauthorized, "access authentication required\n")
	r := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	r.Header.Set("Authorization", "Bearer "+rotated.Token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, r); w.Code != http.StatusUnauthorized {
		t.Errorf("revoked family's token still authorized: %d", w.Code)
	}
	for _, family := range testAccessStateFile(t).Active.Families {
		if family.Generation > 0 {
			t.Error("revoked family is still durable")
		}
	}
}

func TestAccessV2RefreshUnknownHandles(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)

	testAccessEnableV2(t, testAccessPassword)
	rotated := testAccessV2RefreshRequest(t,
		testAccessRefreshHandle(t, testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.132:1")))
	bundle := testAccessDecodeBundle(t, rotated)
	live := testAccessRefreshHandle(t, rotated)
	familiesBefore := len(testAccessStateFile(t).Active.Families)

	unknown, err := randomAccessToken()
	if err != nil {
		t.Fatal(err)
	}
	for name, candidate := range map[string]string{
		"unknown 32-byte handle": unknown,
		"short handle":           "dG9vLXNob3J0",
		"padded handle":          "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM=",
		"non-base64 handle":      "%%%%",
		"empty handle":           "",
	} {
		r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh", `{}`)
		r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: candidate})
		testAccessErrorResponse(t, name, testAccessServe(handleAccessV2Refresh, r),
			http.StatusUnauthorized, "access authentication required\n")
	}

	// No collateral revocation: the rotated handle still rotates and its token
	// still authorizes, and the rejected attempts wrote nothing.
	if len(testAccessStateFile(t).Active.Families) != familiesBefore {
		t.Error("an unknown handle changed the family set")
	}
	clock.advance(time.Second)
	if w := testAccessV2RefreshRequest(t, live); w.Code != http.StatusOK {
		t.Errorf("live handle after unknown-handle attempts: %d %s", w.Code, w.Body.String())
	}
	r := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	r.Header.Set("Authorization", "Bearer "+bundle.Token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, r); w.Code != http.StatusNoContent {
		t.Errorf("live token stopped working after unknown-handle attempts: %d", w.Code)
	}
}

func TestAccessV2RefreshConcurrentSerialization(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	testAccessUseClock(t, auth, testAccessStart)
	testAccessEnableV2(t, testAccessPassword)
	handle := testAccessRefreshHandle(t, testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.133:1"))

	const callers = 8
	var wg sync.WaitGroup
	results := make([]*httptest.ResponseRecorder, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = testAccessV2RefreshRequest(t, handle)
		}(i)
	}
	wg.Wait()

	var token string
	for i, w := range results {
		if w.Code != http.StatusOK {
			t.Fatalf("caller %d: %d %s", i, w.Code, w.Body.String())
		}
		var payload struct {
			Token string `json:"token"`
		}
		testAccessJSONBody(t, w, &payload)
		if token == "" {
			token = payload.Token
		} else if payload.Token != token {
			t.Fatalf("caller %d got a different token: the rotation was not serialized", i)
		}
	}

	// Exactly one rotation happened: the rest were grace replays of it.
	rotations := 0
	for _, family := range testAccessStateFile(t).Active.Families {
		if family.Generation == 1 {
			rotations++
			if len(family.Consumed) != 1 {
				t.Errorf("consumed evidence = %d want 1", len(family.Consumed))
			}
		}
	}
	if rotations != 1 {
		t.Fatalf("rotated families = %d want 1", rotations)
	}
}

func TestAccessV2RefreshIdleAndAbsoluteDeadlines(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)

	testAccessEnableV2(t, testAccessPassword)
	first := testAccessV2RefreshRequest(t,
		testAccessRefreshHandle(t, testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.134:1")))
	handle := testAccessRefreshHandle(t, first)
	login := testAccessDecodeBundle(t, first)
	absolute := time.Unix(login.RefreshAbsoluteExpiresAt, 0)

	rotate := func() testAccessBundle {
		t.Helper()
		w := testAccessV2RefreshRequest(t, handle)
		if w.Code != http.StatusOK {
			t.Fatalf("rotation at %v: %d %s", clock.now.Sub(testAccessStart), w.Code, w.Body.String())
		}
		handle = testAccessRefreshHandle(t, w)
		return testAccessDecodeBundle(t, w)
	}

	// Idle: one second before the idle deadline the family still rotates, and
	// the rotation is capped by the absolute deadline rather than extending
	// past it.
	clock.advance(accessRefreshIdle - time.Second)
	idleRenewed := rotate()
	if want := clock.now.Add(accessRefreshIdle).Unix(); idleRenewed.RefreshIdleExpiresAt != want {
		t.Errorf("idle deadline = %d want a full renewal at %d", idleRenewed.RefreshIdleExpiresAt, want)
	}
	if got := time.Unix(idleRenewed.RefreshIdleExpiresAt, 0); got.After(absolute) {
		t.Errorf("idle deadline %v passed the absolute cap %v", got, absolute)
	}

	// Walk the family to the absolute deadline without ever letting the idle
	// window lapse.
	for clock.now.Before(absolute.Add(-20 * 24 * time.Hour)) {
		clock.advance(20 * 24 * time.Hour)
		renewed := rotate()
		if renewed.RefreshAbsoluteExpiresAt != login.RefreshAbsoluteExpiresAt {
			t.Fatalf("absolute deadline moved to %d", renewed.RefreshAbsoluteExpiresAt)
		}
		if got := time.Unix(renewed.RefreshIdleExpiresAt, 0); got.After(absolute) {
			t.Fatalf("idle deadline %v passed the absolute cap %v", got, absolute)
		}
	}

	// At absolute-1s it still rotates and the idle deadline lands exactly on the
	// cap; at absolute itself the family is gone.
	clock.advance(absolute.Add(-time.Second).Sub(clock.now))
	capped := rotate()
	if want := capped.RefreshAbsoluteExpiresAt; capped.RefreshIdleExpiresAt != want {
		t.Errorf("idle deadline = %d want the absolute cap %d", capped.RefreshIdleExpiresAt, want)
	}
	clock.advance(time.Second)
	testAccessErrorResponse(t, "rotation at the absolute deadline",
		testAccessV2RefreshRequest(t, handle), http.StatusUnauthorized, "access authentication required\n")
}

func TestAccessV2RefreshConsumedPruning(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)

	testAccessEnableV2(t, testAccessPassword)
	handle := testAccessRefreshHandle(t, testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.135:1"))
	testAccessDecodeBundle(t, testAccessV2RefreshRequest(t, handle))
	current := testAccessRefreshHandle(t, func() *httptest.ResponseRecorder {
		r := testAccessV2Request(http.MethodPost, "/api/auth/v2/refresh", `{}`)
		r.AddCookie(&http.Cookie{Name: accessRefreshCookie, Value: handle})
		return testAccessServe(handleAccessV2Refresh, r)
	}())

	for _, family := range testAccessStateFile(t).Active.Families {
		if family.Generation == 1 && len(family.Consumed) != 1 {
			t.Fatalf("consumed evidence = %d before pruning", len(family.Consumed))
		}
	}

	// Seven days later the replay evidence is past its retention and the next
	// commit drops it, so an old handle is simply unknown.
	clock.advance(accessConsumedRetention)
	if w := testAccessV2RefreshRequest(t, current); w.Code != http.StatusOK {
		t.Fatalf("rotation after the retention window: %d %s", w.Code, w.Body.String())
	}
	for _, family := range testAccessStateFile(t).Active.Families {
		if family.Generation == 2 && len(family.Consumed) != 1 {
			t.Errorf("consumed evidence = %d want only the newest entry", len(family.Consumed))
		}
	}
	testAccessErrorResponse(t, "pruned handle",
		testAccessV2RefreshRequest(t, handle), http.StatusUnauthorized, "access authentication required\n")
}

func TestAccessV2RefreshConsumedCapRevokes(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)

	testAccessEnableV2(t, testAccessPassword)
	handle := testAccessRefreshHandle(t, testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.136:1"))

	var token string
	for i := 0; i < maxAccessConsumedPerFam; i++ {
		// One second per rotation keeps the refresh bucket (two tokens a
		// second) ahead of the cap loop without touching the grace window.
		clock.advance(time.Second)
		w := testAccessV2RefreshRequest(t, handle)
		if w.Code != http.StatusOK {
			t.Fatalf("rotation %d: %d %s", i+1, w.Code, w.Body.String())
		}
		bundle := testAccessDecodeBundle(t, w)
		token = bundle.Token
		handle = testAccessRefreshHandle(t, w)
	}
	for _, family := range testAccessStateFile(t).Active.Families {
		if len(family.Consumed) > maxAccessConsumedPerFam {
			t.Fatalf("consumed evidence = %d exceeds the cap", len(family.Consumed))
		}
	}

	// The next rotation would have to evict younger evidence, so the family is
	// revoked instead.
	testAccessErrorResponse(t, "rotation at the consumed cap",
		testAccessV2RefreshRequest(t, handle), http.StatusUnauthorized, "access authentication required\n")
	r := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, r); w.Code != http.StatusUnauthorized {
		t.Errorf("the cap revocation left the token valid: %d", w.Code)
	}
}

func TestAccessV2FamilyCapacityEvictsLRU(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	auth.mu.Lock()
	active := auth.snapshotLocked()
	active.Families = nil
	key, refreshKey := auth.jwtKey, auth.v2.refreshKey
	auth.mu.Unlock()

	ids := make([]string, 0, maxAccessFamilies+1)
	add := func(offset int) error {
		family, _, err := addAccessFamily(active, key, refreshKey, testAccessStart.Add(time.Duration(offset)*time.Second))
		if err != nil {
			return err
		}
		ids = append(ids, family.ID)
		return nil
	}
	for i := 0; i < maxAccessFamilies; i++ {
		if err := add(i); err != nil {
			t.Fatalf("add family %d: %v", i, err)
		}
	}
	if err := add(maxAccessFamilies); err != nil {
		t.Fatalf("add the over-cap family: %v", err)
	}
	if len(active.Families) != maxAccessFamilies {
		t.Fatalf("families = %d want the cap %d", len(active.Families), maxAccessFamilies)
	}
	if findAccessFamily(active, ids[0]) != nil {
		t.Error("the least-recently-used family survived eviction")
	}
	if findAccessFamily(active, ids[1]) == nil {
		t.Error("eviction removed more than the least-recently-used family")
	}
	if findAccessFamily(active, ids[len(ids)-1]) == nil {
		t.Error("eviction removed the newest family")
	}
}

func TestAccessV2RefreshRestartReconstruction(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)

	testAccessEnableV2(t, testAccessPassword)
	consumed := testAccessRefreshHandle(t, testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.137:1"))
	// The client sent the handle and lost the response; the server rotated and
	// persisted before it wrote anything.
	lostResponse := testAccessV2RefreshRequest(t, consumed)
	lostBundle := testAccessDecodeBundle(t, lostResponse)
	lostHandle := testAccessRefreshHandle(t, lostResponse)

	// A restart must reproduce the same bytes from durable state alone.
	testAccessReleaseStateOwnership(auth)
	restarted := newAccessAuthManager()
	testAccessUseClock(t, restarted, clock.now)
	if err := restarted.configure(loadConfig().AccessPasswordHash); err != nil {
		t.Fatal(err)
	}
	previous := accessAuth
	accessAuth = restarted
	t.Cleanup(func() { accessAuth = previous })

	clock.advance(10 * time.Second)
	replay := testAccessV2RefreshRequest(t, consumed)
	replayBundle := testAccessDecodeBundle(t, replay)
	if replayBundle.Token != lostBundle.Token {
		t.Error("restart did not reconstruct the lost access token byte for byte")
	}
	if replayHandle := testAccessRefreshHandle(t, replay); replayHandle != lostHandle {
		t.Error("restart did not reconstruct the lost handle")
	}
	if replayBundle.ExpiresAt != lostBundle.ExpiresAt ||
		replayBundle.RefreshIdleExpiresAt != lostBundle.RefreshIdleExpiresAt ||
		replayBundle.RefreshAbsoluteExpiresAt != lostBundle.RefreshAbsoluteExpiresAt {
		t.Errorf("restart changed a deadline: %+v want %+v", replayBundle, lostBundle)
	}
	// The reconstructed token must still authorize, and the reconstructed handle
	// must still rotate.
	r := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	r.Header.Set("Authorization", "Bearer "+replayBundle.Token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, r); w.Code != http.StatusNoContent {
		t.Fatalf("reconstructed token was rejected: %d", w.Code)
	}
	if w := testAccessV2RefreshRequest(t, lostHandle); w.Code != http.StatusOK {
		t.Fatalf("reconstructed handle did not rotate: %d %s", w.Code, w.Body.String())
	}
}

func TestAccessV2RefreshRateLimitIsolated(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	clock := testAccessUseClock(t, auth, testAccessStart)
	testAccessEnableV2(t, testAccessPassword)
	handle := testAccessRefreshHandle(t, testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.138:1"))

	// Fill the refresh budget with handles that cannot exist, so the family is
	// untouched while the bucket drains.
	unknown, err := randomAccessToken()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < accessRefreshBurst; i++ {
		if w := testAccessV2RefreshRequest(t, unknown); w.Code != http.StatusUnauthorized {
			t.Fatalf("burn %d: %d %s", i, w.Code, w.Body.String())
		}
	}
	limited := testAccessV2RefreshRequest(t, unknown)
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("refresh past the burst: %d %s", limited.Code, limited.Body.String())
	}
	if got := limited.Header().Get("Retry-After"); got == "" {
		t.Error("429 without Retry-After")
	}
	if got := limited.Body.String(); got != "Too many refresh requests\n" {
		t.Errorf("429 body = %q", got)
	}

	// The shared password-login backoff is a different budget: a wrong password
	// is still an honest 401, not a 429.
	if w := testAccessV2LoginRequest(t, "wrong-pass-0000", "192.0.2.139:1"); w.Code != http.StatusUnauthorized {
		t.Errorf("login after the refresh cap: %d %s", w.Code, w.Body.String())
	}
	auth.mu.Lock()
	attempts := len(auth.attempts)
	auth.mu.Unlock()
	if attempts != 1 {
		t.Errorf("refresh traffic touched the login attempt map: %d entries", attempts)
	}

	// Once the bucket refills the live family still rotates.
	clock.advance(time.Minute)
	if w := testAccessV2RefreshRequest(t, handle); w.Code != http.StatusOK {
		t.Fatalf("live handle after the cap reset: %d %s", w.Code, w.Body.String())
	}
}

// testAccessSwapManager installs manager as the global auth manager for the
// duration of the test, so handler-level assertions can target a second
// instance without disturbing the owner installed by useTestAccessAuth.
func testAccessSwapManager(t *testing.T, manager *accessAuthManager) {
	t.Helper()
	previous := accessAuth
	accessAuth = manager
	t.Cleanup(func() { accessAuth = previous })
}

// testAccessV2Status asserts the documented status shape and returns it.
func testAccessV2StatusBody(t *testing.T, manager *accessAuthManager) map[string]bool {
	t.Helper()
	testAccessSwapManager(t, manager)
	w := testAccessServe(handleAccessV2Status, httptest.NewRequest(http.MethodGet, "/api/auth/v2/status", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("v2 status: %d %s", w.Code, w.Body.String())
	}
	var payload map[string]bool
	testAccessJSONBody(t, w, &payload)
	return payload
}

// TestAccessStateOwnershipLockExcludesSecondInstance covers the single-owner
// contract: the process that cannot take the lock authorizes nothing, keeps
// serving non-auth surfaces, never writes the shared state file, and recovers
// ownership once the first instance releases it.
func TestAccessStateOwnershipLockExcludesSecondInstance(t *testing.T) {
	withTempConfig(t)
	owner := useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.201:1")
	bundle := testAccessDecodeBundle(t, login)
	v1Cookie := testAccessCookieFor(t, owner)

	// The state file must not double as the lock: every write replaces its
	// inode, so a lock taken on it would protect nothing.
	if accessV2LockPath() == accessV2StatePath() {
		t.Fatal("lock file shares the state path")
	}
	lockInfo, err := os.Stat(accessV2LockPath())
	if err != nil {
		t.Fatalf("stat lock file: %v", err)
	}
	stateInfo, err := os.Stat(accessV2StatePath())
	if err != nil {
		t.Fatalf("stat state file: %v", err)
	}
	if os.SameFile(lockInfo, stateInfo) {
		t.Fatal("lock and state are the same inode")
	}
	// A rotation rewrites the state file. The lock must survive it, which is
	// only possible because it lives in a separate, stable file.
	rotated := testAccessV2RefreshRequest(t, testAccessRefreshHandle(t, login))
	if rotated.Code != http.StatusOK {
		t.Fatalf("rotation before the ownership check: %d %s", rotated.Code, rotated.Body.String())
	}
	liveHandle := testAccessRefreshHandle(t, rotated)
	afterRotation, err := os.Stat(accessV2StatePath())
	if err != nil {
		t.Fatalf("stat state file after rotation: %v", err)
	}
	if os.SameFile(stateInfo, afterRotation) {
		t.Error("state write did not replace the file inode")
	}
	if !owner.owner.held() {
		t.Error("owner lost the lock across a state replacement")
	}
	if held, err := os.Stat(accessV2LockPath()); err != nil {
		t.Fatalf("stat lock file after state write: %v", err)
	} else if !os.SameFile(lockInfo, held) {
		t.Error("lock file inode changed across a state write")
	}

	second := newAccessAuthManager()
	t.Cleanup(func() { second.owner.release() })
	cfg := loadConfig()
	if err := second.configure(cfg.AccessPasswordHash); err != nil {
		t.Fatalf("configure second instance: %v", err)
	}
	if second.ownedNow() || second.stateOwned() {
		t.Fatal("second instance took ownership of a held lock")
	}

	// It authorizes nothing: neither the owner's v2 bearer nor its v1 cookie.
	protected := testAccessProtected()
	bearer := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	bearer.Header.Set("Authorization", "Bearer "+bundle.Token)
	v1 := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	v1.AddCookie(v1Cookie)
	testAccessSwapManager(t, second)
	for name, request := range map[string]*http.Request{"v2 bearer": bearer, "v1 cookie": v1} {
		if w := testAccessServe(protected.ServeHTTP, request); w.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d want 401", name, w.Code)
		}
	}

	// v2 status reports the refusal instead of pretending to be authenticated.
	status := testAccessV2StatusBody(t, second)
	if status["owned"] {
		t.Error("second instance reported ownership")
	}
	if status["authenticated"] {
		t.Error("second instance reported an authenticated session")
	}
	if !status["enabled"] {
		t.Error("second instance hid the enforcement state")
	}

	// Non-auth surfaces keep working: only /api and /ws are gated.
	public := accessAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	if w := testAccessServe(public.ServeHTTP, httptest.NewRequest(http.MethodGet, "/healthz", nil)); w.Code != http.StatusNoContent {
		t.Errorf("public health path under a non-owner = %d want 204", w.Code)
	}

	// A write attempt fails and leaves the owner's state bytes untouched.
	before, err := os.ReadFile(accessV2StatePath())
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if _, err := second.commitPasswordLocked(testAccessPasswordRecord(t), time.Now(), true); !errors.Is(err, errAccessPersistence) {
		t.Errorf("second instance password commit error = %v want persistence refusal", err)
	}
	if _, err := second.refresh(liveHandle, "192.0.2.201:1", time.Now()); !errors.Is(err, errAccessPersistence) {
		t.Errorf("second instance refresh error = %v want persistence refusal", err)
	}
	passwordBody, err := json.Marshal(map[string]string{"password": testAccessPassword})
	if err != nil {
		t.Fatal(err)
	}
	testAccessErrorResponse(t, "non-owner password change",
		testAccessV2PasswordRequest(t, string(passwordBody), bundle.Token),
		http.StatusInternalServerError, "Unable to save access password\n")
	after, err := os.ReadFile(accessV2StatePath())
	if err != nil {
		t.Fatalf("re-read state: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Error("second instance wrote the shared state file")
	}

	// The owner releases and the second instance recovers without a restart.
	owner.owner.release()
	if !second.ensureOwned() {
		t.Fatal("second instance did not recover ownership")
	}
	if status := testAccessV2StatusBody(t, second); !status["owned"] {
		t.Error("recovered instance still reports owned=false")
	}
	recovered := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	recovered.Header.Set("Authorization", "Bearer "+bundle.Token)
	if w := testAccessServe(testAccessProtected().ServeHTTP, recovered); w.Code != http.StatusNoContent {
		t.Errorf("recovered instance rejected the owner's bearer: %d %s", w.Code, w.Body.String())
	}
}

// testAccessPasswordRecord builds a record distinct from testAccessHash so a
// password change is a real record change.
func testAccessPasswordRecord(t *testing.T) *accessPasswordRecord {
	t.Helper()
	record, err := newAccessPasswordRecord(testAccessPassword)
	if err != nil {
		t.Fatalf("derive test record: %v", err)
	}
	return record
}

// testAccessStateBytes returns the raw durable state produced by the real
// enable/login flow, so each schema case mutates a state the code itself wrote.
func testAccessStateBytes(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(accessV2StatePath())
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	return raw
}

// testAccessRewriteState decodes the durable state, hands it to mutate, and
// writes the result back without validation, so the loader can be tested
// against states the writer would refuse to produce.
func testAccessRewriteState(t *testing.T, mutate func(*accessV2StateFile)) {
	t.Helper()
	var state accessV2StateFile
	if err := json.Unmarshal(testAccessStateBytes(t), &state); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	mutate(&state)
	raw, err := json.Marshal(&state)
	if err != nil {
		t.Fatalf("encode state: %v", err)
	}
	if err := os.WriteFile(accessV2StatePath(), raw, 0o600); err != nil {
		t.Fatalf("write state: %v", err)
	}
}

// TestAccessV2StateSchemaBounds pins that unreadable, oversized, or
// contract-violating state is a fixed error rather than an auto-repair: the
// loader must never guess its way to an authorizable state.
func TestAccessV2StateSchemaBounds(t *testing.T) {
	withTempConfig(t)
	if state, err := loadAccessV2StateFile(accessV2StatePath()); err != nil || state != nil {
		t.Fatalf("missing state = (%v, %v) want (nil, nil)", state, err)
	}
	if err := os.WriteFile(accessV2StatePath(), []byte("  \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if state, err := loadAccessV2StateFile(accessV2StatePath()); err != nil || state != nil {
		t.Fatalf("empty state = (%v, %v) want (nil, nil)", state, err)
	}

	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.211:1")
	testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.212:1")
	valid := testAccessStateBytes(t)
	// Two families are needed for the duplicate checks; prove the baseline loads.
	if state, err := loadAccessV2StateFile(accessV2StatePath()); err != nil || state == nil {
		t.Fatalf("valid state rejected: state=%v err=%v", state, err)
	}

	digest := func(seed byte) string {
		return fmt.Sprintf("%064x", bytes.Repeat([]byte{seed}, 32))
	}
	handle := func(seed byte) string {
		return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{seed}, 32))
	}

	cases := []struct {
		name   string
		mutate func(*accessV2StateFile)
	}{
		{"unsupported version", func(s *accessV2StateFile) { s.Version = accessV2StateVersion + 1 }},
		{"invalid active binding", func(s *accessV2StateFile) { s.Active.RecordBinding = "nothex" }},
		{"zero epoch", func(s *accessV2StateFile) { s.Active.Epoch = 0 }},
		{"invalid record id", func(s *accessV2StateFile) { s.Active.RecordID = "short" }},
		{"invalid refresh key", func(s *accessV2StateFile) {
			key := base64.RawURLEncoding.EncodeToString([]byte("too-short"))
			s.Active.RefreshKey = &key
		}},
		{"invalid family id", func(s *accessV2StateFile) { s.Active.Families[0].ID = "short" }},
		{"duplicate family id", func(s *accessV2StateFile) { s.Active.Families[1].ID = s.Active.Families[0].ID }},
		{"family used before creation", func(s *accessV2StateFile) {
			s.Active.Families[0].LastUsedAt = s.Active.Families[0].CreatedAt - 1
		}},
		{"idle deadline inside creation", func(s *accessV2StateFile) {
			s.Active.Families[0].IdleExpiresAt = s.Active.Families[0].CreatedAt
		}},
		{"absolute before idle", func(s *accessV2StateFile) {
			s.Active.Families[0].AbsoluteExpiresAt = s.Active.Families[0].IdleExpiresAt - 1
		}},
		{"invalid active digest", func(s *accessV2StateFile) { s.Active.Families[0].ActiveDigest = "zz" }},
		{"duplicate active digest", func(s *accessV2StateFile) {
			s.Active.Families[1].ActiveDigest = s.Active.Families[0].ActiveDigest
		}},
		{"invalid access nonce", func(s *accessV2StateFile) { s.Active.Families[0].CurrentAccess.Nonce = "x" }},
		{"access issued at zero", func(s *accessV2StateFile) { s.Active.Families[0].CurrentAccess.IssuedAt = 0 }},
		{"access expires before issue", func(s *accessV2StateFile) {
			s.Active.Families[0].CurrentAccess.ExpiresAt = s.Active.Families[0].CurrentAccess.IssuedAt
		}},
		{"access lifetime over maximum", func(s *accessV2StateFile) {
			s.Active.Families[0].CurrentAccess.ExpiresAt = s.Active.Families[0].CurrentAccess.IssuedAt +
				int64(accessJWTMaxLifetime/time.Second) + 1
		}},
		{"invalid consumed digest", func(s *accessV2StateFile) {
			s.Active.Families[0].Consumed = []accessV2Consumed{{Digest: "zz", ConsumedAt: 1}}
		}},
		{"consumed digest collides with active", func(s *accessV2StateFile) {
			s.Active.Families[0].Consumed = []accessV2Consumed{{
				Digest:     s.Active.Families[0].ActiveDigest,
				ConsumedAt: s.Active.Families[0].CreatedAt,
			}}
		}},
		{"consumed timestamp zero", func(s *accessV2StateFile) {
			s.Active.Families[0].Consumed = []accessV2Consumed{{Digest: digest(9), ConsumedAt: 0}}
		}},
		{"consumed over the cap", func(s *accessV2StateFile) {
			consumed := make([]accessV2Consumed, 0, maxAccessConsumedPerFam+1)
			for i := 0; i <= maxAccessConsumedPerFam; i++ {
				consumed = append(consumed, accessV2Consumed{
					Digest:     fmt.Sprintf("%064x", i+1),
					ConsumedAt: s.Active.Families[0].CreatedAt,
				})
			}
			s.Active.Families[0].Consumed = consumed
		}},
		{"families over the cap", func(s *accessV2StateFile) {
			template := s.Active.Families[0]
			families := make([]accessV2Family, 0, maxAccessFamilies+1)
			for i := 0; i <= maxAccessFamilies; i++ {
				family := template
				family.ID = handle(byte(i % 251))
				family.ActiveDigest = digest(byte(i % 251))
				families = append(families, family)
			}
			s.Active.Families = families
		}},
		{"invalid pending binding", func(s *accessV2StateFile) {
			s.Pending = &accessV2Pending{
				FromRecordBinding: "nothex",
				PasswordRecord:    testAccessHash(),
				Next:              s.Active,
			}
		}},
		{"invalid pending record", func(s *accessV2StateFile) {
			s.Pending = &accessV2Pending{
				FromRecordBinding: s.Active.RecordBinding,
				PasswordRecord:    "pbkdf2-sha256$1$abc$def",
				Next:              s.Active,
			}
		}},
		{"invalid pending next", func(s *accessV2StateFile) {
			next := s.Active
			next.Epoch = 0
			s.Pending = &accessV2Pending{
				FromRecordBinding: s.Active.RecordBinding,
				PasswordRecord:    testAccessHash(),
				Next:              next,
			}
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if err := os.WriteFile(accessV2StatePath(), valid, 0o600); err != nil {
				t.Fatal(err)
			}
			testAccessRewriteState(t, testCase.mutate)
			state, err := loadAccessV2StateFile(accessV2StatePath())
			if err == nil {
				t.Fatalf("state accepted: %+v", state)
			}
			if state != nil {
				t.Error("rejected state was also returned")
			}
		})
	}

	t.Run("oversized", func(t *testing.T) {
		padded := make([]byte, len(valid))
		copy(padded, valid)
		padded = append(padded, bytes.Repeat([]byte(" "), maxAccessV2StateBytes-len(valid)+1)...)
		if err := os.WriteFile(accessV2StatePath(), padded, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadAccessV2StateFile(accessV2StatePath()); err == nil {
			t.Fatal("oversized state accepted")
		}
	})
	t.Run("trailing data", func(t *testing.T) {
		if err := os.WriteFile(accessV2StatePath(), append(append([]byte{}, valid...), []byte("{}")...), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadAccessV2StateFile(accessV2StatePath()); err == nil {
			t.Fatal("trailing data accepted")
		}
	})
	t.Run("unknown field", func(t *testing.T) {
		var generic map[string]any
		if err := json.Unmarshal(valid, &generic); err != nil {
			t.Fatal(err)
		}
		generic["unexpected"] = true
		raw, err := json.Marshal(generic)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(accessV2StatePath(), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadAccessV2StateFile(accessV2StatePath()); err == nil {
			t.Fatal("unknown field accepted")
		}
	})

	// Corrupt state on disk must fault v2 closed and stay untouched: repairing
	// it silently would resurrect sessions the contract revoked.
	testAccessRewriteState(t, func(s *accessV2StateFile) { s.Active.Epoch = 0 })
	corrupt := testAccessStateBytes(t)
	auth := useTestAccessAuth(t)
	cfg := loadConfig()
	if err := auth.configure(cfg.AccessPasswordHash); err != nil {
		t.Fatalf("configure with corrupt state: %v", err)
	}
	if status := testAccessV2StatusBody(t, auth); status["authenticated"] {
		t.Error("corrupt state authorized a session")
	}
	if after := testAccessStateBytes(t); !bytes.Equal(corrupt, after) {
		t.Error("corrupt state was rewritten during configure")
	}
}

// testAccessRestart builds a fresh manager from Config the way process startup
// does, after releasing the current owner's lock. A non-nil fault reports the
// recovered state instead of asserting a healthy one.
func testAccessRestart(t *testing.T) *accessAuthManager {
	t.Helper()
	restarted := newAccessAuthManager()
	t.Cleanup(func() { restarted.owner.release() })
	if err := restarted.configure(loadConfig().AccessPasswordHash); err != nil {
		t.Fatalf("restart configure: %v", err)
	}
	return restarted
}

// testAccessJournaledChange drives a real record change and stops it at a chosen
// point by failing the nth state write, leaving the journal on disk exactly as
// a crash at that instruction would.
func testAccessJournaledChange(t *testing.T, auth *accessAuthManager, failWriteAt int) {
	t.Helper()
	previous := writeAccessV2StateFile
	writes := 0
	writeAccessV2StateFile = func(path string, data []byte, perm os.FileMode) error {
		writes++
		if writes == failWriteAt {
			return errors.New("injected state write failure")
		}
		return previous(path, data, perm)
	}
	t.Cleanup(func() { writeAccessV2StateFile = previous })
	if _, err := auth.commitPasswordLocked(testAccessPasswordRecord(t), auth.now(), true); err == nil {
		t.Fatalf("record change succeeded despite failing state write %d", failWriteAt)
	}
	writeAccessV2StateFile = previous
	if writes < failWriteAt {
		t.Fatalf("record change performed %d state writes, wanted at least %d", writes, failWriteAt)
	}
}

// TestAccessV2JournalRecovery covers the three restart cases from the
// persistence contract: the Config commit happened, it did not happen, and the
// state matches neither side of the journal.
func TestAccessV2JournalRecovery(t *testing.T) {
	t.Run("config commit never landed keeps the old sessions", func(t *testing.T) {
		withTempConfig(t)
		auth := useTestAccessAuth(t)
		testAccessEnableV2(t, testAccessPassword)
		login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.221:1")
		handle := testAccessRefreshHandle(t, login)
		oldBinding := testAccessStateFile(t).Active.RecordBinding
		oldHandleCount := len(testAccessStateFile(t).Active.Families)

		previousConfig := writeConfigFile
		writeConfigFile = func(string, []byte, os.FileMode) error {
			return errors.New("injected config write failure")
		}
		if _, err := auth.commitPasswordLocked(testAccessPasswordRecord(t), auth.now(), true); !errors.Is(err, errAccessPersistence) {
			t.Fatalf("config write failure = %v want persistence refusal", err)
		}
		writeConfigFile = previousConfig

		// The journal is on disk with the old active state beside it.
		journaled := testAccessStateFile(t)
		if journaled.Pending == nil {
			t.Fatal("no journal was written before the config commit")
		}
		if loadConfig().AccessPasswordHash != "" && journaled.Pending.PasswordRecord == loadConfig().AccessPasswordHash {
			t.Fatal("config committed despite the injected failure")
		}

		auth.owner.release()
		restarted := testAccessRestart(t)
		recovered := testAccessStateFile(t)
		if recovered.Pending != nil {
			t.Error("journal survived a restart that should have discarded it")
		}
		if recovered.Active.RecordBinding != oldBinding {
			t.Error("restart replaced the active record without a config commit")
		}
		if len(recovered.Active.Families) != oldHandleCount {
			t.Error("restart dropped sessions that the failed change never revoked")
		}
		testAccessSwapManager(t, restarted)
		if w := testAccessV2RefreshRequest(t, handle); w.Code != http.StatusOK {
			t.Errorf("pre-change handle after restart = %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("config commit landed promotes the journaled record", func(t *testing.T) {
		withTempConfig(t)
		auth := useTestAccessAuth(t)
		testAccessEnableV2(t, testAccessPassword)
		testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.222:1")
		// Write 1 is the journal, write 2 is the promote: failing the promote
		// leaves Config on the new record with the journal still present.
		testAccessJournaledChange(t, auth, 2)

		journaled := testAccessStateFile(t)
		if journaled.Pending == nil {
			t.Fatal("promote failure cleared the journal")
		}
		newBinding := accessRecordBinding(journaled.Pending.PasswordRecord)
		if loadConfig().AccessPasswordHash != journaled.Pending.PasswordRecord {
			t.Fatal("config does not carry the journaled record")
		}
		if journaled.Active.RecordBinding == newBinding {
			t.Fatal("active state already matches the new record before restart")
		}

		auth.owner.release()
		restarted := testAccessRestart(t)
		recovered := testAccessStateFile(t)
		if recovered.Pending != nil {
			t.Error("journal survived the restart that promoted it")
		}
		if recovered.Active.RecordBinding != newBinding {
			t.Error("restart did not promote the journaled record")
		}
		// The promoted families authorize, and the handle is the journaled one.
		key, err := base64.RawURLEncoding.DecodeString(*recovered.Active.RefreshKey)
		if err != nil {
			t.Fatalf("decode refresh key: %v", err)
		}
		if len(recovered.Active.Families) != 1 {
			t.Fatalf("promoted families = %d want 1", len(recovered.Active.Families))
		}
		family := recovered.Active.Families[0]
		handle, err := accessRefreshHandle(key, family.ID, family.Generation)
		if err != nil {
			t.Fatalf("derive promoted handle: %v", err)
		}
		testAccessSwapManager(t, restarted)
		rotated := testAccessV2RefreshRequest(t, handle)
		if rotated.Code != http.StatusOK {
			t.Fatalf("journaled handle = %d %s", rotated.Code, rotated.Body.String())
		}
		bundle := testAccessDecodeBundle(t, rotated)
		restarted.mu.Lock()
		claims, ok := restarted.jwtClaimsLocked(bundle.Token, restarted.now(), 0)
		restarted.mu.Unlock()
		if !ok || claims == nil {
			t.Fatal("promoted access token rejected")
		}
		if claims.RecordID != recovered.Active.RecordID {
			t.Error("promoted token was minted for another record")
		}
	})

	t.Run("neither binding revokes every family", func(t *testing.T) {
		withTempConfig(t)
		auth := useTestAccessAuth(t)
		testAccessEnableV2(t, testAccessPassword)
		login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.223:1")
		handle := testAccessRefreshHandle(t, login)
		testAccessJournaledChange(t, auth, 2)

		// An out-of-band edit: Config now carries a record that matches neither
		// the active state nor the journal.
		third, err := newAccessPasswordRecord("a third unrelated password")
		if err != nil {
			t.Fatal(err)
		}
		if err := saveAccessPasswordHash(third.encoded()); err != nil {
			t.Fatalf("out-of-band config write: %v", err)
		}

		auth.owner.release()
		restarted := testAccessRestart(t)
		recovered := testAccessStateFile(t)
		if recovered.Pending != nil {
			t.Error("journal survived the neither-binding recovery")
		}
		if len(recovered.Active.Families) != 0 {
			t.Errorf("families after neither-binding recovery = %d want 0", len(recovered.Active.Families))
		}
		if recovered.Active.RecordBinding != accessRecordBinding(third.encoded()) {
			t.Error("recovery did not bind state to the current config record")
		}
		testAccessSwapManager(t, restarted)
		if w := testAccessV2RefreshRequest(t, handle); w.Code != http.StatusUnauthorized {
			t.Errorf("pre-existing handle after revocation = %d want 401", w.Code)
		}
		// v2 is closed until a fresh password login establishes state for the
		// record Config actually carries.
		if w := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.226:1"); w.Code != http.StatusUnauthorized {
			t.Errorf("stale password after revocation = %d want 401", w.Code)
		}
		fresh := testAccessV2LoginRequest(t, "a third unrelated password", "192.0.2.227:1")
		freshBundle := testAccessDecodeBundle(t, fresh)
		if freshBundle.Token == "" {
			t.Fatal("fresh login after revocation issued no token")
		}
		if recovered := testAccessStateFile(t); len(recovered.Active.Families) != 1 {
			t.Errorf("families after a fresh login = %d want 1", len(recovered.Active.Families))
		}
	})
}

// TestAccessV2PersistedJSONHoldsNoSecrets pins that the durable state carries
// only digests and derived material, never a refresh handle, bearer, or
// password.
func TestAccessV2PersistedJSONHoldsNoSecrets(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.225:1")
	bundle := testAccessDecodeBundle(t, login)
	handle := testAccessRefreshHandle(t, login)
	rotated := testAccessV2RefreshRequest(t, handle)
	rotatedBundle := testAccessDecodeBundle(t, rotated)
	liveHandle := testAccessRefreshHandle(t, rotated)

	raw := string(testAccessStateBytes(t))
	for name, secret := range map[string]string{
		"login bearer":     bundle.Token,
		"refreshed bearer": rotatedBundle.Token,
		"refresh handle":   handle,
		"live handle":      liveHandle,
		"password":         testAccessPassword,
	} {
		if strings.Contains(raw, secret) {
			t.Errorf("state file contains the %s", name)
		}
	}
	if strings.Contains(raw, string(testAccessPasswordRecord(t).Verifier)) {
		t.Error("state file contains raw verifier bytes")
	}
}

// TestAccessV1BackoffShiftsAndCap pins the exact unchanged v1 backoff schedule
// and the six-shift cap, so the v2 work cannot silently retune the pre-existing
// brute-force protection.
func TestAccessV1BackoffShiftsAndCap(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatalf("configure: %v", err)
	}
	clock := testAccessUseClock(t, auth, time.Unix(testAccessJWTIssuedAt, 0))
	client := "192.0.2.240"

	want := []time.Duration{
		time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
		16 * time.Second, 32 * time.Second, 64 * time.Second, 64 * time.Second,
		64 * time.Second,
	}
	for i, delay := range want {
		auth.mu.Lock()
		auth.recordFailureLocked(client, clock.now)
		attempt := auth.attempts[client]
		auth.mu.Unlock()
		if attempt.Failures != i+1 {
			t.Fatalf("failure %d: count = %d", i+1, attempt.Failures)
		}
		got := attempt.RetryAt.Sub(clock.now)
		if got != delay {
			t.Errorf("failure %d: backoff = %v want %v", i+1, got, delay)
		}
		if !attempt.LastFailure.Equal(clock.now) {
			t.Errorf("failure %d: last failure = %v want %v", i+1, attempt.LastFailure, clock.now)
		}
		clock.advance(delay)
	}

	// The capped backoff still protects the route: a client inside the window
	// is refused without touching the verifier. The v1 login route reads the
	// wall clock, so this part records a real failure rather than a frozen one.
	auth.mu.Lock()
	auth.recordFailureLocked("192.0.2.241", time.Now())
	auth.mu.Unlock()
	status := testAccessServe(handleAccessAuthStatus, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if status.Code != http.StatusOK {
		t.Fatalf("status: %d", status.Code)
	}
	var challenge struct {
		Challenge string `json:"challenge"`
	}
	testAccessJSONBody(t, status, &challenge)
	body, err := json.Marshal(map[string]string{
		"challenge": challenge.Challenge,
		"proof":     testAccessProof(t, bytes.Repeat([]byte{0x22}, accessPasswordVerifierBytes), challenge.Challenge),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "192.0.2.241:1"
	w := testAccessServe(handleAccessAuthLogin, request)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("login inside the capped backoff = %d want 429", w.Code)
	}
	// The correct proof after the window is accepted, so the cap bounds the
	// wait instead of locking the client out. The window is expired by moving
	// the stored deadline, not by sleeping.
	auth.mu.Lock()
	attempt := auth.attempts["192.0.2.241"]
	attempt.RetryAt = time.Now().Add(-time.Second)
	auth.attempts["192.0.2.241"] = attempt
	auth.mu.Unlock()
	status = testAccessServe(handleAccessAuthStatus, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	testAccessJSONBody(t, status, &challenge)
	body, err = json.Marshal(map[string]string{
		"challenge": challenge.Challenge,
		"proof":     testAccessProof(t, bytes.Repeat([]byte{0x22}, accessPasswordVerifierBytes), challenge.Challenge),
	})
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "192.0.2.241:1"
	if w := testAccessServe(handleAccessAuthLogin, request); w.Code != http.StatusOK {
		t.Fatalf("login after the backoff window = %d %s", w.Code, w.Body.String())
	}
}

// TestAccessExemptionLists pins the exact public and sync exemptions. Widening
// either one silently unprotects routes, so the lists are asserted literally.
func TestAccessExemptionLists(t *testing.T) {
	public := []string{
		"/api/auth/status", "/api/auth/login",
		"/api/auth/v2/status", "/api/auth/v2/login", "/api/auth/v2/password",
		"/api/auth/v2/refresh", "/api/auth/v2/logout",
		"/livez", "/healthz", "/readyz",
	}
	for _, path := range public {
		if !accessAuthPublicPath(path) {
			t.Errorf("%s is not exempt", path)
		}
	}
	// Non-/api, non-/ws paths serve the UI shell and stay reachable.
	for _, path := range []string{"/", "/index.html", "/app.js", "/style.css"} {
		if !accessAuthPublicPath(path) {
			t.Errorf("%s is not served without a session", path)
		}
	}
	protected := []string{
		"/api/config", "/api/coders", "/api/files", "/api/markdown",
		"/api/config/sync-coordinator", "/api/sync/messages",
		"/api/auth/status/../config",
		"/ws/panes/1", "/ws/events", "/ws/control",
	}
	for _, path := range protected {
		if accessAuthPublicPath(path) {
			t.Errorf("%s is exempt from authentication", path)
		}
	}
	// The sync board is the one deliberate non-auth API exemption, and it is
	// narrow: only the message endpoints, never the coordinator setting.
	for _, path := range []string{"/api/sync/messages", "/api/sync/messages/abc"} {
		if !isSyncBoardPath(path) {
			t.Errorf("%s is not a sync board path", path)
		}
	}
	for _, path := range []string{
		"/api/sync/messages2", "/api/sync/coordinator",
		"/api/config/sync-coordinator", "/api/sync", "/api/syncboard",
	} {
		if isSyncBoardPath(path) {
			t.Errorf("%s is wrongly treated as a sync board path", path)
		}
	}
}

// TestAccessAssetCookieReach pins the exact reach of the asset cookie: the two
// asset paths, GET and HEAD only, and nothing else.
func TestAccessAssetCookieReach(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.231:1")
	bundle := testAccessDecodeBundle(t, login)
	assetCookie := testAccessResponseCookie(t, login, accessAssetCookie)
	if assetCookie.Value == "" {
		t.Fatal("login installed no asset cookie")
	}

	allowed := map[string]string{
		"file asset":     accessAssetFilePath,
		"markdown asset": accessAssetMarkdownPath,
	}
	for name, path := range allowed {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			request := httptest.NewRequest(method, path, nil)
			request.AddCookie(&http.Cookie{Name: accessAssetCookie, Value: assetCookie.Value})
			if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
				t.Errorf("%s %s = %d want 204", name, method, w.Code)
			}
		}
	}

	// Everything else stays closed: the asset cookie is not a session.
	refused := []struct {
		method string
		path   string
	}{
		{http.MethodPost, accessAssetFilePath},
		{http.MethodPut, accessAssetMarkdownPath},
		{http.MethodDelete, accessAssetFilePath},
		{http.MethodGet, "/api/coders"},
		{http.MethodGet, "/api/file/asset/extra"},
		{http.MethodGet, "/api/markdown/asset/extra"},
		{http.MethodGet, "/ws/events"},
	}
	for _, testCase := range refused {
		request := httptest.NewRequest(testCase.method, testCase.path, nil)
		request.AddCookie(&http.Cookie{Name: accessAssetCookie, Value: assetCookie.Value})
		if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s with the asset cookie = %d want 401", testCase.method, testCase.path, w.Code)
		}
	}

	// A duplicate asset cookie fails closed rather than picking one.
	for _, path := range []string{accessAssetFilePath, accessAssetMarkdownPath} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.AddCookie(&http.Cookie{Name: accessAssetCookie, Value: assetCookie.Value})
		request.AddCookie(&http.Cookie{Name: accessAssetCookie, Value: assetCookie.Value})
		if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusUnauthorized {
			t.Errorf("duplicate asset cookie on %s = %d want 401", path, w.Code)
		}
	}

	// Logging out revokes the family, and its asset cookie stops working with it.
	if w := testAccessV2LogoutRequest(t, `{"all":false}`, bundle.Token); w.Code != http.StatusOK {
		t.Fatalf("logout: %d %s", w.Code, w.Body.String())
	}
	request := httptest.NewRequest(http.MethodGet, accessAssetFilePath, nil)
	request.AddCookie(&http.Cookie{Name: accessAssetCookie, Value: assetCookie.Value})
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusUnauthorized {
		t.Errorf("revoked asset cookie = %d want 401", w.Code)
	}
	// A fresh login mints a new family whose asset cookie works again, which
	// also proves the revocation did not wedge the manager.
	second := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.232:1")
	secondAsset := testAccessResponseCookie(t, second, accessAssetCookie)
	request = httptest.NewRequest(http.MethodGet, accessAssetFilePath, nil)
	request.AddCookie(&http.Cookie{Name: accessAssetCookie, Value: secondAsset.Value})
	if w := testAccessServe(testAccessProtected().ServeHTTP, request); w.Code != http.StatusNoContent {
		t.Errorf("asset cookie after a fresh login = %d want 204", w.Code)
	}
}

// TestAccessPostCommitFailureIssuesNoCredential covers the ambiguous half of the
// record transaction: once Config carries the new record, a failed promotion
// must issue nothing, fault v2 closed, and let v1 follow the committed record
// rather than keep authorizing against the old in-memory one.
func TestAccessPostCommitFailureIssuesNoCredential(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.251:1")
	handle := testAccessRefreshHandle(t, login)
	v1Cookie := testAccessCookieFor(t, auth)
	before := loadConfig().AccessPasswordHash

	previous := writeAccessV2StateFile
	writes := 0
	writeAccessV2StateFile = func(path string, data []byte, perm os.FileMode) error {
		writes++
		if writes == 2 {
			return errors.New("injected promote failure")
		}
		return previous(path, data, perm)
	}
	t.Cleanup(func() { writeAccessV2StateFile = previous })

	body, err := json.Marshal(map[string]string{"password": "post-commit-pass"})
	if err != nil {
		t.Fatal(err)
	}
	w := testAccessV2PasswordRequest(t, string(body), token)
	writeAccessV2StateFile = previous

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("ambiguous promotion = %d want 500 (body %q)", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != "Unable to save access password\n" {
		t.Errorf("body = %q", got)
	}
	if writes < 2 {
		t.Fatalf("record change performed %d state writes, wanted the journal and the promote", writes)
	}
	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("failed promotion issued %d cookies", len(cookies))
	}

	// The Config commit did happen, so the durable record is the new one.
	committed := loadConfig().AccessPasswordHash
	if committed == before {
		t.Fatal("config did not commit before the promotion failure")
	}

	// v2 is faulted closed instead of serving from the old runtime.
	protected := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	protected.Header.Set("Authorization", "Bearer "+token)
	if got := testAccessServe(testAccessProtected().ServeHTTP, protected); got.Code != http.StatusUnauthorized {
		t.Errorf("old bearer after an ambiguous promotion = %d want 401", got.Code)
	}
	// A faulted manager reports the persistence fault (500, retryable) instead of
	// minting anything, and installs no cookie.
	faultedRefresh := testAccessV2RefreshRequest(t, handle)
	if faultedRefresh.Code != http.StatusInternalServerError {
		t.Errorf("old handle after an ambiguous promotion = %d want 500", faultedRefresh.Code)
	}
	if cookies := faultedRefresh.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("faulted refresh issued %d cookies", len(cookies))
	}

	// v1 follows the committed record: the old cookie is dead and the old
	// password no longer logs in.
	stale := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	stale.AddCookie(v1Cookie)
	if got := testAccessServe(testAccessProtected().ServeHTTP, stale); got.Code != http.StatusUnauthorized {
		t.Errorf("old v1 cookie after a committed record change = %d want 401", got.Code)
	}

	// A restart reconciles the journal and v2 works again.
	auth.owner.release()
	restarted := testAccessRestart(t)
	testAccessSwapManager(t, restarted)
	fresh := testAccessV2LoginRequest(t, "post-commit-pass", "192.0.2.252:1")
	if freshBundle := testAccessDecodeBundle(t, fresh); freshBundle.Token == "" {
		t.Fatal("v2 did not recover after reconciliation")
	}
	if got := testAccessStateFile(t).Pending; got != nil {
		t.Error("journal survived the restart that promoted it")
	}
}

// --- M1c: the socket admission validator ---

// admitsFence is the re-check the hub runs at registration. It must refuse a
// stale generation, a disabled manager, an expired admission, and any family
// that is gone, faulted, or past its own deadline.
func TestAccessFenceValidatorRefusesEveryRevokedAdmission(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	familyID := testAccessFamilyOf(t, auth, token)
	auth.mu.Lock()
	generation := auth.generation
	expiresAt := time.Now().Add(time.Hour)
	auth.mu.Unlock()

	live := ws.AuthFence{Generation: generation, FamilyID: familyID, ExpiresAt: expiresAt, Deadline: expiresAt}
	if !auth.admitsFence(live) {
		t.Fatal("live v2 admission refused")
	}

	v1 := ws.AuthFence{Generation: generation}
	if !auth.admitsFence(v1) {
		t.Fatal("v1 admission refused")
	}

	cases := []struct {
		name  string
		fence ws.AuthFence
	}{
		{name: "stale generation", fence: ws.AuthFence{Generation: generation - 1, FamilyID: familyID, ExpiresAt: expiresAt}},
		{name: "already expired", fence: ws.AuthFence{Generation: generation, FamilyID: familyID, ExpiresAt: time.Now().Add(-time.Second)}},
		{name: "unknown family", fence: ws.AuthFence{Generation: generation, FamilyID: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ExpiresAt: expiresAt}},
		{name: "v1 fence carrying an expiry", fence: ws.AuthFence{Generation: generation, ExpiresAt: expiresAt}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if auth.admitsFence(tc.fence) {
				t.Fatal("revoked admission accepted")
			}
		})
	}

	// A faulted manager refuses v2 admissions while its record is still there.
	auth.mu.Lock()
	auth.faulted = true
	auth.mu.Unlock()
	if auth.admitsFence(live) {
		t.Fatal("faulted v2 admission accepted")
	}
	auth.mu.Lock()
	auth.faulted = false
	auth.mu.Unlock()

	// A non-owner authorizes nothing at all.
	auth.mu.Lock()
	auth.owned = false
	auth.mu.Unlock()
	if auth.admitsFence(live) {
		t.Fatal("non-owner admission accepted")
	}
	auth.mu.Lock()
	auth.owned = true
	auth.mu.Unlock()

	// Disabled auth: a v1 admission still passes, a v2 one cannot exist.
	if err := auth.configure(""); err != nil {
		t.Fatalf("disable: %v", err)
	}
	auth.mu.Lock()
	disabledGeneration := auth.generation
	auth.mu.Unlock()
	if !auth.admitsFence(ws.AuthFence{Generation: disabledGeneration}) {
		t.Fatal("disabled v1 admission refused")
	}
	if auth.admitsFence(ws.AuthFence{Generation: disabledGeneration, FamilyID: familyID, ExpiresAt: expiresAt}) {
		t.Fatal("disabled v2 admission accepted")
	}
}

// The family's own deadline bounds an admission that the token exp would allow
// to live longer.
func TestAccessFenceValidatorHonoursFamilyDeadline(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	familyID := testAccessFamilyOf(t, auth, token)

	auth.mu.Lock()
	generation := auth.generation
	// Move the family's idle deadline into the past, as an idle expiry would.
	auth.v2.families[familyID].IdleExpiresAt = time.Now().Add(-time.Minute).Unix()
	auth.mu.Unlock()

	fence := ws.AuthFence{Generation: generation, FamilyID: familyID, ExpiresAt: time.Now().Add(time.Hour)}
	if auth.admitsFence(fence) {
		t.Fatal("admission past the family deadline accepted")
	}
}

// --- M4a: compatibility and failure matrix ---

// TestAccessV2StateResetAfterOldBinaryReturn covers the rollback row where an
// older binary ran and ignored the separate v2 state file. Its record is
// unchanged, so nothing in Config reveals the trip: the missing state file is
// the only evidence, and it must reset v2 instead of letting an earlier
// session survive. v1 carries no epoch and keeps working throughout.
func TestAccessV2StateResetAfterOldBinaryReturn(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.240:1")
	handle := testAccessRefreshHandle(t, login)
	cookie := testAccessCookieFor(t, auth)
	recordBefore := loadConfig().AccessPasswordHash
	identityBefore := testAccessStateFile(t).Active.RecordID

	// The old binary exits leaving Config byte-identical and no v2 state: it
	// neither read nor rewrote a file it does not know about.
	testAccessReleaseStateOwnership(auth)
	if err := os.Remove(accessV2StatePath()); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig().AccessPasswordHash; got != recordBefore {
		t.Fatalf("record changed across the simulated downgrade: %q", got)
	}

	restarted := testAccessRestart(t)
	testAccessSwapManager(t, restarted)
	protected := testAccessProtected()

	// Nothing v2 minted before the return may authorize: the family map and the
	// epoch that stamped those claims are gone.
	bearer := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	bearer.Header.Set("Authorization", "Bearer "+token)
	if got := testAccessServe(protected.ServeHTTP, bearer); got.Code != http.StatusUnauthorized {
		t.Errorf("pre-return v2 bearer = %d want 401", got.Code)
	}
	if got := testAccessV2RefreshRequest(t, handle); got.Code != http.StatusUnauthorized {
		t.Errorf("pre-return refresh handle = %d want 401", got.Code)
	}

	// v1 is stateless and unaffected: its cookie still authorizes.
	v1 := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	v1.AddCookie(cookie)
	if got := testAccessServe(protected.ServeHTTP, v1); got.Code != http.StatusNoContent {
		t.Errorf("v1 cookie after the return = %d want 204", got.Code)
	}

	// A raw password login re-establishes state for the current record, with a
	// fresh identity, and it is the only way back in.
	fresh := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.241:1")
	bundle := testAccessDecodeBundle(t, fresh)
	if bundle.Token == "" {
		t.Fatal("login after the return minted no token")
	}
	identityAfter := testAccessStateFile(t).Active.RecordID
	if identityAfter == identityBefore {
		t.Error("the returned session reused the pre-return record identity")
	}

	live := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	live.Header.Set("Authorization", "Bearer "+bundle.Token)
	if got := testAccessServe(protected.ServeHTTP, live); got.Code != http.StatusNoContent {
		t.Errorf("fresh bearer after the return = %d want 204", got.Code)
	}
	// The re-established state must not resurrect what the reset revoked.
	stale := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	stale.Header.Set("Authorization", "Bearer "+token)
	if got := testAccessServe(protected.ServeHTTP, stale); got.Code != http.StatusUnauthorized {
		t.Errorf("pre-return bearer after re-enable = %d want 401", got.Code)
	}
	if got := testAccessV2RefreshRequest(t, handle); got.Code != http.StatusUnauthorized {
		t.Errorf("pre-return handle after re-enable = %d want 401", got.Code)
	}
}

// TestAccessV2UnreadableStateFaultsClosed pins the difference between "no
// state yet" and "state we cannot read". The first is a first run; the second
// is a fixed failure, because guessing would resurrect sessions the owner
// revoked. Neither deletes the file, and v1 does not depend on it.
func TestAccessV2UnreadableStateFaultsClosed(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.242:1")
	handle := testAccessRefreshHandle(t, login)
	cookie := testAccessCookieFor(t, auth)

	testAccessReleaseStateOwnership(auth)
	if err := os.Remove(accessV2StatePath()); err != nil {
		t.Fatal(err)
	}
	// A directory at the state path is unreadable as a file and cannot be
	// repaired by writing through it.
	if err := os.Mkdir(accessV2StatePath(), 0o700); err != nil {
		t.Fatal(err)
	}

	restarted := testAccessRestart(t)
	testAccessSwapManager(t, restarted)
	protected := testAccessProtected()

	bearer := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	bearer.Header.Set("Authorization", "Bearer "+token)
	if got := testAccessServe(protected.ServeHTTP, bearer); got.Code != http.StatusUnauthorized {
		t.Errorf("bearer with unreadable state = %d want 401", got.Code)
	}
	// A faulted manager reports the persistence fault and mints nothing.
	faulted := testAccessV2RefreshRequest(t, handle)
	if faulted.Code != http.StatusInternalServerError {
		t.Errorf("refresh with unreadable state = %d want 500", faulted.Code)
	}
	if cookies := faulted.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("faulted refresh issued %d cookies", len(cookies))
	}
	status := testAccessV2StatusBody(t, restarted)
	if !status["enabled"] || status["authenticated"] {
		t.Errorf("status with unreadable state = %v want enabled without authentication", status)
	}

	// The failure is fixed, not destructive: nothing was removed or created.
	info, err := os.Stat(accessV2StatePath())
	if err != nil || !info.IsDir() {
		t.Fatalf("unreadable state path was rewritten: info=%v err=%v", info, err)
	}

	// v1 does not use this file and keeps working.
	v1 := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	v1.AddCookie(cookie)
	if got := testAccessServe(protected.ServeHTTP, v1); got.Code != http.StatusNoContent {
		t.Errorf("v1 cookie with unreadable state = %d want 204", got.Code)
	}
}

// TestAccessJWTLifetimeRejectedUnderRestoredKey proves the maximum lifetime is
// enforced by the key the process actually restored, not only by the key that
// minted the fixture: a restart must not widen what a token may claim.
func TestAccessJWTLifetimeRejectedUnderRestoredKey(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)

	original := mustTestAccessJWTKey(t, auth)
	testAccessReleaseStateOwnership(auth)
	restarted := testAccessRestart(t)
	testAccessSwapManager(t, restarted)
	restored := mustTestAccessJWTKey(t, restarted)
	if !bytes.Equal(original, restored) {
		t.Fatal("the signing key changed across restart, so this test cannot isolate the lifetime rule")
	}

	now := time.Unix(testAccessJWTIssuedAt, 0)
	mint := func(lifetime time.Duration) string {
		return signTestAccessJWT(restored, testAccessJWTValidHeader, testAccessJWTPayloadWith(
			`"phi"`, strconv.FormatInt(now.Unix(), 10),
			strconv.FormatInt(now.Add(lifetime).Unix(), 10),
			`"`+testAccessJWTNonce+`"`, `"`+testAccessJWTRecordID+`"`,
			strconv.FormatUint(testAccessJWTEpoch, 10), `"`+testAccessJWTFamilyID+`"`))
	}
	if _, err := parseAccessJWT(restored, mint(accessJWTLifetime), now, accessJWTClockAllowance); err != nil {
		t.Fatalf("the documented lifetime was rejected under the restored key: %v", err)
	}
	for name, lifetime := range map[string]time.Duration{
		"one second over":     accessJWTLifetime + time.Second,
		"thirty seconds over": accessJWTLifetime + 30*time.Second,
		"one year":            365 * 24 * time.Hour,
	} {
		if _, err := parseAccessJWT(restored, mint(lifetime), now, accessJWTClockAllowance); err == nil {
			t.Errorf("%s lifetime accepted under the restored key", name)
		}
	}
}

// testAccessCommittedError is the error a strict replacement returns after its
// rename succeeded and only the directory sync that makes it durable failed.
func testAccessCommittedError(t *testing.T) error {
	t.Helper()
	return fmt.Errorf("%w: %w", system.ErrAtomicCommitted, errors.New("injected directory sync failure"))
}

// TestAccessConfigCommitCrossedRenameFollowsDurableRecord covers the boundary
// the strict writer reports as ambiguous rather than pre-commit: the Config
// rename happened, so v1 must follow the durable record, v2 must stop
// authorizing, and the caller still gets the fixed 500 with no credential.
func TestAccessConfigCommitCrossedRenameFollowsDurableRecord(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	token := testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.61:1")
	handle := testAccessRefreshHandle(t, login)
	before := loadConfig().AccessPasswordHash

	previous := writeConfigFile
	writeConfigFile = func(path string, data []byte, perm os.FileMode) error {
		// The rename lands: the destination really carries the new record, and
		// only its durability is unconfirmed.
		if err := previous(path, data, perm); err != nil {
			return err
		}
		return testAccessCommittedError(t)
	}
	t.Cleanup(func() { writeConfigFile = previous })

	body, err := json.Marshal(map[string]string{"password": "crossed-rename-pass"})
	if err != nil {
		t.Fatal(err)
	}
	w := testAccessV2PasswordRequest(t, string(body), token)
	writeConfigFile = previous

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("committed-but-unconfirmed record change = %d want 500 (body %q)", w.Code, w.Body.String())
	}
	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("unconfirmed commit issued %d cookies", len(cookies))
	}
	committed := loadConfig().AccessPasswordHash
	if committed == before {
		t.Fatal("the rename landed, so Config must carry the new record")
	}
	// v1 follows the durable record instead of the record this process held.
	auth.mu.Lock()
	adopted := auth.record
	auth.mu.Unlock()
	durable, err := parseAccessPasswordHash(committed)
	if err != nil {
		t.Fatal(err)
	}
	if adopted == nil || adopted.Verifier == nil || durable == nil {
		t.Fatalf("v1 record not adopted after a crossed Config rename")
	}
	if !bytes.Equal(adopted.Verifier, durable.Verifier) || !bytes.Equal(adopted.Salt, durable.Salt) {
		t.Error("v1 still authorizes against the pre-commit record")
	}
	// v2 stops authorizing: the family is not served from the old runtime.
	protected := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	protected.Header.Set("Authorization", "Bearer "+token)
	if got := testAccessServe(testAccessProtected().ServeHTTP, protected); got.Code != http.StatusUnauthorized {
		t.Errorf("old bearer after a crossed Config rename = %d want 401", got.Code)
	}
	if got := testAccessV2RefreshRequest(t, handle); got.Code != http.StatusInternalServerError {
		t.Errorf("old handle after a crossed Config rename = %d want 500", got.Code)
	}
}

// TestAccessStateCommitCrossedRenameStopsAuthorizing pins the other half of the
// same boundary: a state-only write that crossed its rename cannot be rolled
// back, so the memory copy must stop authorizing the family the disk just
// revoked.
func TestAccessStateCommitCrossedRenameStopsAuthorizing(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.62:1")
	handle := testAccessRefreshHandle(t, login)
	var loginBundle struct {
		Token string `json:"token"`
	}
	testAccessJSONBody(t, login, &loginBundle)
	if loginBundle.Token == "" {
		t.Fatal("login issued no access token")
	}
	token := loginBundle.Token

	accessAuth.mu.Lock()
	key, now := accessAuth.jwtKey, accessAuth.now()
	accessAuth.mu.Unlock()
	claims, err := parseAccessJWT(key, token, now, accessJWTClockAllowance)
	if err != nil {
		t.Fatalf("parse access token: %v", err)
	}
	before, err := loadAccessV2StateFile(accessV2StatePath())
	if err != nil {
		t.Fatalf("reload state: %v", err)
	}
	familiesBefore := len(before.Active.Families)

	previous := writeAccessV2StateFile
	writeAccessV2StateFile = func(path string, data []byte, perm os.FileMode) error {
		if err := previous(path, data, perm); err != nil {
			return err
		}
		return testAccessCommittedError(t)
	}
	body, err := json.Marshal(map[string]bool{"all": false})
	if err != nil {
		t.Fatal(err)
	}
	w := testAccessV2LogoutRequest(t, string(body), token)
	writeAccessV2StateFile = previous

	if w.Code == http.StatusOK {
		t.Fatalf("logout with an unconfirmed revocation reported success")
	}
	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("unconfirmed revocation issued %d cookies", len(cookies))
	}
	// The durable state dropped the family, so the in-memory copy must agree.
	state, err := loadAccessV2StateFile(accessV2StatePath())
	if err != nil {
		t.Fatalf("reload state: %v", err)
	}
	for _, family := range state.Active.Families {
		if family.ID == claims.FamilyID {
			t.Fatal("durable state still carries the logged-out family")
		}
	}
	if len(state.Active.Families) != familiesBefore-1 {
		t.Fatalf("durable families = %d want %d after logout", len(state.Active.Families), familiesBefore-1)
	}
	protected := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	protected.Header.Set("Authorization", "Bearer "+token)
	if got := testAccessServe(testAccessProtected().ServeHTTP, protected); got.Code != http.StatusUnauthorized {
		t.Errorf("revoked bearer still authorized: %d", got.Code)
	}
	if got := testAccessV2RefreshRequest(t, handle); got.Code == http.StatusOK {
		t.Error("revoked handle still refreshed")
	}
}

// TestAccessV2OutOfBandRevocationIsDurable covers the restart sequence the audit
// flagged: Config carries record A, an out-of-band edit makes it B, the process
// starts and stops, Config is restored to A, and the process starts again. The
// revocation has no journal entry and no expired family, so it only survives if
// reconciliation persists it instead of keeping it in memory.
func TestAccessV2OutOfBandRevocationIsDurable(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.231:1")
	handle := testAccessRefreshHandle(t, login)
	token := testAccessDecodeBundle(t, login).Token
	recordA := loadConfig().AccessPasswordHash
	familiesBefore := len(testAccessStateFile(t).Active.Families)
	if familiesBefore == 0 {
		t.Fatal("no family was recorded before the out-of-band edit")
	}

	other, err := newAccessPasswordRecord("an out-of-band password")
	if err != nil {
		t.Fatal(err)
	}
	if err := saveAccessPasswordHash(other.encoded()); err != nil {
		t.Fatalf("out-of-band config write: %v", err)
	}

	// Start under record B: the mismatch has to be persisted, not remembered.
	auth.owner.release()
	firstStart := testAccessRestart(t)
	recovered := testAccessStateFile(t)
	if recovered.Pending != nil {
		t.Fatal("a bare binding mismatch left a journal entry")
	}
	if len(recovered.Active.Families) != 0 {
		t.Fatalf("families after the binding-mismatch start = %d want 0 on disk", len(recovered.Active.Families))
	}
	if recovered.Active.RecordBinding != accessRecordBinding(other.encoded()) {
		t.Fatal("recovery did not bind the state to the record Config now carries")
	}
	firstStart.owner.release()

	// Restore record A and start again: the revocation must not have revived.
	if err := saveAccessPasswordHash(recordA); err != nil {
		t.Fatalf("restore config: %v", err)
	}
	secondStart := testAccessRestart(t)
	if families := testAccessStateFile(t).Active.Families; len(families) != 0 {
		t.Fatalf("restored record revived %d families", len(families))
	}
	testAccessSwapManager(t, secondStart)
	if w := testAccessV2RefreshRequest(t, handle); w.Code == http.StatusOK {
		t.Error("a revoked handle refreshed after the record was restored")
	}
	protected := testAccessProtected()
	bearer := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	bearer.Header.Set("Authorization", "Bearer "+token)
	if w := testAccessServe(protected.ServeHTTP, bearer); w.Code != http.StatusUnauthorized {
		t.Errorf("revoked bearer after the record was restored = %d want 401", w.Code)
	}
}

// TestAccessV2OutOfBandRevocationPersistFailureFaultsClosed pins the other half:
// a reset that cannot be written must not be admitted from, or the next start
// would revive the families the current process decided to drop.
func TestAccessV2OutOfBandRevocationPersistFailureFaultsClosed(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.232:1")
	handle := testAccessRefreshHandle(t, login)

	other, err := newAccessPasswordRecord("another out-of-band password")
	if err != nil {
		t.Fatal(err)
	}
	if err := saveAccessPasswordHash(other.encoded()); err != nil {
		t.Fatalf("out-of-band config write: %v", err)
	}

	previous := writeAccessV2StateFile
	writeAccessV2StateFile = func(string, []byte, os.FileMode) error {
		return errors.New("injected state write failure")
	}
	auth.owner.release()
	restarted := testAccessRestart(t)
	writeAccessV2StateFile = previous

	testAccessSwapManager(t, restarted)
	if w := testAccessV2RefreshRequest(t, handle); w.Code != http.StatusInternalServerError {
		t.Errorf("handle under an unwritable revocation = %d want 500", w.Code)
	}
}

// TestAccessV2OwnershipHandoffUsesCurrentRecordAndAdmitsSockets covers the
// handoff race and its socket side effect: the waiter read the record while the
// owner was still running, the owner then committed a new record and exited, and
// the recovered instance must activate the record on disk and publish a
// generation the socket fence will accept.
func TestAccessV2OwnershipHandoffUsesCurrentRecordAndAdmitsSockets(t *testing.T) {
	withTempConfig(t)
	owner := useTestAccessAuth(t)
	testAccessUseHub(t)

	testAccessEnableV2(t, testAccessPassword)
	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.233:1")
	staleToken := testAccessDecodeBundle(t, login).Token
	handle := testAccessRefreshHandle(t, login)

	// The waiter reads Config while the owner is still holding the lock.
	second := newAccessAuthManager()
	t.Cleanup(func() { second.owner.release() })
	if err := second.configure(loadConfig().AccessPasswordHash); err != nil {
		t.Fatalf("configure waiter: %v", err)
	}
	if second.ownedNow() {
		t.Fatal("waiter took ownership of a held lock")
	}

	// The owner commits a new record and exits.
	body, err := json.Marshal(map[string]string{"password": "handoff-pass-1234"})
	if err != nil {
		t.Fatal(err)
	}
	if w := testAccessV2PasswordRequest(t, string(body), staleToken); w.Code != http.StatusOK {
		t.Fatalf("owner password change = %d %s", w.Code, w.Body.String())
	}
	committed := loadConfig().AccessPasswordHash
	if committed == accessRecordBinding("") || committed == "" {
		t.Fatal("owner password change did not commit a record")
	}
	owner.owner.release()

	// The waiter runs its own hub, exactly like a separate process, and starts
	// with the fence at the generation it booted with.
	waiterHub := testAccessUseHub(t)
	waiterHub.RotateAuth(second.accessGeneration())
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, waiterHub)
	})
	server := httptest.NewServer(accessAuthMiddleware(mux))
	t.Cleanup(server.Close)
	socketURL := "ws" + strings.TrimPrefix(server.URL, "http")

	// The waiter recovers: it must adopt the committed record, not the one it
	// read before acquiring.
	if !second.ensureOwned() {
		t.Fatal("waiter did not recover ownership")
	}
	if w := testAccessV2RefreshRequest(t, handle); w.Code == http.StatusOK {
		t.Error("pre-handoff handle still refreshed after the owner changed the record")
	}
	testAccessSwapManager(t, second)
	if w := testAccessV2LoginRequest(t, "handoff-pass-1234", "192.0.2.234:1"); w.Code != http.StatusOK {
		t.Fatalf("login with the committed password after handoff = %d %s", w.Code, w.Body.String())
	}
	freshToken := testAccessDecodeBundle(t, testAccessV2LoginRequest(t, "handoff-pass-1234", "192.0.2.235:1")).Token
	if freshToken == "" {
		t.Fatal("login after handoff issued no token")
	}
	if loadConfig().AccessPasswordHash != committed {
		t.Fatal("handoff changed the durable record")
	}

	// A real upgrade must be admitted: the recovered owner publishes its
	// reconciled generation to the fence, so the gate does not compare against
	// the generation this process started with.
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.EventsSubprotocol}}
	url := socketURL + "/ws/md-events?token=" + neturl.QueryEscape(freshToken)
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("events upgrade after handoff: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	expectStillOpen(t, conn)

	stale, _, err := dialer.Dial(socketURL+"/ws/md-events?token="+neturl.QueryEscape(staleToken), nil)
	if err == nil {
		t.Cleanup(func() { _ = stale.Close() })
		expectClosed(t, stale)
	}
}
