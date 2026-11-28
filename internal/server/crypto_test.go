package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The vault key belongs to the machine: a key that ships inside the binary
// is not a secret, so it lives in a 0600 file next to the config.
func TestCryptoVault(t *testing.T) {
	withTempConfig(t)
	original := "secret_password_123!"
	encrypted, err := testServer.encryptVault(original)
	if err != nil {
		t.Fatalf("encryptVault failed: %v", err)
	}
	if encrypted == "" {
		t.Fatalf("encryptVault returned empty string")
	}
	if encrypted == original {
		t.Fatalf("encryptVault returned plain text")
	}

	secret, err := testServer.decryptVault(encrypted)
	if err != nil {
		t.Fatalf("decryptVault failed: %v", err)
	}
	if secret.Plaintext != original {
		t.Fatalf("decryptVault returned %q, expected %q", secret.Plaintext, original)
	}
	// A vault written with the machine key needs no migration.
	if secret.Reencrypted != "" {
		t.Errorf("a machine-key vault should not ask for a migration")
	}

	// The key file lives next to the config and is readable only by its owner.
	keyPath := testServer.vaultKeyPath()
	if filepath.Base(keyPath) != vaultKeyFile {
		t.Errorf("unexpected key file name %q", keyPath)
	}
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("the machine key file is missing: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Errorf("the machine key file is readable by others: %v", info.Mode().Perm())
	}
}

// A vault written before the machine key existed still opens, and it is
// re-encrypted with the machine key on the spot.
func TestCryptoVaultMigratesLegacyKey(t *testing.T) {
	withTempConfig(t)
	legacy, err := sealVault(legacyVaultKey, "old_password")
	if err != nil {
		t.Fatal(err)
	}
	secret, err := testServer.decryptVault(legacy)
	if err != nil {
		t.Fatalf("a legacy vault must still open: %v", err)
	}
	if secret.Plaintext != "old_password" {
		t.Fatalf("legacy vault returned %q", secret.Plaintext)
	}
	if secret.Reencrypted == "" {
		t.Fatal("a legacy vault must ask for a migration")
	}
	migrated, err := testServer.decryptVault(secret.Reencrypted)
	if err != nil {
		t.Fatalf("the migrated vault must open: %v", err)
	}
	if migrated.Plaintext != "old_password" {
		t.Fatalf("the migrated vault returned %q", migrated.Plaintext)
	}
	if migrated.Reencrypted != "" {
		t.Errorf("the migrated vault must not ask for another migration")
	}
}

// The key never ships with the program.
func TestCryptoVaultKeyIsNotTheLegacyConstant(t *testing.T) {
	withTempConfig(t)
	encrypted, err := testServer.encryptVault("secret")
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := sealVault(legacyVaultKey, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if encrypted == legacy {
		t.Error("the vault is still sealed with the key that ships in the binary")
	}
	if strings.Contains(encrypted, "PhiKanbanLocalVaultKey") {
		t.Error("the legacy key leaked into the vault")
	}
}

// Test empty
func TestCryptoVaultEmpty(t *testing.T) {
	withTempConfig(t)
	emptyEnc, err := testServer.encryptVault("")
	if err != nil || emptyEnc != "" {
		t.Fatalf("encryptVault empty failed")
	}
	secret, err := testServer.decryptVault("")
	if err != nil || secret.Plaintext != "" {
		t.Fatalf("decryptVault empty failed")
	}
}

// Test tampered payload
func TestCryptoVaultRejectsGarbage(t *testing.T) {
	withTempConfig(t)
	if _, err := testServer.decryptVault("invalid_base64_payload!!!"); err == nil {
		t.Fatalf("Expected error for invalid base64")
	}
}
