package phic

import (
	"crypto/sha256"

	"golang.org/x/crypto/pbkdf2"
)

// pbkdf2SHA256 derives a key with PBKDF2-HMAC-SHA256. The
// server uses the same construction; the verifier length is
// fixed at 32 bytes.
func pbkdf2SHA256(password string, salt []byte, iter, keyLen int) ([]byte, error) {
	return pbkdf2.Key([]byte(password), salt, iter, keyLen, sha256.New), nil
}
