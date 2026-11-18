package phiaccess

import (
	"encoding/base64"
	"testing"

	"crypto/hmac"
	"crypto/sha256"
	"golang.org/x/crypto/pbkdf2"
)

// The construction is fixed by the server: pbkdf2-sha256, 32-byte
// verifier, HMAC-SHA256 over the raw challenge, base64url no-padding.
// This test pins it against an independently computed vector.
func TestProofKnownVector(t *testing.T) {
	status := Status{
		Enabled:    true,
		Version:    "v1",
		Algorithm:  "pbkdf2-sha256",
		Iterations: 1000,
		Salt:       base64.RawURLEncoding.EncodeToString([]byte("phi-salt")),
		Challenge:  "one-time-challenge",
	}
	got, err := Proof("correct horse battery staple", status)
	if err != nil {
		t.Fatalf("proof: %v", err)
	}

	verifier := pbkdf2.Key([]byte("correct horse battery staple"), []byte("phi-salt"), 1000, 32, sha256.New)
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte("one-time-challenge"))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if got != want {
		t.Fatalf("proof mismatch:\n got %s\nwant %s", got, want)
	}
}

func TestProofRejectsBadKDF(t *testing.T) {
	cases := []Status{
		{Enabled: true, Version: "v1", Algorithm: "argon2", Iterations: 1000, Salt: "c2FsdA", Challenge: "c"},
		{Enabled: true, Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 0, Salt: "c2FsdA", Challenge: "c"},
		{Enabled: true, Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 1_000_001, Salt: "c2FsdA", Challenge: "c"},
		{Enabled: true, Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 1000, Salt: "!!!not-base64!!!", Challenge: "c"},
		{Enabled: true, Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 1000, Salt: "c2FsdA", Challenge: ""},
	}
	for i, status := range cases {
		if _, err := Proof("pw", status); err == nil {
			t.Errorf("case %d: expected error", i)
		}
	}
}

func TestValidateChallenge(t *testing.T) {
	if err := ValidateChallenge(Status{Enabled: false}); err != nil {
		t.Fatalf("disabled auth must not need a challenge: %v", err)
	}
	good := Status{Enabled: true, Version: "v1", Algorithm: "pbkdf2-sha256", Iterations: 10, Salt: "c2FsdA", Challenge: "c"}
	if err := ValidateChallenge(good); err != nil {
		t.Fatalf("good challenge rejected: %v", err)
	}
	good.Version = "v2"
	if err := ValidateChallenge(good); err == nil {
		t.Fatal("unknown version accepted")
	}
}
