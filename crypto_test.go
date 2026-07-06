package main

import (
	"testing"
)

func TestCryptoVault(t *testing.T) {
	original := "secret_password_123!"
	encrypted, err := EncryptVault(original)
	if err != nil {
		t.Fatalf("EncryptVault failed: %v", err)
	}
	if encrypted == "" {
		t.Fatalf("EncryptVault returned empty string")
	}
	if encrypted == original {
		t.Fatalf("EncryptVault returned plain text")
	}

	decrypted, err := DecryptVault(encrypted)
	if err != nil {
		t.Fatalf("DecryptVault failed: %v", err)
	}
	if decrypted != original {
		t.Fatalf("DecryptVault returned %q, expected %q", decrypted, original)
	}

	// Test empty
	emptyEnc, err := EncryptVault("")
	if err != nil || emptyEnc != "" {
		t.Fatalf("EncryptVault empty failed")
	}
	emptyDec, err := DecryptVault("")
	if err != nil || emptyDec != "" {
		t.Fatalf("DecryptVault empty failed")
	}

	// Test tampered payload
	_, err = DecryptVault("invalid_base64_payload!!!")
	if err == nil {
		t.Fatalf("Expected error for invalid base64")
	}
}
