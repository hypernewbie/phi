package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/hypernewbie/phi/pkg/system"
)

// The Kanban vault holds one password: the one for the Vikunja instance.
//
// Its key belongs to the machine, not to the program. A key that ships
// inside the binary is not a secret - anyone with the binary could decrypt
// every saved password - so the key lives in a 0600 file next to the config.
// The key that older builds used is still accepted for READING, so an
// existing vault keeps working; the first successful read re-encrypts it
// with the machine key.

const vaultKeyFile = "kanban-vault.key"

// legacyVaultKey is the key that shipped inside the binary. It is accepted
// for reading only, and every vault it can open is migrated on the spot.
var legacyVaultKey = []byte("PhiKanbanLocalVaultKey32Bytes!!!")

// vaultSecret is a decrypted password and the ciphertext that should
// replace it. Reencrypted is empty when the machine key already opened it.
type vaultSecret struct {
	Plaintext   string
	Reencrypted string
}

// vaultKeyPath is the machine key file: next to the config when there is
// one, else in phi's state directory.
func (app *Server) vaultKeyPath() string {
	if store := app.configStore(); store != nil {
		if primary := store.PrimaryPath(); primary != "" {
			return filepath.Join(filepath.Dir(primary), vaultKeyFile)
		}
	}
	return filepath.Join(system.PhiDataDir(), vaultKeyFile)
}

// vaultKey returns the machine's own key, creating it on first use.
func (app *Server) vaultKey() ([]byte, error) {
	path := app.vaultKeyPath()
	raw, err := os.ReadFile(path)
	if err == nil {
		if len(raw) != 32 {
			return nil, fmt.Errorf("the vault key file is malformed")
		}
		return raw, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	// Write through a temporary file so a crash never leaves a half key.
	tmp := fmt.Sprintf("%s.tmp-%d", path, os.Getpid())
	if err := os.WriteFile(tmp, key, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	return key, nil
}

// sealVault encrypts one password under one key.
func sealVault(key []byte, plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// openVault decrypts one password under one key.
func openVault(key []byte, encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", errors.New("ciphertext too short")
	}
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// encryptVault seals one password under the machine key.
func (app *Server) encryptVault(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	key, err := app.vaultKey()
	if err != nil {
		return "", err
	}
	return sealVault(key, plaintext)
}

// decryptVault opens one password. A vault written before the machine key
// existed still opens; the returned Reencrypted value is the ciphertext that
// should replace it.
func (app *Server) decryptVault(encoded string) (vaultSecret, error) {
	if encoded == "" {
		return vaultSecret{}, nil
	}
	key, keyErr := app.vaultKey()
	if keyErr == nil {
		if plaintext, err := openVault(key, encoded); err == nil {
			return vaultSecret{Plaintext: plaintext}, nil
		}
	}
	// The legacy key still opens an old vault: the machine key is new, but
	// the password is not. The vault is re-encrypted on the spot.
	if plaintext, err := openVault(legacyVaultKey, encoded); err == nil {
		secret := vaultSecret{Plaintext: plaintext}
		if keyErr == nil {
			if migrated, err := sealVault(key, plaintext); err == nil {
				secret.Reencrypted = migrated
			}
		}
		return secret, nil
	}
	if keyErr != nil {
		return vaultSecret{}, keyErr
	}
	return vaultSecret{}, errors.New("the saved Kanban password could not be read")
}
