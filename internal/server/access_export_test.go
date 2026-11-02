package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/hypernewbie/phi/internal/config"
)

// useTestAccessAuth installs a manager for the temp config store as the process
// manager and configures it as the state owner with auth disabled. Tests that
// need an active password seed one through setTestAccessRecord.
// seedTestLegacyConfig writes a legacy config file holding the verifier that
// the first configure migrates into auth.db.
func seedTestLegacyConfig(t *testing.T, encoded string) {
	t.Helper()
	data, err := toml.Marshal(config.Config{AccessPasswordHash: encoded})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(testServer.configFilePath(), data, 0o600); err != nil {
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
	marker := testServer.loadConfig().AccessAuthMigration
	if marker == nil || marker.State != "complete" {
		t.Fatalf("missing completed migration marker: %#v", marker)
	}

	for _, secret := range []string{"access_password_hash", "access_auth_migration", encoded, marker.ID} {
		if strings.Contains(configResponseBody(t), secret) {
			t.Fatalf("/api/config exposed %q", secret)
		}
	}

	exportResponse := httptest.NewRecorder()
	testServer.handleConfigExport(exportResponse, httptest.NewRequest(http.MethodGet, "/api/config/export", nil))
	var exported struct {
		Config string `json:"config"`
	}
	if err := json.Unmarshal(exportResponse.Body.Bytes(), &exported); err != nil {
		t.Fatal(err)
	}
	payload, err := DecodeConfigData(exported.Config, "PHICONFIG")
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
	testServer.handleConfig(w, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("/api/config status = %d", w.Code)
	}
	return w.Body.String()
}

// testAccessProof computes the challenge proof the browser computes, for the
// synthetic verifier testAccessHash builds. Root tests that drive the login
// endpoint need it; access keeps the production verifier parsing private.
