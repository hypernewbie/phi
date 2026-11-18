// Package phiaccess computes the client side of Phi's access login.
//
// The password never crosses the wire. The server's /api/auth/status
// publishes a KDF (pbkdf2-sha256), salt, and one-time challenge; the
// client derives a verifier locally and answers with
// base64url(HMAC-SHA256(verifier, challenge)). One implementation is
// shared by phic and phi-cmd so the two clients cannot drift.
package phiaccess

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"

	"golang.org/x/crypto/pbkdf2"
)

// Status mirrors GET /api/auth/status.
type Status struct {
	Enabled       bool   `json:"enabled"`
	Authenticated bool   `json:"authenticated"`
	Version       string `json:"version,omitempty"`
	Algorithm     string `json:"algorithm,omitempty"`
	Iterations    int    `json:"iterations,omitempty"`
	Salt          string `json:"salt,omitempty"`
	Challenge     string `json:"challenge,omitempty"`
}

// maxSalt bounds the base64 salt length before decoding; the value
// matches the server's own limit (phic enforced len(salt) <= 128).
const maxSalt = 128

// Verifier derives the 32-byte verifier from the password and the
// status's salt/algorithm/iterations.
func Verifier(password string, status Status) ([]byte, error) {
	if status.Algorithm != "pbkdf2-sha256" {
		return nil, fmt.Errorf("phiaccess: unsupported KDF %q", status.Algorithm)
	}
	if status.Iterations <= 0 || status.Iterations > 1_000_000 {
		return nil, fmt.Errorf("phiaccess: bad iteration count %d", status.Iterations)
	}
	if len(status.Salt) > maxSalt {
		return nil, fmt.Errorf("phiaccess: malformed salt")
	}
	salt, err := base64.RawURLEncoding.DecodeString(status.Salt)
	if err != nil {
		return nil, fmt.Errorf("phiaccess: bad salt: %w", err)
	}
	return pbkdf2.Key([]byte(password), salt, status.Iterations, 32, sha256.New), nil
}

// Proof derives the verifier and returns the base64url HMAC answer for
// the status's one-time challenge. The caller must send it to
// /api/auth/login exactly once; the challenge is single-use.
func Proof(password string, status Status) (string, error) {
	if len(status.Challenge) == 0 || len(status.Challenge) > 4096 {
		return "", fmt.Errorf("phiaccess: missing or oversized challenge")
	}
	verifier, err := Verifier(password, status)
	if err != nil {
		return "", err
	}
	defer clear(verifier)
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte(status.Challenge))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// ValidateChallenge checks the status carries a usable v1 challenge
// before any proof work. It mirrors phic's shape checks.
func ValidateChallenge(status Status) error {
	if !status.Enabled {
		return nil
	}
	if status.Version != "v1" || len(status.Salt) > maxSalt ||
		len(status.Challenge) == 0 || len(status.Challenge) > 4096 {
		return fmt.Errorf("phiaccess: unsupported or malformed login challenge")
	}
	return nil
}
