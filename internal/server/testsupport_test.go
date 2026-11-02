package server

import (
	"os"
	"path/filepath"
	"testing"

	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/ws"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"time"
)

// testStore is the config store the handler tests read and write.
var testStore *config.Store
var testServer = New(Options{})

type Config = config.Config
type QuickCommand = config.QuickCommand
type ModelPresetsMap = config.ModelPresetsMap
type PeerConfig = config.PeerConfig

// withTempConfig points the package at a fresh config file.
func withTempConfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	previous, previousServer := testStore, testServer
	testStore = config.NewStore(config.Paths{Primary: path}, nil)
	testServer = New(Options{Config: testStore, Version: "dev", Commit: "none", Date: "unknown", BuildSource: "source"})
	t.Cleanup(func() { testStore, testServer = previous, previousServer })
	return path
}

// testConfigPath reports the active temp config path.
func testConfigPathValue() string {
	if testStore == nil {
		return ""
	}
	return testStore.PrimaryPath()
}

// testMainShell returns a quiet interactive shell for PTY fixtures.
func testMainShell() (string, []string) {
	if runtime.GOOS == "windows" {
		return "pwsh", []string{"-NoLogo", "-NoProfile", "-NonInteractive"}
	}
	return "bash", []string{"--norc", "--noprofile"}
}

// withTempBackends points the custom-backend scan at a fresh temp dir.
func withTempBackends(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	orig := testServer.testCustomBackendsDir
	testServer.testCustomBackendsDir = dir
	t.Cleanup(func() { testServer.testCustomBackendsDir = orig })
	return dir
}

// withTempConfigAt points the config store at an explicit temp path, so a
// test can recreate the store between assertions.
func withTempConfigAt(t *testing.T, path string) {
	t.Helper()
	previous, previousServer := testStore, testServer
	testStore = config.NewStore(config.Paths{Primary: path}, nil)
	testServer = New(Options{Config: testStore, Version: "dev", Commit: "none", Date: "unknown", BuildSource: "source"})
	t.Cleanup(func() { testStore, testServer = previous, previousServer })
}

// testPaneShutdownGrace is the grace test panes get before Shutdown escalates.
const testPaneShutdownGrace = 100 * time.Millisecond

// useTestAccessAuth installs a fresh access manager wired to the test store.
func useTestAccessAuth(t *testing.T) *access.Manager {
	t.Helper()
	previous := testServer.accessManager
	manager := access.NewManager(testServer.configStore, func() *ws.Hub { return testServer.hub })
	testServer.accessManager = manager
	t.Cleanup(func() {
		manager.Close()
		testServer.accessManager = previous
	})
	if testStore != nil {
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

// testAccessProof answers a login challenge with the synthetic verifier.
func testAccessProof(verifier []byte, challenge string) string {
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte(challenge))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// readPrimaryConfig reads the store the way the migration code does.
func readPrimaryConfig() (config.Config, bool, error) {
	if testStore == nil {
		panic("server test used readPrimaryConfig without withTempConfig")
	}
	return testStore.ReadStored()
}

// loginTestCookie logs in through the real endpoint with the synthetic
// verifier and returns the session cookie.
func loginTestCookie(t *testing.T) *http.Cookie {
	t.Helper()
	statusW := httptest.NewRecorder()
	testServer.accessManager.HandleAccessAuthStatus(statusW, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
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
	testServer.accessManager.HandleAccessAuthLogin(loginW, loginReq)
	if loginW.Code != http.StatusOK {
		t.Fatalf("login: got %d body=%s", loginW.Code, loginW.Body.String())
	}
	cookies := loginW.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("login returned no session cookie")
	}
	return cookies[0]
}
