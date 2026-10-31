package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"

	"github.com/BurntSushi/toml"
)

func failAccessDBCommitForTest(t *testing.T, auth *accessAuthManager) func() {
	t.Helper()
	auth.mu.Lock()
	if auth.db == nil {
		auth.mu.Unlock()
		t.Fatal("auth database is unavailable")
	}
	previous := auth.db.commit
	auth.db.commit = func(*sql.Tx) error { return errors.New("injected database commit failure") }
	auth.mu.Unlock()
	restored := false
	restore := func() {
		if restored {
			return
		}
		auth.mu.Lock()
		if auth.db != nil {
			auth.db.commit = previous
		}
		auth.mu.Unlock()
		restored = true
	}
	t.Cleanup(restore)
	return restore
}

func TestAccessRollbackGuard(t *testing.T) {
	t.Run("permits only an unmigrated home and retains the lock", func(t *testing.T) {
		withTempConfig(t)
		seedTestLegacyConfig(t, testAccessHash())
		release, err := acquireAccessRollbackGuard()
		if err != nil {
			t.Fatalf("pre-migration rollback guard: %v", err)
		}
		var contender accessStateLock
		if contender.tryAcquire(accessV2LockPath()) {
			contender.release()
			t.Fatal("rollback guard did not retain the stable lock")
		}
		release()
	})

	t.Run("refuses a running owner", func(t *testing.T) {
		withTempConfig(t)
		var owner accessStateLock
		if !owner.tryAcquire(accessV2LockPath()) {
			t.Fatal("test owner failed to acquire auth lock")
		}
		defer owner.release()
		if release, err := acquireAccessRollbackGuard(); err == nil {
			release()
			t.Fatal("rollback guard accepted a running owner")
		}
	})

	for _, statePath := range []struct {
		name string
		path func() string
	}{
		{name: "auth database", path: accessDBPath},
		{name: "legacy session state", path: accessV2StatePath},
	} {
		t.Run("refuses "+statePath.name, func(t *testing.T) {
			withTempConfig(t)
			if err := os.WriteFile(statePath.path(), []byte("synthetic"), 0o600); err != nil {
				t.Fatal(err)
			}
			if release, err := acquireAccessRollbackGuard(); err == nil {
				release()
				t.Fatalf("rollback guard accepted existing %s", statePath.name)
			}
		})
	}

	for _, markerState := range []string{"pending", "complete"} {
		t.Run("refuses "+markerState+" migration marker", func(t *testing.T) {
			withTempConfig(t)
			cfg := Config{AccessAuthMigration: &accessAuthMigrationMarker{
				State: markerState,
				ID:    base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
			}}
			raw, err := toml.Marshal(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(configFilePath(), raw, 0o600); err != nil {
				t.Fatal(err)
			}
			if release, err := acquireAccessRollbackGuard(); err == nil {
				release()
				t.Fatalf("rollback guard accepted %s migration marker", markerState)
			}
		})
	}

	t.Run("refuses malformed migration metadata", func(t *testing.T) {
		withTempConfig(t)
		if err := os.WriteFile(configFilePath(), []byte("[access_auth_migration]\nstate = \"complete\"\nid = \"bad\"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if release, err := acquireAccessRollbackGuard(); err == nil {
			release()
			t.Fatal("rollback guard accepted malformed migration metadata")
		}
	})

	t.Run("refuses malformed Config", func(t *testing.T) {
		withTempConfig(t)
		if err := os.WriteFile(configFilePath(), []byte("broken = [\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if release, err := acquireAccessRollbackGuard(); err == nil {
			release()
			t.Fatal("rollback guard accepted malformed Config")
		}
	})
}

func writeLegacyAccessStateForTest(t *testing.T, state *accessV2StateFile) {
	t.Helper()
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(accessV2StatePath(), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func legacyAccessStateForTest(t *testing.T, encoded string) *accessV2StateFile {
	t.Helper()
	active, _, err := accessDBTestState()
	if err != nil {
		t.Fatal(err)
	}
	active.RecordBinding = accessRecordBinding(encoded)
	return &accessV2StateFile{Version: accessV2StateVersion, Active: active}
}

func TestAccessMigrationFreshInstallAndVerifierImport(t *testing.T) {
	t.Run("fresh disabled install", func(t *testing.T) {
		withTempConfig(t)
		auth := useTestAccessAuth(t)
		if got := testAccessDBPasswordRecord(t); got != "" {
			t.Fatalf("fresh database verifier = %q", got)
		}
		if auth.record != nil || !auth.v2Available {
			t.Fatalf("fresh auth state = record:%v v2Available:%v", auth.record, auth.v2Available)
		}
		cfg := loadConfig()
		if cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" {
			t.Fatalf("fresh Config migration state = %#v", cfg.AccessAuthMigration)
		}
		if _, err := os.Lstat(accessV2StatePath()); !os.IsNotExist(err) {
			t.Fatalf("fresh migration retained legacy state path: %v", err)
		}
	})

	t.Run("legacy verifier only", func(t *testing.T) {
		withTempConfig(t)
		seedTestLegacyConfig(t, testAccessHash())
		auth := useTestAccessAuth(t)
		if got := testAccessDBPasswordRecord(t); got != testAccessHash() {
			t.Fatalf("imported database verifier = %q", got)
		}
		if auth.record == nil || !auth.v2Available {
			t.Fatalf("imported auth state = record:%v v2Available:%v", auth.record, auth.v2Available)
		}
		if state := testAccessStateFile(t); state.Active.RecordBinding != accessRecordBinding(testAccessHash()) || len(state.Active.Families) != 0 {
			t.Fatalf("verifier-only migration state = %+v", state.Active)
		}
		cfg := loadConfig()
		if cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" {
			t.Fatalf("imported Config migration state = %#v", cfg.AccessAuthMigration)
		}
	})
}

func seedCompletedJSONAccessHome(t *testing.T, configID, databaseID [16]byte) (string, string, []byte, accessDBState) {
	t.Helper()
	primary := withTempConfig(t)
	if err := os.Remove(primary); err != nil {
		t.Fatal(err)
	}
	legacyPath := withTempLegacyConfig(t)
	active, _, err := accessDBTestState()
	if err != nil {
		t.Fatal(err)
	}
	encoded := testAccessHash()
	active.RecordBinding = accessRecordBinding(encoded)
	state := accessDBState{PasswordRecord: encoded, MigrationID: databaseID, V2Available: true, Active: active}
	store, err := openAccessDB(accessDBPath(), true)
	if err != nil {
		t.Fatal(err)
	}
	store.migrationID = databaseID
	if err := store.initialize(state); err != nil {
		store.close()
		t.Fatal(err)
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	config := Config{
		ThemeColor:    "violet",
		QuickCommands: []QuickCommand{{Name: "fixture", Command: "printf fixture"}},
		AccessAuthMigration: &accessAuthMigrationMarker{
			State: "complete",
			ID:    base64.RawURLEncoding.EncodeToString(configID[:]),
		},
	}
	legacyBytes, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPath, legacyBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return primary, legacyPath, legacyBytes, state
}

func TestAccessMigrationCompletedLegacyJSONConvertsAfterDatabaseVerification(t *testing.T) {
	_, databaseID, err := accessDBTestState()
	if err != nil {
		t.Fatal(err)
	}
	primary, legacyPath, legacyBytes, want := seedCompletedJSONAccessHome(t, databaseID, databaseID)
	manager := newAccessAuthManager()
	t.Cleanup(func() { manager.close() })
	if err := manager.configure(""); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, legacyPath); !reflect.DeepEqual(got, legacyBytes) {
		t.Fatalf("legacy JSON changed: got %q want %q", got, legacyBytes)
	}
	cfg, present, err := readPrimaryConfig()
	if err != nil || !present {
		t.Fatalf("completed migration did not create TOML: present=%v err=%v", present, err)
	}
	if cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" || cfg.AccessAuthMigration.ID != base64.RawURLEncoding.EncodeToString(databaseID[:]) {
		t.Fatalf("converted TOML migration state = %+v", cfg.AccessAuthMigration)
	}
	if cfg.ThemeColor != "violet" || len(cfg.QuickCommands) != 1 || cfg.QuickCommands[0].Name != "fixture" {
		t.Fatalf("converted TOML lost operator settings: %+v", cfg)
	}
	if strings.Contains(string(mustRead(t, primary)), "access_password_hash") {
		t.Fatal("converted TOML retained the verifier key")
	}
	got, err := manager.db.verify(databaseID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PasswordRecord != want.PasswordRecord || !reflect.DeepEqual(got.Active, want.Active) {
		t.Fatal("completed JSON conversion changed the verified database state")
	}
}

func TestAccessMigrationCompletedLegacyJSONDoesNotConvertOnDatabaseMismatch(t *testing.T) {
	_, databaseID, err := accessDBTestState()
	if err != nil {
		t.Fatal(err)
	}
	var mismatchedID [16]byte
	primary, legacyPath, legacyBytes, _ := seedCompletedJSONAccessHome(t, mismatchedID, databaseID)
	manager := newAccessAuthManager()
	if err := manager.configure(""); err == nil {
		manager.close()
		t.Fatal("completed JSON with a mismatched database was accepted")
	}
	manager.close()
	if _, err := os.Lstat(primary); !os.IsNotExist(err) {
		t.Fatalf("mismatched database created TOML: %v", err)
	}
	if got := mustRead(t, legacyPath); !reflect.DeepEqual(got, legacyBytes) {
		t.Fatalf("mismatched migration changed legacy JSON: got %q want %q", got, legacyBytes)
	}
}

func TestAccessMigrationImportsLegacySessionsAndConsumedHandles(t *testing.T) {
	withTempConfig(t)
	encoded := testAccessHash()
	seedTestLegacyConfig(t, encoded)
	legacy := legacyAccessStateForTest(t, encoded)
	writeLegacyAccessStateForTest(t, legacy)
	auth := useTestAccessAuth(t)
	got := testAccessStateFile(t)
	if !reflect.DeepEqual(got.Active, legacy.Active) {
		t.Fatalf("imported legacy active state differs:\n got: %+v\nwant: %+v", got.Active, legacy.Active)
	}
	if got.Active.Families[0].Consumed[0].Digest != legacy.Active.Families[0].Consumed[0].Digest {
		t.Fatal("consumed handle evidence was not imported")
	}
	if !auth.v2Available || testAccessDBPasswordRecord(t) != encoded {
		t.Fatal("legacy verifier/session migration did not become authoritative")
	}
	if _, err := os.Lstat(accessV2StatePath()); !os.IsNotExist(err) {
		t.Fatalf("successful migration retained legacy state: %v", err)
	}
}

func TestAccessMigrationRejectsNoncanonicalLegacyEncodingsKeepsV1(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*accessV2ActiveState)
	}{
		{
			name: "refresh key with escaped newline",
			mutate: func(active *accessV2ActiveState) {
				key := *active.RefreshKey + "\n"
				active.RefreshKey = &key
			},
		},
		{
			name: "uppercase consumed digest",
			mutate: func(active *accessV2ActiveState) {
				active.Families[0].Consumed[0].Digest = strings.ToUpper(active.Families[0].Consumed[0].Digest)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withTempConfig(t)
			encoded := testAccessHash()
			seedTestLegacyConfig(t, encoded)
			legacy := legacyAccessStateForTest(t, encoded)
			tc.mutate(&legacy.Active)
			writeLegacyAccessStateForTest(t, legacy)

			auth := useTestAccessAuth(t)
			if auth.record == nil || auth.v2Available {
				t.Fatalf("noncanonical legacy state = record:%v v2Available:%v", auth.record, auth.v2Available)
			}
			if got := testAccessDBPasswordRecord(t); got != encoded {
				t.Fatalf("migration discarded the configured verifier: %q", got)
			}
			active := testAccessStateFile(t).Active
			if active.RecordBinding != accessRecordBinding(encoded) || active.RecordID != "" || active.RefreshKey != nil || len(active.Families) != 0 {
				t.Fatalf("noncanonical legacy state was not reduced to a safe base: %+v", active)
			}
			cfg := loadConfig()
			if cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" {
				t.Fatalf("noncanonical legacy migration did not complete safely: %#v", cfg)
			}
		})
	}
}

func TestAccessMigrationReconcilesLegacyPendingBindings(t *testing.T) {
	for _, tc := range []struct {
		name        string
		configured  string
		wantBinding string
		wantFamily  bool
	}{
		{name: "candidate committed", configured: "candidate", wantBinding: "candidate"},
		{name: "old verifier retained", configured: "old", wantBinding: "old", wantFamily: true},
		{name: "neither verifier matches", configured: "neither", wantBinding: "neither"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withTempConfig(t)
			oldRecord := testAccessHash()
			candidateRecord, err := newAccessPasswordRecord("candidate migration password")
			if err != nil {
				t.Fatal(err)
			}
			neitherRecord, err := newAccessPasswordRecord("unrelated migration password")
			if err != nil {
				t.Fatal(err)
			}
			configured := map[string]string{"old": oldRecord, "candidate": candidateRecord.encoded(), "neither": neitherRecord.encoded()}[tc.configured]
			want := map[string]string{"old": oldRecord, "candidate": candidateRecord.encoded(), "neither": neitherRecord.encoded()}[tc.wantBinding]
			seedTestLegacyConfig(t, configured)
			legacy := legacyAccessStateForTest(t, oldRecord)
			next := accessRevokedState(legacy.Active, accessRecordBinding(candidateRecord.encoded()))
			legacy.Pending = &accessV2Pending{
				FromRecordBinding: accessRecordBinding(oldRecord),
				PasswordRecord:    candidateRecord.encoded(),
				Next:              next,
			}
			writeLegacyAccessStateForTest(t, legacy)

			useTestAccessAuth(t)
			state := testAccessStateFile(t).Active
			if state.RecordBinding != accessRecordBinding(want) {
				t.Fatalf("reconciled binding = %s want %s", state.RecordBinding, accessRecordBinding(want))
			}
			if got := len(state.Families) != 0; got != tc.wantFamily {
				t.Fatalf("family presence = %v want %v", got, tc.wantFamily)
			}
			if testAccessDBPasswordRecord(t) != configured {
				t.Fatal("migration changed the configured legacy verifier")
			}
		})
	}
}

func TestAccessMigrationSemanticallyCorruptLegacyStateKeepsV1(t *testing.T) {
	withTempConfig(t)
	encoded := testAccessHash()
	seedTestLegacyConfig(t, encoded)
	legacy := legacyAccessStateForTest(t, encoded)
	legacy.Active.Families[0].ActiveDigest = strings.Repeat("f", 64)
	writeLegacyAccessStateForTest(t, legacy)

	auth := useTestAccessAuth(t)
	if auth.record == nil || auth.v2Available {
		t.Fatalf("semantic corruption state = record:%v v2Available:%v", auth.record, auth.v2Available)
	}
	state := testAccessStateFile(t)
	if state.Active.RecordBinding != accessRecordBinding(encoded) || state.Active.RecordID != "" || state.Active.RefreshKey != nil || len(state.Active.Families) != 0 {
		t.Fatalf("semantic corruption retained legacy session state: %+v", state.Active)
	}
	if testAccessDBPasswordRecord(t) != encoded {
		t.Fatal("semantic corruption discarded the configured verifier")
	}
	cfg := loadConfig()
	if cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" {
		t.Fatalf("semantic corruption did not complete safely: %#v", cfg)
	}
	if _, err := os.Lstat(accessV2StatePath()); !os.IsNotExist(err) {
		t.Fatalf("corrupt legacy recovery input was not retired after safe migration: %v", err)
	}

	status := testAccessServe(handleAccessAuthStatus, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if status.Code != http.StatusOK {
		t.Fatalf("v1 status after semantic corruption = %d: %s", status.Code, status.Body.String())
	}
	var statusBody struct {
		Challenge string `json:"challenge"`
	}
	testAccessJSONBody(t, status, &statusBody)
	record, err := parseAccessPasswordHash(encoded)
	if err != nil {
		t.Fatal(err)
	}
	loginBody, err := json.Marshal(map[string]string{
		"challenge": statusBody.Challenge,
		"proof":     testAccessProof(t, record.Verifier, statusBody.Challenge),
	})
	if err != nil {
		t.Fatal(err)
	}
	login := testAccessServe(handleAccessAuthLogin, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(string(loginBody))))
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatalf("v1 login after semantic corruption = %d cookies=%d: %s", login.Code, len(login.Result().Cookies()), login.Body.String())
	}
	protected := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	protected.AddCookie(login.Result().Cookies()[0])
	if got := testAccessServe(testAccessProtected().ServeHTTP, protected); got.Code != http.StatusNoContent {
		t.Fatalf("v1 session after semantic corruption = %d want 204", got.Code)
	}
}

func TestAccessMigrationRejectsLegacyRecordIDRefreshKeyMismatch(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*accessV2ActiveState)
	}{
		{
			name: "record ID without refresh key",
			mutate: func(active *accessV2ActiveState) {
				active.RefreshKey = nil
			},
		},
		{
			name: "refresh key without record ID",
			mutate: func(active *accessV2ActiveState) {
				active.RecordID = ""
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withTempConfig(t)
			encoded := testAccessHash()
			seedTestLegacyConfig(t, encoded)
			legacy := legacyAccessStateForTest(t, encoded)
			legacy.Active.Families = []accessV2Family{}
			tc.mutate(&legacy.Active)
			writeLegacyAccessStateForTest(t, legacy)

			auth := useTestAccessAuth(t)
			if auth.record == nil || auth.v2Available {
				t.Fatalf("mismatched legacy identity state = record:%v v2Available:%v", auth.record, auth.v2Available)
			}
			if got := testAccessDBPasswordRecord(t); got != encoded {
				t.Fatalf("migration discarded the v1 verifier: %q", got)
			}
			active := testAccessStateFile(t).Active
			if active.RecordBinding != accessRecordBinding(encoded) || active.RecordID != "" || active.RefreshKey != nil || len(active.Families) != 0 {
				t.Fatalf("mismatched legacy state was not reduced to a safe base: %+v", active)
			}
			if status := testAccessServe(handleAccessAuthStatus, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)); status.Code != http.StatusOK {
				t.Fatalf("v1 status after corrupt legacy state = %d: %s", status.Code, status.Body.String())
			}
			cookie := testAccessCookieFor(t, auth)
			request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
			request.AddCookie(cookie)
			if response := testAccessServe(testAccessProtected().ServeHTTP, request); response.Code != http.StatusNoContent {
				t.Fatalf("v1 session after corrupt legacy state = %d want 204", response.Code)
			}
		})
	}
}

func TestAccessMigrationCorruptLegacyStateKeepsV1ButDisablesV2(t *testing.T) {
	withTempConfig(t)
	encoded := testAccessHash()
	seedTestLegacyConfig(t, encoded)
	if err := os.WriteFile(accessV2StatePath(), []byte(`{"version":1,"active":{"epoch":0}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	auth := useTestAccessAuth(t)
	if auth.record == nil || auth.v2Available {
		t.Fatalf("corrupt legacy migration state = record:%v v2Available:%v", auth.record, auth.v2Available)
	}
	if testAccessDBPasswordRecord(t) != encoded {
		t.Fatal("corrupt legacy session state discarded the imported verifier")
	}
	if state := testAccessStateFile(t).Active; state.RecordBinding != accessRecordBinding(encoded) || len(state.Families) != 0 {
		t.Fatalf("corrupt legacy state did not reset v2 sessions: %+v", state)
	}
	if _, err := os.Lstat(accessV2StatePath()); !os.IsNotExist(err) {
		t.Fatalf("corrupt legacy state was not removed after migration: %v", err)
	}
	cookie := testAccessCookieFor(t, auth)
	request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	request.AddCookie(cookie)
	if got := testAccessServe(testAccessProtected().ServeHTTP, request); got.Code != http.StatusNoContent {
		t.Fatalf("v1 cookie after corrupt legacy state = %d want 204", got.Code)
	}
	if got := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.190:1"); got.Code != http.StatusInternalServerError {
		t.Fatalf("v2 login without migrated sessions = %d want 500", got.Code)
	}
}

func TestAccessMigrationPreservesAcceptedNoncanonicalVerifier(t *testing.T) {
	withTempConfig(t)
	record, err := newAccessPasswordRecord(testAccessPassword)
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.Replace(record.encoded(), ".600000.", ".0600000.", 1)
	if encoded == record.encoded() {
		t.Fatalf("test verifier did not become noncanonical: %q", encoded)
	}
	seedTestLegacyConfig(t, encoded)
	writeLegacyAccessStateForTest(t, legacyAccessStateForTest(t, encoded))
	auth := useTestAccessAuth(t)
	if got := testAccessDBPasswordRecord(t); got != encoded {
		t.Fatalf("migration normalized authoritative verifier: %q want %q", got, encoded)
	}

	login := testAccessV2LoginRequest(t, testAccessPassword, "192.0.2.191:1")
	if login.Code != http.StatusOK {
		t.Fatalf("v2 login with migrated noncanonical verifier = %d: %s", login.Code, login.Body.String())
	}
	handle := testAccessRefreshHandle(t, login)
	if refresh := testAccessV2RefreshRequest(t, handle); refresh.Code != http.StatusOK {
		t.Fatalf("refresh after noncanonical verifier import = %d: %s", refresh.Code, refresh.Body.String())
	}
	if got := testAccessDBPasswordRecord(t); got != encoded {
		t.Fatalf("state-only update normalized authoritative verifier: %q want %q", got, encoded)
	}
	if !auth.v2Available {
		t.Fatal("v2 became unavailable after state-only updates")
	}
}

func TestAccessMigrationConfigWriteFailuresRecoverIdempotently(t *testing.T) {
	t.Run("initial pending marker write fails closed", func(t *testing.T) {
		withTempConfig(t)
		encoded := testAccessHash()
		seedTestLegacyConfig(t, encoded)
		previousWriter := writeConfigFile
		writeConfigFile = func(string, []byte, os.FileMode) error {
			return errors.New("injected initial marker write failure")
		}
		t.Cleanup(func() { writeConfigFile = previousWriter })

		manager := newAccessAuthManager()
		if err := manager.configure(encoded); err == nil {
			manager.close()
			t.Fatal("initial pending marker write failure started auth")
		}
		if !manager.faulted || manager.record != nil {
			manager.close()
			t.Fatalf("failed initial marker write exposed auth: faulted=%v record=%v", manager.faulted, manager.record)
		}
		manager.close()
		cfg, err := readAccessMigrationConfig()
		if err != nil || cfg.AccessPasswordHash != encoded || cfg.AccessAuthMigration != nil {
			t.Fatalf("initial marker failure changed Config: %#v, err=%v", cfg, err)
		}
		if _, err := os.Lstat(accessDBPath()); !os.IsNotExist(err) {
			t.Fatalf("initial marker failure created auth database: %v", err)
		}
		writeConfigFile = previousWriter
		retry := newAccessAuthManager()
		if err := retry.configure(encoded); err != nil {
			retry.close()
			t.Fatalf("retry after initial marker write failure: %v", err)
		}
		retry.close()
		cfg, err = readAccessMigrationConfig()
		if err != nil || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" || cfg.AccessPasswordHash != "" {
			t.Fatalf("retry did not complete the migration: %#v, err=%v", cfg, err)
		}
	})

	for _, committed := range []bool{false, true} {
		name := "finalization write fails before commit"
		if committed {
			name = "finalization write commits but reports failure"
		}
		t.Run(name, func(t *testing.T) {
			withTempConfig(t)
			encoded := testAccessHash()
			seedTestLegacyConfig(t, encoded)
			writeLegacyAccessStateForTest(t, legacyAccessStateForTest(t, encoded))
			previousWriter := writeConfigFile
			completeWriteAttempted := false
			writeConfigFile = func(path string, contents []byte, mode os.FileMode) error {
				var cfg Config
				if err := toml.Unmarshal(contents, &cfg); err != nil {
					return err
				}
				if cfg.AccessAuthMigration != nil && cfg.AccessAuthMigration.State == "complete" {
					completeWriteAttempted = true
					if committed {
						if err := previousWriter(path, contents, mode); err != nil {
							return err
						}
					}
					return errors.New("injected finalization write failure")
				}
				return previousWriter(path, contents, mode)
			}

			first := newAccessAuthManager()
			if err := first.configure(encoded); err == nil {
				first.close()
				writeConfigFile = previousWriter
				t.Fatal("finalization write failure started auth")
			}
			if !completeWriteAttempted || !first.faulted || first.record != nil {
				first.close()
				writeConfigFile = previousWriter
				t.Fatalf("failed finalization state: attempted=%v faulted=%v record=%v", completeWriteAttempted, first.faulted, first.record)
			}
			first.close()
			writeConfigFile = previousWriter

			cfg, err := readAccessMigrationConfig()
			if err != nil {
				t.Fatal(err)
			}
			if committed {
				if cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" {
					t.Fatalf("committed-but-reported-failed finalization did not persist complete Config: %#v", cfg)
				}
			} else if cfg.AccessPasswordHash != encoded || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "pending" {
				t.Fatalf("failed finalization did not preserve pending recovery state: %#v", cfg)
			}
			if _, err := os.Lstat(accessV2StatePath()); err != nil {
				t.Fatalf("failed finalization removed legacy state before recovery: %v", err)
			}

			recovered := newAccessAuthManager()
			if err := recovered.configure(encoded); err != nil {
				recovered.close()
				t.Fatalf("recover after finalization failure: %v", err)
			}
			defer recovered.close()
			cfg, err = readAccessMigrationConfig()
			if err != nil || cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" {
				t.Fatalf("recovered migration Config = %#v, err=%v", cfg, err)
			}
			state, err := recovered.db.verify(recovered.db.migrationID)
			if err != nil || state.PasswordRecord != encoded || !recovered.v2Available {
				t.Fatalf("recovered migration state = verifier:%q v2:%v err:%v", state.PasswordRecord, recovered.v2Available, err)
			}
			if _, err := os.Lstat(accessV2StatePath()); !os.IsNotExist(err) {
				t.Fatalf("recovered migration retained legacy state: %v", err)
			}
		})
	}
}

func TestAccessMigrationCompletedMarkerRejectsUntrustedDatabaseState(t *testing.T) {
	for _, name := range []string{"migration ID mismatch", "unsupported schema", "unexpected Config verifier"} {
		t.Run(name, func(t *testing.T) {
			withTempConfig(t)
			encoded := testAccessHash()
			seedTestLegacyConfig(t, encoded)
			initial := newAccessAuthManager()
			if err := initial.configure(encoded); err != nil {
				initial.close()
				t.Fatalf("prepare completed home: %v", err)
			}
			initial.close()

			cfg, err := readAccessMigrationConfig()
			if err != nil || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" {
				t.Fatalf("prepared Config = %#v err=%v", cfg, err)
			}
			switch name {
			case "migration ID mismatch":
				store, err := openAccessDB(accessDBPath(), false)
				if err != nil {
					t.Fatal(err)
				}
				id, err := accessMigrationID(cfg.AccessAuthMigration)
				if err != nil {
					store.close()
					t.Fatal(err)
				}
				id[0] ^= 0xff
				if _, err := store.db.Exec("UPDATE auth_state SET migration_id=? WHERE singleton_id=1", id[:]); err != nil {
					store.close()
					t.Fatal(err)
				}
				store.close()
			case "unsupported schema":
				store, err := openAccessDB(accessDBPath(), false)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := store.db.Exec("PRAGMA user_version=99"); err != nil {
					store.close()
					t.Fatal(err)
				}
				store.close()
			case "unexpected Config verifier":
				cfg.AccessPasswordHash = encoded
				raw, err := toml.Marshal(cfg)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(configFilePath(), raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}

			manager := newAccessAuthManager()
			if err := manager.configure(encoded); err == nil {
				manager.close()
				t.Fatal("completed migration accepted inconsistent Config/database state")
			}
			if !manager.faulted || manager.record != nil {
				manager.close()
				t.Fatalf("invalid completed migration left auth usable: faulted=%v record=%v", manager.faulted, manager.record)
			}
			manager.close()
		})
	}
}

func TestAccessMigrationPendingRetriesAbsentOrPristineDatabase(t *testing.T) {
	for _, tc := range []struct {
		name       string
		pristineDB bool
	}{
		{name: "absent database"},
		{name: "pristine database", pristineDB: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withTempConfig(t)
			encoded := testAccessHash()
			seedTestLegacyConfig(t, encoded)
			marker, err := newAccessMigrationMarker("pending")
			if err != nil {
				t.Fatal(err)
			}
			if err := writeAccessMigrationConfig(nil, encoded, marker, encoded); err != nil {
				t.Fatal(err)
			}
			if tc.pristineDB {
				store, err := openAccessDB(accessDBPath(), true)
				if err != nil {
					t.Fatal(err)
				}
				store.close()
			}

			manager := newAccessAuthManager()
			if err := manager.configure(encoded); err != nil {
				manager.close()
				t.Fatalf("pending migration retry: %v", err)
			}
			defer manager.close()
			cfg, err := readAccessMigrationConfig()
			if err != nil || cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" || cfg.AccessAuthMigration.ID != marker.ID {
				t.Fatalf("migration retry Config = %#v, err=%v", cfg, err)
			}
			state, err := manager.db.verify(migrationIDForTest(t, marker))
			if err != nil || state.PasswordRecord != encoded || !state.V2Available {
				t.Fatalf("migration retry database = %+v, err=%v", state, err)
			}
		})
	}
}

func migrationIDForTest(t *testing.T, marker *accessAuthMigrationMarker) [16]byte {
	t.Helper()
	id, err := accessMigrationID(marker)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAccessMigrationPendingRejectsMismatchedOrUnsupportedDatabase(t *testing.T) {
	for _, name := range []string{"migration ID mismatch", "verifier mismatch", "non-pristine database", "unsupported database"} {
		t.Run(name, func(t *testing.T) {
			withTempConfig(t)
			encoded := testAccessHash()
			seedTestLegacyConfig(t, encoded)
			marker, err := newAccessMigrationMarker("pending")
			if err != nil {
				t.Fatal(err)
			}
			if err := writeAccessMigrationConfig(nil, encoded, marker, encoded); err != nil {
				t.Fatal(err)
			}
			markerID := migrationIDForTest(t, marker)

			switch name {
			case "migration ID mismatch", "verifier mismatch":
				dbID, dbVerifier := markerID, encoded
				if name == "migration ID mismatch" {
					dbID[0] ^= 0xff
				} else {
					record, err := parseAccessPasswordHash(encoded)
					if err != nil {
						t.Fatal(err)
					}
					record.Salt[0] ^= 0xff
					record.encodedValue = ""
					dbVerifier = record.encoded()
				}
				active, _, err := accessDBTestState()
				if err != nil {
					t.Fatal(err)
				}
				active.RecordBinding = accessRecordBinding(dbVerifier)
				store, err := openAccessDB(accessDBPath(), true)
				if err != nil {
					t.Fatal(err)
				}
				store.migrationID = dbID
				if err := store.initialize(accessDBState{PasswordRecord: dbVerifier, MigrationID: dbID, V2Available: true, Active: active}); err != nil {
					store.close()
					t.Fatal(err)
				}
				store.close()
			case "non-pristine database":
				store, err := openAccessDB(accessDBPath(), true)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := store.db.Exec("CREATE TABLE unrelated(id INTEGER)"); err != nil {
					store.close()
					t.Fatal(err)
				}
				store.close()
			case "unsupported database":
				store, err := openAccessDB(accessDBPath(), true)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := store.db.Exec("PRAGMA user_version=99"); err != nil {
					store.close()
					t.Fatal(err)
				}
				store.close()
			}

			manager := newAccessAuthManager()
			if err := manager.configure(encoded); err == nil {
				manager.close()
				t.Fatal("pending migration accepted an untrusted database")
			}
			if !manager.faulted || manager.record != nil {
				manager.close()
				t.Fatalf("failed migration left fallback auth state: faulted=%v record=%v", manager.faulted, manager.record)
			}
			manager.close()
			cfg, err := readAccessMigrationConfig()
			if err != nil || cfg.AccessPasswordHash != encoded || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "pending" || cfg.AccessAuthMigration.ID != marker.ID {
				t.Fatalf("failed migration changed recovery Config: %#v, err=%v", cfg, err)
			}
		})
	}
}

func TestAccessMigrationRejectsMalformedTOMLMarkerMetadata(t *testing.T) {
	id := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	for _, tc := range []struct {
		name, marker string
	}{
		{name: "extra marker field", marker: "[access_auth_migration]\nstate = \"complete\"\nid = \"" + id + "\"\nextra = true\n"},
		{name: "missing id", marker: "[access_auth_migration]\nstate = \"complete\"\n"},
		{name: "unknown state", marker: "[access_auth_migration]\nstate = \"finished\"\nid = \"" + id + "\"\n"},
		{name: "noncanonical id", marker: "[access_auth_migration]\nstate = \"complete\"\nid = \"" + id + "==\"\n"},
		{name: "wrong marker type", marker: "access_auth_migration = \"complete\"\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withTempConfig(t)
			if err := os.WriteFile(configFilePath(), []byte(tc.marker), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := readAccessMigrationConfig(); err == nil {
				t.Fatal("malformed TOML marker was accepted")
			}
		})
	}
}

func TestAccessMigrationJSONFallbackRejectsMalformedMetadata(t *testing.T) {
	id := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	for _, tc := range []struct {
		name, raw string
	}{
		{name: "duplicate key", raw: `{"theme_color":"a","theme_color":"b"}`},
		{name: "trailing value", raw: `{} {}`},
		{name: "extra marker field", raw: `{"access_auth_migration":{"state":"complete","id":"` + id + `","extra":true}}`},
		{name: "wrong marker type", raw: `{"access_auth_migration":"complete"}`},
		{name: "unknown marker state", raw: `{"access_auth_migration":{"state":"finished","id":"` + id + `"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			primary := withTempConfig(t)
			legacy := withTempLegacyConfig(t)
			if err := os.Remove(primary); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(legacy, []byte(tc.raw), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := readAccessMigrationConfig(); err == nil {
				t.Fatal("malformed legacy JSON metadata was accepted")
			}
			if got := mustRead(t, legacy); string(got) != tc.raw {
				t.Fatal("strict JSON read modified the fallback file")
			}
			if _, err := os.Lstat(primary); !os.IsNotExist(err) {
				t.Fatalf("strict JSON read created primary TOML: %v", err)
			}
		})
	}
}

func TestAccessMigrationRejectsUnmarkedDatabaseAndMalformedMarker(t *testing.T) {
	t.Run("unmarked existing database", func(t *testing.T) {
		withTempConfig(t)
		manager := newAccessAuthManager()
		if err := manager.configure(testAccessHash()); err != nil {
			manager.close()
			t.Fatal(err)
		}
		manager.close()
		cfg, err := readAccessMigrationConfig()
		if err != nil {
			t.Fatal(err)
		}
		cfg.AccessAuthMigration = nil
		raw, err := toml.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(configFilePath(), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		restarted := newAccessAuthManager()
		if err := restarted.configure(""); err == nil {
			restarted.close()
			t.Fatal("unmarked database started")
		}
		restarted.close()
	})

	t.Run("malformed marker", func(t *testing.T) {
		withTempConfig(t)
		if err := os.WriteFile(configFilePath(), []byte("[access_auth_migration]\nstate = \"complete\"\nid = \"bad\"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		manager := newAccessAuthManager()
		if err := manager.configure(""); err == nil {
			manager.close()
			t.Fatal("malformed migration marker started")
		}
		if !manager.faulted || manager.record != nil {
			manager.close()
			t.Fatalf("malformed marker left auth state usable: faulted=%v record=%v", manager.faulted, manager.record)
		}
		manager.close()
	})
}

func TestAccessDBInitializationFailureRollsBackSchemaAndVersion(t *testing.T) {
	withTempConfig(t)
	store, err := openAccessDB(accessDBPath(), true)
	if err != nil {
		t.Fatal(err)
	}
	defer store.close()
	active, id, err := accessDBTestState()
	if err != nil {
		t.Fatal(err)
	}
	encoded := testAccessHash()
	active.RecordBinding = accessRecordBinding(encoded)
	store.migrationID = id
	store.commit = func(*sql.Tx) error { return errors.New("injected initialization commit failure") }
	if err := store.initialize(accessDBState{PasswordRecord: encoded, MigrationID: id, V2Available: true, Active: active}); err == nil {
		t.Fatal("initialization commit failure reported success")
	}
	var version, tables, stateTables int
	if err := store.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='auth_state'").Scan(&stateTables); err != nil {
		t.Fatal(err)
	}
	if version != 0 || tables != 0 || stateTables != 0 {
		t.Fatalf("failed initialization left version=%d tables=%d auth_state=%d", version, tables, stateTables)
	}
	if _, err := store.db.Query("SELECT count(*) FROM auth_state"); err == nil {
		t.Fatal("failed initialization left auth rows accessible")
	}
}

func TestAccessMigrationStalePreMigrationConfigCannotRestoreVerifierOrMarker(t *testing.T) {
	withTempConfig(t)
	encoded := testAccessHash()
	seedTestLegacyConfig(t, encoded)
	stale := loadConfig()
	useTestAccessAuth(t)
	stale.ThemeColor = "gold"
	saveConfig(stale)

	cfg := loadConfig()
	if cfg.ThemeColor != "gold" || cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" {
		t.Fatalf("stale Config snapshot changed migration state: %#v", cfg)
	}
	if got := testAccessDBPasswordRecord(t); got != encoded {
		t.Fatalf("stale Config snapshot changed database verifier: %q", got)
	}
}

func TestAccessMigrationMetadataIsNotExported(t *testing.T) {
	withTempConfig(t)
	seedTestLegacyConfig(t, testAccessHash())
	useTestAccessAuth(t)
	marker := loadConfig().AccessAuthMigration
	if marker == nil || marker.State != "complete" {
		t.Fatalf("missing completed migration marker: %#v", marker)
	}

	configResponse := httptest.NewRecorder()
	handleConfig(configResponse, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if strings.Contains(configResponse.Body.String(), "access_auth_migration") || strings.Contains(configResponse.Body.String(), marker.ID) {
		t.Fatalf("/api/config exposed internal migration metadata: %s", configResponse.Body.String())
	}

	exportResponse := httptest.NewRecorder()
	handleConfigExport(exportResponse, httptest.NewRequest(http.MethodGet, "/api/config/export", nil))
	var exported struct {
		Config string `json:"config"`
	}
	if err := json.Unmarshal(exportResponse.Body.Bytes(), &exported); err != nil {
		t.Fatal(err)
	}
	payload, err := decodeConfigData(exported.Config, "PHICONFIG")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "access_auth_migration") || strings.Contains(string(payload), marker.ID) {
		t.Fatalf("Config export exposed internal migration metadata: %s", payload)
	}
}

func TestAccessMigrationPendingMarkerRecoversInitializedDatabase(t *testing.T) {
	withTempConfig(t)
	encoded := testAccessHash()
	seedTestLegacyConfig(t, encoded)
	marker, err := newAccessMigrationMarker("pending")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeAccessMigrationConfig(nil, encoded, marker, encoded); err != nil {
		t.Fatal(err)
	}
	migrationID, err := accessMigrationID(marker)
	if err != nil {
		t.Fatal(err)
	}
	active, _, err := accessDBTestState()
	if err != nil {
		t.Fatal(err)
	}
	active.RecordBinding = accessRecordBinding(encoded)
	store, err := openAccessDB(accessDBPath(), true)
	if err != nil {
		t.Fatal(err)
	}
	store.migrationID = migrationID
	if err := store.initialize(accessDBState{PasswordRecord: encoded, MigrationID: migrationID, V2Available: true, Active: active}); err != nil {
		store.close()
		t.Fatal(err)
	}
	store.close()

	auth := useTestAccessAuth(t)
	if !auth.v2Available || testAccessDBPasswordRecord(t) != encoded {
		t.Fatal("pending migration did not finalize the matching initialized database")
	}
	cfg := loadConfig()
	if cfg.AccessPasswordHash != "" || cfg.AccessAuthMigration == nil || cfg.AccessAuthMigration.State != "complete" || cfg.AccessAuthMigration.ID != marker.ID {
		t.Fatalf("completed migration marker = %#v", cfg.AccessAuthMigration)
	}
}

func TestAccessMigrationRejectsCompletedMarkerWithoutDatabase(t *testing.T) {
	withTempConfig(t)
	seedTestLegacyConfig(t, testAccessHash())
	marker, err := newAccessMigrationMarker("complete")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeAccessMigrationConfig(nil, testAccessHash(), marker, ""); err != nil {
		t.Fatal(err)
	}
	manager := newAccessAuthManager()
	if err := manager.configure(""); err == nil {
		manager.close()
		t.Fatal("completed marker without its database started successfully")
	}
	manager.close()
}

func TestAccessMigrationRejectsCorruptDatabaseWithoutConfigFallback(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	testAccessEnableV2(t, testAccessPassword)
	auth.close()
	if err := os.WriteFile(accessDBPath(), []byte("not sqlite"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := newAccessAuthManager()
	if err := manager.configure(testAccessHash()); err == nil {
		manager.close()
		t.Fatal("corrupt completed database fell back to the display verifier")
	}
	if manager.record != nil || !manager.faulted {
		manager.close()
		t.Fatalf("corrupt database produced fallback auth state: record=%v faulted=%v", manager.record, manager.faulted)
	}
	manager.close()
}

func TestAccessFaultedOwnerCannotIssueOrAcceptV1Credentials(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	if err := setTestAccessRecord(auth, testAccessHash()); err != nil {
		t.Fatal(err)
	}
	cookie := testAccessCookieFor(t, auth)
	status := testAccessServe(handleAccessAuthStatus, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if status.Code != http.StatusOK {
		t.Fatalf("initial v1 status = %d: %s", status.Code, status.Body.String())
	}
	var challenge struct {
		Challenge string `json:"challenge"`
	}
	testAccessJSONBody(t, status, &challenge)
	record, err := parseAccessPasswordHash(testAccessHash())
	if err != nil {
		t.Fatal(err)
	}
	loginBody, err := json.Marshal(map[string]string{
		"challenge": challenge.Challenge,
		"proof":     testAccessProof(t, record.Verifier, challenge.Challenge),
	})
	if err != nil {
		t.Fatal(err)
	}

	auth.mu.Lock()
	previousCommit := auth.db.commit
	auth.db.commit = func(tx *sql.Tx) error {
		if err := tx.Commit(); err != nil {
			return err
		}
		if err := auth.db.db.Close(); err != nil {
			return err
		}
		if err := os.WriteFile(accessDBPath(), []byte("not sqlite"), 0o600); err != nil {
			return err
		}
		return errors.New("injected uncertain commit after database corruption")
	}
	auth.mu.Unlock()
	changeRequest := httptest.NewRequest(http.MethodPost, "/api/auth/password", strings.NewReader(`{"password_hash":"`+testAccessHash()+`"}`))
	changeRequest.AddCookie(cookie)
	change := testAccessServe(handleAccessPassword, changeRequest)
	auth.mu.Lock()
	auth.db.commit = previousCommit
	faulted, retainedRecord := auth.faulted, auth.record != nil
	auth.mu.Unlock()
	if change.Code != http.StatusInternalServerError || change.Body.String() != "Unable to save access password\n" || len(change.Result().Cookies()) != 0 {
		t.Fatalf("uncertain v1 password change = %d cookies=%d body=%q", change.Code, len(change.Result().Cookies()), change.Body.String())
	}
	if !faulted || !retainedRecord {
		t.Fatalf("failed reload did not retain a faulted owner: faulted=%v record=%v", faulted, retainedRecord)
	}

	status = testAccessServe(handleAccessAuthStatus, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if status.Code != http.StatusServiceUnavailable || status.Body.String() != "Unable to start login: unable to persist access password\n" {
		t.Fatalf("faulted v1 status = %d %q", status.Code, status.Body.String())
	}
	login := testAccessServe(handleAccessAuthLogin, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(string(loginBody))))
	if login.Code != http.StatusInternalServerError || login.Body.String() != "Unable to login\n" || len(login.Result().Cookies()) != 0 {
		t.Fatalf("faulted v1 login = %d cookies=%d body=%q", login.Code, len(login.Result().Cookies()), login.Body.String())
	}
	protected := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
	protected.AddCookie(cookie)
	if got := testAccessServe(testAccessProtected().ServeHTTP, protected); got.Code != http.StatusUnauthorized {
		t.Fatalf("faulted owner accepted a v1 cookie: %d want 401", got.Code)
	}
}

func TestAccessDBRejectsInconsistentActiveState(t *testing.T) {
	for _, tc := range []struct {
		name   string
		update string
	}{
		{name: "empty password record with active families", update: `UPDATE auth_state SET password_record=''`},
		{name: "record ID without refresh key", update: `UPDATE auth_state SET refresh_key=X''`},
		{name: "refresh key without record ID", update: `UPDATE auth_state SET record_id=X''`},
		{name: "families while v2 is unavailable", update: `UPDATE auth_state SET v2_available=0`},
		{name: "active digest does not match refresh handle", update: `UPDATE auth_families SET active_digest=zeroblob(32)`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withTempConfig(t)
			auth := useTestAccessAuth(t)
			active, _, err := accessDBTestState()
			if err != nil {
				t.Fatal(err)
			}
			encoded := testAccessHash()
			active.RecordBinding = accessRecordBinding(encoded)
			auth.mu.Lock()
			state := accessDBState{
				PasswordRecord: encoded,
				MigrationID:    auth.db.migrationID,
				V2Available:    true,
				Active:         active,
			}
			err = auth.db.save(state)
			if err == nil && tc.name == "active digest does not match refresh handle" {
				invalid := state
				invalid.Active.Families = append([]accessV2Family(nil), state.Active.Families...)
				invalid.Active.Families[0].ActiveDigest = strings.Repeat("0", 64)
				err = auth.db.save(invalid)
				if err == nil {
					auth.mu.Unlock()
					t.Fatal("database save accepted a digest not derived from its refresh handle")
				}
				err = auth.db.save(state)
			}
			auth.mu.Unlock()
			if err != nil {
				t.Fatalf("seed valid auth database state: %v", err)
			}
			auth.close()

			store, err := openAccessDB(accessDBPath(), false)
			if err != nil {
				t.Fatalf("open synthetic auth database: %v", err)
			}
			if _, err := store.db.Exec(tc.update); err != nil {
				store.close()
				t.Fatalf("corrupt auth state row: %v", err)
			}
			var integrity string
			if err := store.db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
				store.close()
				t.Fatalf("synthetic database integrity = %q, err=%v", integrity, err)
			}
			var familyCount int
			if err := store.db.QueryRow("SELECT count(*) FROM auth_families").Scan(&familyCount); err != nil || familyCount == 0 {
				store.close()
				t.Fatalf("synthetic family count = %d, err=%v", familyCount, err)
			}
			if _, err := loadAccessDBState(store.db); err == nil {
				store.close()
				t.Fatal("loaded semantically inconsistent auth state")
			}
			store.close()

			manager := newAccessAuthManager()
			if err := manager.configure(""); err == nil {
				manager.close()
				t.Fatal("configured from semantically inconsistent auth database")
			}
			if !manager.faulted || manager.record != nil {
				manager.close()
				t.Fatalf("invalid database left auth state usable: faulted=%v record=%v", manager.faulted, manager.record)
			}
			previous := accessAuth
			accessAuth = manager
			t.Cleanup(func() {
				manager.close()
				accessAuth = previous
			})
			request := httptest.NewRequest(http.MethodGet, "/api/coders", nil)
			if got := testAccessServe(testAccessProtected().ServeHTTP, request); got.Code != http.StatusUnauthorized {
				t.Fatalf("protected request after failed auth DB load = %d want 401", got.Code)
			}
		})
	}
}

func TestAccessDBDurability(t *testing.T) {
	withTempConfig(t)
	path := accessDBPath()
	store, err := openAccessDB(path, true)
	if err != nil {
		t.Fatalf("open auth DB: %v", err)
	}
	defer store.close()
	if store.db.Stats().MaxOpenConnections != 1 {
		t.Fatalf("max open connections = %d, want 1", store.db.Stats().MaxOpenConnections)
	}
	var journal string
	if err := store.db.QueryRow("PRAGMA journal_mode").Scan(&journal); err != nil || journal != "delete" {
		t.Fatalf("journal mode = %q, err=%v", journal, err)
	}
	var synchronous, foreignKeys, busyTimeout int
	if err := store.db.QueryRow("PRAGMA synchronous").Scan(&synchronous); err != nil || synchronous != 2 {
		t.Fatalf("synchronous = %d, err=%v", synchronous, err)
	}
	if err := store.db.QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys); err != nil || foreignKeys != 1 {
		t.Fatalf("foreign_keys = %d, err=%v", foreignKeys, err)
	}
	if err := store.db.QueryRow("PRAGMA busy_timeout").Scan(&busyTimeout); err != nil || busyTimeout != accessDBBusyTimeout {
		t.Fatalf("busy_timeout = %d, err=%v", busyTimeout, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if err := secureAccessDBFile(path, info); err != nil {
			t.Fatalf("auth DB owner ACL: %v", err)
		}
	} else if info.Mode().Perm() != 0o600 {
		t.Fatalf("auth DB mode = %04o, want 0600", info.Mode().Perm())
	}
	pristine, err := store.isPristine()
	if err != nil || !pristine {
		t.Fatalf("new auth DB pristine = %v, err=%v", pristine, err)
	}

	active, id, err := accessDBTestState()
	if err != nil {
		t.Fatal(err)
	}
	store.migrationID = id
	encoded := testAccessHash()
	active.RecordBinding = accessRecordBinding(encoded)
	state := accessDBState{PasswordRecord: encoded, MigrationID: id, V2Available: true, Active: active}
	if err := store.initialize(state); err != nil {
		t.Fatalf("initialize auth DB: %v", err)
	}
	loaded, err := store.verify(id)
	if err != nil {
		t.Fatalf("verify initialized DB: %v", err)
	}
	if loaded.Active.Epoch != math.MaxUint64 || loaded.Active.Families[0].Generation != math.MaxUint64 {
		t.Fatalf("uint64 BLOB round-trip failed: epoch=%d generation=%d", loaded.Active.Epoch, loaded.Active.Families[0].Generation)
	}
	var version int
	if err := store.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != accessDBSchema {
		t.Fatalf("user_version = %d, err=%v", version, err)
	}
}

func TestAccessDBM1RealServerAcceptance(t *testing.T) {
	withTempConfig(t)
	record, err := newAccessPasswordRecord(testAccessPassword)
	if err != nil {
		t.Fatal(err)
	}
	seedTestLegacyConfig(t, record.encoded())
	auth := useTestAccessAuth(t)

	newServer := func() *httptest.Server {
		mux := http.NewServeMux()
		mux.HandleFunc("/api/auth/v2/login", handleAccessV2Login)
		mux.HandleFunc("/api/auth/v2/password", handleAccessV2Password)
		mux.Handle("/api/coders", accessAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})))
		return httptest.NewServer(mux)
	}
	server := newServer()
	login := func(srv *httptest.Server, password string) *http.Response {
		body := `{"password":"` + password + `"}`
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/v2/login", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(accessV2Header, accessV2HeaderValue)
		req.Header.Set("Content-Type", "application/json")
		response, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	requestProtected := func(srv *httptest.Server, token string) *http.Response {
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/coders", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}

	first := login(server, testAccessPassword)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("real-server initial login = %d", first.StatusCode)
	}
	var bundle accessV2Bundle
	if err := json.NewDecoder(first.Body).Decode(&bundle); err != nil {
		first.Body.Close()
		t.Fatal(err)
	}
	first.Body.Close()
	if bundle.Token == "" {
		t.Fatal("real-server initial login returned no bearer")
	}
	protected := requestProtected(server, bundle.Token)
	protected.Body.Close()
	if protected.StatusCode != http.StatusNoContent {
		t.Fatalf("real-server protected request = %d want 204", protected.StatusCode)
	}

	changeBody := `{"password":"m1-server-pass-5678"}`
	change, err := http.NewRequest(http.MethodPost, server.URL+"/api/auth/v2/password", strings.NewReader(changeBody))
	if err != nil {
		t.Fatal(err)
	}
	change.Header.Set(accessV2Header, accessV2HeaderValue)
	change.Header.Set("Content-Type", "application/json")
	change.Header.Set("Authorization", "Bearer "+bundle.Token)
	changed, err := server.Client().Do(change)
	if err != nil {
		t.Fatal(err)
	}
	if changed.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(changed.Body)
		changed.Body.Close()
		t.Fatalf("real-server password change = %d: %s", changed.StatusCode, body)
	}
	changed.Body.Close()
	stored, err := parseAccessPasswordHash(testAccessDBPasswordRecord(t))
	if err != nil {
		t.Fatal(err)
	}
	if matches, err := stored.matchesPassword("m1-server-pass-5678"); err != nil || !matches {
		t.Fatalf("real-server password transaction not stored: matches=%v err=%v", matches, err)
	}
	stale := requestProtected(server, bundle.Token)
	stale.Body.Close()
	if stale.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old real-server bearer after rotation = %d want 401", stale.StatusCode)
	}

	server.Close()
	auth.close()
	restarted := newAccessAuthManager()
	if err := restarted.configure(loadConfig().AccessPasswordHash); err != nil {
		restarted.close()
		t.Fatalf("real-server restart configure: %v", err)
	}
	previous := accessAuth
	accessAuth = restarted
	t.Cleanup(func() {
		restarted.close()
		accessAuth = previous
	})
	server = newServer()
	defer server.Close()
	fresh := login(server, "m1-server-pass-5678")
	if fresh.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(fresh.Body)
		fresh.Body.Close()
		t.Fatalf("real-server login after restart = %d: %s", fresh.StatusCode, body)
	}
	if err := json.NewDecoder(fresh.Body).Decode(&bundle); err != nil {
		fresh.Body.Close()
		t.Fatal(err)
	}
	fresh.Body.Close()
	protected = requestProtected(server, bundle.Token)
	protected.Body.Close()
	if protected.StatusCode != http.StatusNoContent {
		t.Fatalf("real-server protected request after restart = %d want 204", protected.StatusCode)
	}
}

func TestAccessDBFileURI(t *testing.T) {
	const path = `C:\phi test\auth.db`
	const want = "file:///C:/phi%20test/auth.db"
	if got := accessDBFileURI(path); got != want {
		t.Fatalf("access DB URI = %q, want %q", got, want)
	}

	if runtime.GOOS != "windows" {
		return
	}
	root := filepath.Join(t.TempDir(), "auth database with spaces")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(root, accessDBFileName)
	store, err := openAccessDB(dbPath, true)
	if err != nil {
		t.Fatalf("open auth DB in path containing spaces: %v", err)
	}
	defer store.close()
	active, migrationID, err := accessDBTestState()
	if err != nil {
		t.Fatal(err)
	}
	encoded := testAccessHash()
	active.RecordBinding = accessRecordBinding(encoded)
	if err := store.initialize(accessDBState{PasswordRecord: encoded, MigrationID: migrationID, V2Available: true, Active: active}); err != nil {
		t.Fatalf("initialize auth DB: %v", err)
	}
	if err := store.close(); err != nil {
		t.Fatalf("close auth DB: %v", err)
	}
	got, err := readOnlyAccessDBVerifier(dbPath)
	if err != nil {
		t.Fatalf("read verifier from auth DB in path containing spaces: %v", err)
	}
	if got != encoded {
		t.Fatalf("read verifier = %q, want %q", got, encoded)
	}
}

func TestAccessDBRejectsSymlinkAndNonRegularPaths(t *testing.T) {
	withTempConfig(t)
	root := t.TempDir()
	dir := filepath.Join(root, "directory.db")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := openAccessDB(dir, false); err == nil {
		t.Fatal("accepted directory as auth DB")
	}
	t.Run("symlink", func(t *testing.T) {
		target := filepath.Join(root, "target.db")
		if err := os.WriteFile(target, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(root, "link.db")
		if err := os.Symlink(target, link); err != nil {
			if runtime.GOOS == "windows" && (errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.Errno(1314)) || errors.Is(err, errors.ErrUnsupported)) {
				t.Skipf("Windows does not permit symlink creation: %v", err)
			}
			t.Fatal(err)
		}
		if _, err := openAccessDB(link, false); err == nil {
			t.Fatal("accepted symlink as auth DB")
		}
	})
}

func accessDBTestState() (accessV2ActiveState, [16]byte, error) {
	var migrationID [16]byte
	for i := range migrationID {
		migrationID[i] = byte(i + 1)
	}
	recordID, err := randomAccessToken()
	if err != nil {
		return accessV2ActiveState{}, migrationID, err
	}
	familyID, err := randomAccessToken()
	if err != nil {
		return accessV2ActiveState{}, migrationID, err
	}
	jti, err := randomAccessToken()
	if err != nil {
		return accessV2ActiveState{}, migrationID, err
	}
	refreshKey := make([]byte, accessRefreshKeyBytes)
	for i := range refreshKey {
		refreshKey[i] = byte(i + 3)
	}
	generation := uint64(math.MaxUint64)
	handle, err := accessRefreshHandle(refreshKey, familyID, generation)
	if err != nil {
		return accessV2ActiveState{}, migrationID, err
	}
	digest, err := accessHandleDigest(handle)
	if err != nil {
		return accessV2ActiveState{}, migrationID, err
	}
	encodedKey := base64.RawURLEncoding.EncodeToString(refreshKey)
	active := accessV2ActiveState{
		RecordBinding: accessRecordBinding(""),
		RecordID:      recordID,
		Epoch:         math.MaxUint64,
		RefreshKey:    &encodedKey,
		Families: []accessV2Family{{
			ID:                familyID,
			Generation:        generation,
			CreatedAt:         1,
			LastUsedAt:        2,
			IdleExpiresAt:     3,
			AbsoluteExpiresAt: 4,
			ActiveDigest:      digest,
			CurrentAccess: accessV2Access{
				IssuedAt:  1,
				ExpiresAt: 3601,
				Nonce:     jti,
			},
			Consumed: []accessV2Consumed{{Digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ConsumedAt: 1}},
		}},
	}
	return active, migrationID, nil
}
