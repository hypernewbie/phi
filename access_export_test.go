package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/internal/server"
	"github.com/hypernewbie/phi/pkg/ws"
)

// useTestAccessAuth installs a manager for the temp config store as the process
// manager and configures it as the state owner with auth disabled. Tests that
// need an active password seed one through setTestAccessRecord.
func useTestAccessAuth(t *testing.T) *access.Manager {
	t.Helper()
	previous := access.Default
	manager := access.NewManager(configStore, func() *ws.Hub { return server.Hub })
	access.Default = manager
	t.Cleanup(func() {
		manager.Close()
		access.Default = previous
	})
	if testConfigPath != "" {
		if err := manager.Configure(""); err != nil {
			t.Fatalf("configure test manager: %v", err)
		}
	}
	return manager
}

// setTestAccessRecord installs an encoded verifier as the active credential.
func setTestAccessRecord(manager *access.Manager, encoded string) error {
	return manager.ImportVerifier(encoded)
}

// testAccessHash builds a valid encoded verifier from synthetic bytes.
func testAccessHash() string {
	salt := bytes.Repeat([]byte{0x11}, 16)
	verifier := bytes.Repeat([]byte{0x22}, 32)
	return "v1.pbkdf2-sha256.600000." +
		base64.RawURLEncoding.EncodeToString(salt) + "." +
		base64.RawURLEncoding.EncodeToString(verifier)
}

// seedTestLegacyConfig writes a legacy config file holding the verifier that
// the first configure migrates into auth.db.
func seedTestLegacyConfig(t *testing.T, encoded string) {
	t.Helper()
	data, err := toml.Marshal(Config{AccessPasswordHash: encoded})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configFilePath(), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestAccessConfigExportHidesVerifierAndMigrationMetadata pins that the
// browser-facing config payload and the config export never carry the access
// verifier or the internal migration marker. Both live in auth.db after
// migration; leaking either would hand out credential material.
func TestAccessConfigExportHidesVerifierAndMigrationMetadata(t *testing.T) {
	withTempConfig(t)
	encoded := testAccessHash()
	seedTestLegacyConfig(t, encoded)
	useTestAccessAuth(t)
	marker := loadConfig().AccessAuthMigration
	if marker == nil || marker.State != "complete" {
		t.Fatalf("missing completed migration marker: %#v", marker)
	}

	for _, secret := range []string{"access_password_hash", "access_auth_migration", encoded, marker.ID} {
		if strings.Contains(configResponseBody(t), secret) {
			t.Fatalf("/api/config exposed %q", secret)
		}
	}

	exportResponse := httptest.NewRecorder()
	server.HandleConfigExport(exportResponse, httptest.NewRequest(http.MethodGet, "/api/config/export", nil))
	var exported struct {
		Config string `json:"config"`
	}
	if err := json.Unmarshal(exportResponse.Body.Bytes(), &exported); err != nil {
		t.Fatal(err)
	}
	payload, err := server.DecodeConfigData(exported.Config, "PHICONFIG")
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"access_password_hash", "access_auth_migration", encoded, marker.ID} {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("config export exposed %q", secret)
		}
	}
}

func configResponseBody(t *testing.T) string {
	t.Helper()
	w := httptest.NewRecorder()
	server.HandleConfig(w, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("/api/config status = %d", w.Code)
	}
	return w.Body.String()
}

// testAccessProof computes the challenge proof the browser computes, for the
// synthetic verifier testAccessHash builds. Root tests that drive the login
// endpoint need it; access keeps the production verifier parsing private.
func testAccessProof(verifier []byte, challenge string) string {
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte(challenge))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// loginTestCookie logs in through the real endpoint with the synthetic
// verifier and returns the session cookie. Tests that need an authenticated
// request use it instead of minting sessions directly.
func loginTestCookie(t *testing.T) *http.Cookie {
	t.Helper()
	statusW := httptest.NewRecorder()
	access.HandleAccessAuthStatus(statusW, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	var status map[string]any
	if err := json.Unmarshal(statusW.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	challenge, ok := status["challenge"].(string)
	if !ok || challenge == "" {
		t.Fatalf("/api/auth/status returned no challenge: %s", statusW.Body.String())
	}
	verifier := bytes.Repeat([]byte{0x22}, 32)
	loginBody := `{"challenge":"` + challenge + `","proof":"` + testAccessProof(verifier, challenge) + `"}`
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(loginBody))
	loginReq.RemoteAddr = "192.0.2.21:12345"
	loginW := httptest.NewRecorder()
	access.HandleAccessAuthLogin(loginW, loginReq)
	if loginW.Code != http.StatusOK {
		t.Fatalf("login: got %d body=%s", loginW.Code, loginW.Body.String())
	}
	cookies := loginW.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("login returned no session cookie")
	}
	return cookies[0]
}
