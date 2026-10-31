package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
	_ "modernc.org/sqlite"
)

const (
	accessDBFileName    = "auth.db"
	accessDBSchema      = 1
	accessDBBusyTimeout = 1000
)

var errAccessDBCommitUncertain = errors.New("auth database commit outcome is uncertain")

type accessDBState struct {
	PasswordRecord string
	MigrationID    [16]byte
	V2Available    bool
	Active         accessV2ActiveState
}

type accessDB struct {
	db          *sql.DB
	path        string
	migrationID [16]byte
	commit      func(*sql.Tx) error
}

func accessDBPath() string {
	return filepath.Join(filepath.Dir(configFilePath()), accessDBFileName)
}

func accessDBFileURI(path string) string {
	uriPath := filepath.ToSlash(path)
	if len(path) >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1] == ':' && (path[2] == '/' || path[2] == '\\') {
		uriPath = "/" + strings.ReplaceAll(path, `\`, "/")
	}
	return (&url.URL{Scheme: "file", Path: uriPath}).String()
}

func readOnlyAccessDBVerifier(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", errors.New("auth database path is not a regular file")
	}
	uri := accessDBFileURI(path) + "?mode=ro"
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		return "", err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return "", err
	}
	if version != accessDBSchema {
		return "", errors.New("unsupported auth database schema")
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM auth_state").Scan(&count); err != nil || count != 1 {
		if err == nil {
			err = errors.New("auth database state is unavailable")
		}
		return "", err
	}
	var encoded string
	if err := db.QueryRow("SELECT password_record FROM auth_state WHERE singleton_id=1").Scan(&encoded); err != nil {
		return "", err
	}
	if _, err := parseAccessPasswordHash(encoded); err != nil {
		return "", err
	}
	return encoded, nil
}

func openAccessDB(path string, create bool) (*accessDB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if os.IsNotExist(err) {
		if !create {
			return nil, os.ErrNotExist
		}
		file, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if createErr != nil && !os.IsExist(createErr) {
			return nil, createErr
		}
		if file != nil {
			if closeErr := file.Close(); closeErr != nil {
				return nil, closeErr
			}
		}
		info, err = os.Lstat(path)
		if err != nil {
			return nil, err
		}
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("auth database path is not a regular file")
	}
	if err := secureAccessDBFile(path, info); err != nil {
		return nil, err
	}
	uri := accessDBFileURI(path)
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	fail := func(err error) (*accessDB, error) {
		_ = db.Close()
		return nil, err
	}
	if err := db.PingContext(context.Background()); err != nil {
		return fail(err)
	}
	var journal string
	if err := db.QueryRow("PRAGMA journal_mode=DELETE").Scan(&journal); err != nil || !strings.EqualFold(journal, "delete") {
		if err == nil {
			err = fmt.Errorf("unexpected SQLite journal mode %q", journal)
		}
		return fail(err)
	}
	if _, err := db.Exec("PRAGMA synchronous=FULL"); err != nil {
		return fail(err)
	}
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		return fail(err)
	}
	if _, err := db.Exec(fmt.Sprintf("PRAGMA busy_timeout=%d", accessDBBusyTimeout)); err != nil {
		return fail(err)
	}
	var synchronous, foreignKeys, busyTimeout int
	if err := db.QueryRow("PRAGMA synchronous").Scan(&synchronous); err != nil || synchronous != 2 {
		if err == nil {
			err = fmt.Errorf("unexpected SQLite synchronous setting %d", synchronous)
		}
		return fail(err)
	}
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys); err != nil || foreignKeys != 1 {
		if err == nil {
			err = fmt.Errorf("SQLite foreign keys are disabled")
		}
		return fail(err)
	}
	if err := db.QueryRow("PRAGMA busy_timeout").Scan(&busyTimeout); err != nil || busyTimeout != accessDBBusyTimeout {
		if err == nil {
			err = fmt.Errorf("unexpected SQLite busy timeout %d", busyTimeout)
		}
		return fail(err)
	}
	return &accessDB{db: db, path: path, commit: func(tx *sql.Tx) error { return tx.Commit() }}, nil
}

func secureAccessDBFile(path string, _ os.FileInfo) error {
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o600); err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
			return os.ErrPermission
		}
		return nil
	}
	const pathEnv = "PHI_AUTH_DB_ACL_PATH"
	const script = `$ErrorActionPreference = 'Stop'; $p = $env:PHI_AUTH_DB_ACL_PATH; $acl = Get-Acl -LiteralPath $p; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value; if ($owner -ne $sid) { exit 2 }; foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin @($sid, 'S-1-5-18', 'S-1-5-32-544')) { exit 3 } }; Write-Output 'PHI_AUTH_DB_ACL_OK'`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = os.Environ()
	for i := 0; i < len(cmd.Env); {
		name, _, _ := strings.Cut(cmd.Env[i], "=")
		if strings.EqualFold(name, pathEnv) {
			cmd.Env = append(cmd.Env[:i], cmd.Env[i+1:]...)
			continue
		}
		i++
	}
	cmd.Env = append(cmd.Env, pathEnv+"="+path)
	output, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != "PHI_AUTH_DB_ACL_OK" {
		return errors.New("auth database ACL is not restricted to its owner")
	}
	return nil
}

func (s *accessDB) close() error {
	if s == nil || s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	return err
}

func (s *accessDB) isPristine() (bool, error) {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return false, err
	}
	var tables int
	if err := s.db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil {
		return false, err
	}
	return version == 0 && tables == 0, nil
}

func (s *accessDB) initialize(state accessDBState) error {
	if err := validateAccessDBState(state); err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range accessDBSchemaSQL {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	if _, err := tx.Exec("PRAGMA user_version=1"); err != nil {
		return err
	}
	if err := insertAccessDBState(tx, state); err != nil {
		return err
	}
	if err := insertAccessDBFamilies(tx, state.Active.Families); err != nil {
		return err
	}
	if err := verifyAccessDBIntegrity(tx); err != nil {
		return err
	}
	if err := s.commit(tx); err != nil {
		return fmt.Errorf("%w: %v", errAccessDBCommitUncertain, err)
	}
	return nil
}

var accessDBSchemaSQL = []string{
	`CREATE TABLE auth_state (
		singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
		password_record TEXT NOT NULL,
		record_id BLOB NOT NULL CHECK (length(record_id) IN (0, 32)),
		epoch BLOB NOT NULL CHECK (length(epoch) = 8),
		refresh_key BLOB NOT NULL CHECK (length(refresh_key) IN (0, 32)),
		v2_available INTEGER NOT NULL CHECK (v2_available IN (0, 1)),
		migration_id BLOB NOT NULL CHECK (length(migration_id) = 16)
	)`,
	`CREATE TABLE auth_families (
		family_id BLOB PRIMARY KEY CHECK (length(family_id) = 32),
		generation BLOB NOT NULL CHECK (length(generation) = 8),
		created_at INTEGER NOT NULL CHECK (created_at > 0),
		last_used_at INTEGER NOT NULL CHECK (last_used_at >= created_at),
		idle_expires_at INTEGER NOT NULL CHECK (idle_expires_at > created_at),
		absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at >= idle_expires_at),
		active_digest BLOB NOT NULL UNIQUE CHECK (length(active_digest) = 32),
		access_iat INTEGER NOT NULL CHECK (access_iat > 0),
		access_exp INTEGER NOT NULL CHECK (access_exp > access_iat),
		access_jti BLOB NOT NULL CHECK (length(access_jti) = 32)
	)`,
	`CREATE TABLE auth_consumed_handles (
		digest BLOB PRIMARY KEY CHECK (length(digest) = 32),
		family_id BLOB NOT NULL CHECK (length(family_id) = 32),
		consumed_at INTEGER NOT NULL CHECK (consumed_at > 0),
		FOREIGN KEY (family_id) REFERENCES auth_families(family_id) ON DELETE CASCADE
	)`,
}

func insertAccessDBState(tx *sql.Tx, state accessDBState) error {
	recordID, err := decodeOptionalAccessID(state.Active.RecordID)
	if err != nil {
		return err
	}
	refreshKey, err := decodeOptionalRefreshKey(state.Active.RefreshKey)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO auth_state(singleton_id,password_record,record_id,epoch,refresh_key,v2_available,migration_id)
		VALUES(1,?,?,?,?,?,?)`, state.PasswordRecord, recordID, encodeAccessUint64(state.Active.Epoch), refreshKey, boolInt(state.V2Available), state.MigrationID[:])
	return err
}

func insertAccessDBFamilies(tx *sql.Tx, families []accessV2Family) error {
	for i := range families {
		family := &families[i]
		familyID, err := decodeAccessID(family.ID)
		if err != nil {
			return err
		}
		activeDigest, err := decodeAccessDigest(family.ActiveDigest)
		if err != nil {
			return err
		}
		jti, err := decodeAccessID(family.CurrentAccess.Nonce)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO auth_families(family_id,generation,created_at,last_used_at,idle_expires_at,absolute_expires_at,active_digest,access_iat,access_exp,access_jti)
			VALUES(?,?,?,?,?,?,?,?,?,?)`, familyID, encodeAccessUint64(family.Generation), family.CreatedAt, family.LastUsedAt, family.IdleExpiresAt, family.AbsoluteExpiresAt, activeDigest, family.CurrentAccess.IssuedAt, family.CurrentAccess.ExpiresAt, jti); err != nil {
			return err
		}
		for _, consumed := range family.Consumed {
			digest, err := decodeAccessDigest(consumed.Digest)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(`INSERT INTO auth_consumed_handles(digest,family_id,consumed_at) VALUES(?,?,?)`, digest, familyID, consumed.ConsumedAt); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *accessDB) verify(migrationID [16]byte) (accessDBState, error) {
	if err := verifyAccessDBSchema(s.db); err != nil {
		return accessDBState{}, err
	}
	if err := verifyAccessDBIntegrity(s.db); err != nil {
		return accessDBState{}, err
	}
	state, err := loadAccessDBState(s.db)
	if err != nil {
		return accessDBState{}, err
	}
	if state.MigrationID != migrationID {
		return accessDBState{}, errors.New("auth database migration ID mismatch")
	}
	return state, nil
}

func verifyAccessDBSchema(db *sql.DB) error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version != accessDBSchema {
		return fmt.Errorf("unsupported auth database schema version %d", version)
	}
	rows, err := db.Query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		return err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	want := []string{"auth_consumed_handles", "auth_families", "auth_state"}
	if !reflect.DeepEqual(names, want) {
		return errors.New("auth database schema tables do not match")
	}
	return nil
}

func verifyAccessDBIntegrity(q interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}) error {
	var result string
	if err := q.QueryRow("PRAGMA integrity_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return errors.New("auth database integrity check failed")
	}
	rows, err := q.Query("PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("auth database foreign key check failed")
	}
	return rows.Err()
}

func loadAccessDBState(q interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}) (accessDBState, error) {
	var state accessDBState
	var recordID, epoch, refreshKey, migrationID []byte
	var v2Available int
	var rowCount int
	if err := q.QueryRow("SELECT count(*) FROM auth_state").Scan(&rowCount); err != nil {
		return state, err
	}
	if rowCount != 1 {
		return state, errors.New("auth database must contain exactly one state row")
	}
	if err := q.QueryRow(`SELECT password_record,record_id,epoch,refresh_key,v2_available,migration_id FROM auth_state WHERE singleton_id=1`).Scan(&state.PasswordRecord, &recordID, &epoch, &refreshKey, &v2Available, &migrationID); err != nil {
		return state, err
	}
	if len(migrationID) != len(state.MigrationID) || len(epoch) != 8 || (len(recordID) != 0 && len(recordID) != 32) || (len(refreshKey) != 0 && len(refreshKey) != accessRefreshKeyBytes) || (v2Available != 0 && v2Available != 1) {
		return state, errors.New("auth database state row is invalid")
	}
	copy(state.MigrationID[:], migrationID)
	state.V2Available = v2Available == 1
	state.Active.Epoch = binary.BigEndian.Uint64(epoch)
	if len(recordID) != 0 {
		state.Active.RecordID = base64.RawURLEncoding.EncodeToString(recordID)
	}
	if len(refreshKey) != 0 {
		key := base64.RawURLEncoding.EncodeToString(refreshKey)
		state.Active.RefreshKey = &key
	}
	state.Active.RecordBinding = accessRecordBinding(state.PasswordRecord)
	families, err := q.Query(`SELECT family_id,generation,created_at,last_used_at,idle_expires_at,absolute_expires_at,active_digest,access_iat,access_exp,access_jti FROM auth_families ORDER BY family_id`)
	if err != nil {
		return state, err
	}
	familyIndexes := make(map[string]int)
	for families.Next() {
		var id, generation, activeDigest, jti []byte
		var family accessV2Family
		if err := families.Scan(&id, &generation, &family.CreatedAt, &family.LastUsedAt, &family.IdleExpiresAt, &family.AbsoluteExpiresAt, &activeDigest, &family.CurrentAccess.IssuedAt, &family.CurrentAccess.ExpiresAt, &jti); err != nil {
			families.Close()
			return state, err
		}
		if len(id) != 32 || len(generation) != 8 || len(activeDigest) != 32 || len(jti) != 32 {
			families.Close()
			return state, errors.New("auth database family row is invalid")
		}
		family.ID = base64.RawURLEncoding.EncodeToString(id)
		family.Generation = binary.BigEndian.Uint64(generation)
		family.ActiveDigest = hex.EncodeToString(activeDigest)
		family.CurrentAccess.Nonce = base64.RawURLEncoding.EncodeToString(jti)
		familyIndexes[family.ID] = len(state.Active.Families)
		state.Active.Families = append(state.Active.Families, family)
	}
	if err := families.Err(); err != nil {
		families.Close()
		return state, err
	}
	families.Close()
	consumed, err := q.Query("SELECT digest,family_id,consumed_at FROM auth_consumed_handles ORDER BY family_id,digest")
	if err != nil {
		return state, err
	}
	for consumed.Next() {
		var digest, familyID []byte
		var consumedAt int64
		if err := consumed.Scan(&digest, &familyID, &consumedAt); err != nil {
			consumed.Close()
			return state, err
		}
		if len(digest) != 32 || len(familyID) != 32 {
			consumed.Close()
			return state, errors.New("auth database consumed-handle row is invalid")
		}
		familyKey := base64.RawURLEncoding.EncodeToString(familyID)
		index, ok := familyIndexes[familyKey]
		if !ok {
			consumed.Close()
			return state, errors.New("auth database consumed handle has no family")
		}
		state.Active.Families[index].Consumed = append(state.Active.Families[index].Consumed, accessV2Consumed{Digest: hex.EncodeToString(digest), ConsumedAt: consumedAt})
	}
	if err := consumed.Err(); err != nil {
		consumed.Close()
		return state, err
	}
	consumed.Close()
	if err := validateAccessDBState(state); err != nil {
		return state, err
	}
	return state, nil
}

func validateAccessDBState(state accessDBState) error {
	if _, err := parseAccessPasswordHash(state.PasswordRecord); err != nil {
		return err
	}
	if err := validateAccessV2Active(&state.Active); err != nil {
		return err
	}
	if _, err := decodeOptionalRefreshKey(state.Active.RefreshKey); err != nil {
		return err
	}
	for _, family := range state.Active.Families {
		if _, err := decodeAccessDigest(family.ActiveDigest); err != nil {
			return err
		}
		for _, consumed := range family.Consumed {
			if _, err := decodeAccessDigest(consumed.Digest); err != nil {
				return err
			}
		}
	}
	hasRecordID := state.Active.RecordID != ""
	hasRefreshKey := state.Active.RefreshKey != nil
	if hasRecordID != hasRefreshKey {
		return errors.New("auth database record ID and refresh key do not match")
	}
	if state.PasswordRecord == "" && (hasRecordID || len(state.Active.Families) != 0) {
		return errors.New("disabled auth database has active v2 state")
	}
	if len(state.Active.Families) != 0 && (!state.V2Available || !hasRecordID) {
		return errors.New("auth database families require available v2 state")
	}
	return nil
}

func encodeAccessUint64(value uint64) []byte {
	encoded := make([]byte, 8)
	binary.BigEndian.PutUint64(encoded, value)
	return encoded
}

func decodeOptionalAccessID(value string) ([]byte, error) {
	if value == "" {
		return []byte{}, nil
	}
	return decodeAccessID(value)
}

func decodeAccessID(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, errors.New("invalid auth database ID")
	}
	return decoded, nil
}

func decodeOptionalRefreshKey(value *string) ([]byte, error) {
	if value == nil {
		return []byte{}, nil
	}
	key, err := base64.RawURLEncoding.DecodeString(*value)
	if err != nil || len(key) != accessRefreshKeyBytes || base64.RawURLEncoding.EncodeToString(key) != *value {
		return nil, errors.New("invalid auth database refresh key")
	}
	return key, nil
}

func decodeAccessDigest(value string) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != value {
		return nil, errors.New("invalid auth database digest")
	}
	return decoded, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (s *accessDB) save(state accessDBState) error {
	if err := validateAccessDBState(state); err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	old, err := loadAccessDBState(tx)
	if err != nil {
		return err
	}
	if old.MigrationID != state.MigrationID || old.MigrationID != s.migrationID {
		return errors.New("auth database migration ID mismatch")
	}
	if err := updateAccessDBState(tx, state); err != nil {
		return err
	}
	if err := updateAccessDBFamilies(tx, old.Active.Families, state.Active.Families); err != nil {
		return err
	}
	if err := verifyAccessDBIntegrity(tx); err != nil {
		return err
	}
	if err := s.commit(tx); err != nil {
		return fmt.Errorf("%w: %v", errAccessDBCommitUncertain, err)
	}
	return nil
}

func updateAccessDBState(tx *sql.Tx, state accessDBState) error {
	recordID, err := decodeOptionalAccessID(state.Active.RecordID)
	if err != nil {
		return err
	}
	refreshKey, err := decodeOptionalRefreshKey(state.Active.RefreshKey)
	if err != nil {
		return err
	}
	result, err := tx.Exec(`UPDATE auth_state SET password_record=?,record_id=?,epoch=?,refresh_key=?,v2_available=? WHERE singleton_id=1`, state.PasswordRecord, recordID, encodeAccessUint64(state.Active.Epoch), refreshKey, boolInt(state.V2Available))
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = errors.New("auth state row disappeared")
		}
		return err
	}
	return nil
}

func updateAccessDBFamilies(tx *sql.Tx, oldFamilies, nextFamilies []accessV2Family) error {
	oldByID := make(map[string]accessV2Family, len(oldFamilies))
	nextByID := make(map[string]accessV2Family, len(nextFamilies))
	for _, family := range oldFamilies {
		oldByID[family.ID] = family
	}
	for _, family := range nextFamilies {
		nextByID[family.ID] = family
	}
	for id := range oldByID {
		if _, ok := nextByID[id]; ok {
			continue
		}
		familyID, err := decodeAccessID(id)
		if err != nil {
			return err
		}
		if _, err := tx.Exec("DELETE FROM auth_families WHERE family_id=?", familyID); err != nil {
			return err
		}
	}
	ids := make([]string, 0, len(nextByID))
	for id := range nextByID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		next := nextByID[id]
		old, existed := oldByID[id]
		if existed && reflect.DeepEqual(old, next) {
			continue
		}
		familyID, err := decodeAccessID(id)
		if err != nil {
			return err
		}
		activeDigest, err := decodeAccessDigest(next.ActiveDigest)
		if err != nil {
			return err
		}
		jti, err := decodeAccessID(next.CurrentAccess.Nonce)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO auth_families(family_id,generation,created_at,last_used_at,idle_expires_at,absolute_expires_at,active_digest,access_iat,access_exp,access_jti)
			VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(family_id) DO UPDATE SET generation=excluded.generation,created_at=excluded.created_at,last_used_at=excluded.last_used_at,idle_expires_at=excluded.idle_expires_at,absolute_expires_at=excluded.absolute_expires_at,active_digest=excluded.active_digest,access_iat=excluded.access_iat,access_exp=excluded.access_exp,access_jti=excluded.access_jti`, familyID, encodeAccessUint64(next.Generation), next.CreatedAt, next.LastUsedAt, next.IdleExpiresAt, next.AbsoluteExpiresAt, activeDigest, next.CurrentAccess.IssuedAt, next.CurrentAccess.ExpiresAt, jti); err != nil {
			return err
		}
		oldConsumed := make(map[string]struct{}, len(old.Consumed))
		nextConsumed := make(map[string]accessV2Consumed, len(next.Consumed))
		for _, consumed := range old.Consumed {
			oldConsumed[consumed.Digest] = struct{}{}
		}
		for _, consumed := range next.Consumed {
			nextConsumed[consumed.Digest] = consumed
		}
		for digest := range oldConsumed {
			if _, ok := nextConsumed[digest]; ok {
				continue
			}
			digestBytes, err := decodeAccessDigest(digest)
			if err != nil {
				return err
			}
			if _, err := tx.Exec("DELETE FROM auth_consumed_handles WHERE digest=?", digestBytes); err != nil {
				return err
			}
		}
		for digest, consumed := range nextConsumed {
			if _, ok := oldConsumed[digest]; ok {
				continue
			}
			digestBytes, err := decodeAccessDigest(digest)
			if err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO auth_consumed_handles(digest,family_id,consumed_at) VALUES(?,?,?)", digestBytes, familyID, consumed.ConsumedAt); err != nil {
				return err
			}
		}
	}
	return nil
}

// accessAuthMigrationMarker makes the Config/SQLite import crash-recoverable.
// Its ID is random but non-secret; the verifier and all sessions remain in auth.db.
type accessAuthMigrationMarker struct {
	State string `json:"state" toml:"state"`
	ID    string `json:"id" toml:"id"`
}

func accessMigrationID(marker *accessAuthMigrationMarker) ([16]byte, error) {
	var id [16]byte
	if marker == nil || (marker.State != "pending" && marker.State != "complete") {
		return id, errors.New("invalid auth migration marker state")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(marker.ID)
	if err != nil || len(decoded) != len(id) || base64.RawURLEncoding.EncodeToString(decoded) != marker.ID {
		return id, errors.New("invalid auth migration marker ID")
	}
	copy(id[:], decoded)
	return id, nil
}

func newAccessMigrationMarker(state string) (*accessAuthMigrationMarker, error) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	marker := &accessAuthMigrationMarker{State: state, ID: base64.RawURLEncoding.EncodeToString(id)}
	if _, err := accessMigrationID(marker); err != nil {
		return nil, err
	}
	return marker, nil
}

func readAccessMigrationConfig() (Config, error) {
	configMu.RLock()
	defer configMu.RUnlock()
	return readAccessMigrationConfigLocked()
}

func acquireAccessRollbackGuard() (func(), error) {
	lock := &accessStateLock{}
	if !lock.tryAcquire(accessV2LockPath()) {
		return nil, errors.New("access state is owned by a running Phi instance")
	}
	release := lock.release
	cfg, err := readAccessMigrationConfig()
	if err != nil {
		release()
		return nil, fmt.Errorf("cannot verify access migration state: %w", err)
	}
	if cfg.AccessAuthMigration != nil {
		release()
		return nil, errors.New("rollback refused after access auth migration started")
	}
	for _, path := range []string{accessDBPath(), accessV2StatePath()} {
		if _, err := os.Lstat(path); err == nil {
			release()
			return nil, errors.New("rollback refused because access auth state exists")
		} else if !os.IsNotExist(err) {
			release()
			return nil, fmt.Errorf("cannot inspect access auth state: %w", err)
		}
	}
	return release, nil
}

func validateAccessMigrationTOML(metadata toml.MetaData, cfg Config) error {
	fields := make(map[string]bool, 2)
	present := false
	for _, key := range metadata.Keys() {
		if len(key) == 0 || key[0] != "access_auth_migration" {
			continue
		}
		present = true
		if len(key) == 1 {
			continue
		}
		if len(key) != 2 || (key[1] != "state" && key[1] != "id") {
			return errors.New("invalid auth migration marker key")
		}
		fields[key[1]] = true
	}
	if !present {
		if cfg.AccessAuthMigration != nil {
			return errors.New("invalid auth migration marker")
		}
		return nil
	}
	if cfg.AccessAuthMigration == nil || !fields["state"] || !fields["id"] || len(fields) != 2 {
		return errors.New("invalid auth migration marker")
	}
	if _, err := accessMigrationID(cfg.AccessAuthMigration); err != nil {
		return err
	}
	return nil
}

func decodeAccessMigrationJSON(raw []byte, cfg *Config) error {
	if err := validateOneJSONValue(raw, true); err != nil {
		return err
	}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return err
	}
	markerRaw, ok := top["access_auth_migration"]
	if !ok {
		return nil
	}
	var marker accessAuthMigrationMarker
	decoder := json.NewDecoder(bytes.NewReader(markerRaw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&marker); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("invalid auth migration marker")
	}
	if _, err := accessMigrationID(&marker); err != nil {
		return err
	}
	cfg.AccessAuthMigration = &marker
	return nil
}

func readAccessMigrationConfigLocked() (Config, error) {
	return readConfigLocked()
}

func validateOneJSONValue(raw []byte, objectOnly bool) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil {
		return err
	}
	if objectOnly && first != json.Delim('{') {
		return errors.New("configuration must be one JSON object")
	}
	if err := scanStrictJSONValue(decoder, first); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func scanStrictJSONValue(decoder *json.Decoder, token json.Token) error {
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return errors.New("duplicate JSON object key")
			}
			seen[key] = struct{}{}
			value, err := decoder.Token()
			if err != nil {
				return err
			}
			if err := scanStrictJSONValue(decoder, value); err != nil {
				return err
			}
		}
		close, err := decoder.Token()
		if err != nil || close != json.Delim('}') {
			return errors.New("invalid JSON object")
		}
	case '[':
		for decoder.More() {
			value, err := decoder.Token()
			if err != nil {
				return err
			}
			if err := scanStrictJSONValue(decoder, value); err != nil {
				return err
			}
		}
		close, err := decoder.Token()
		if err != nil || close != json.Delim(']') {
			return errors.New("invalid JSON array")
		}
	default:
		return errors.New("invalid JSON delimiter")
	}
	return nil
}

func writeAccessMigrationConfig(expected *accessAuthMigrationMarker, expectedVerifier string, next *accessAuthMigrationMarker, nextVerifier string) error {
	configMu.Lock()
	defer configMu.Unlock()
	cfg, err := readAccessMigrationConfigLocked()
	if err != nil {
		return err
	}
	if cfg.AccessPasswordHash != expectedVerifier || !sameAccessMigrationMarker(cfg.AccessAuthMigration, expected) {
		return errors.New("auth migration Config changed during startup")
	}
	cfg.AccessPasswordHash = nextVerifier
	cfg.AccessAuthMigration = next
	if err := writeConfigContentsLocked(cfg); err != nil {
		return err
	}
	written, err := readAccessMigrationConfigLocked()
	if err != nil {
		return err
	}
	if written.AccessPasswordHash != nextVerifier || !sameAccessMigrationMarker(written.AccessAuthMigration, next) {
		return errors.New("auth migration Config write did not verify")
	}
	return nil
}

func sameAccessMigrationMarker(a, b *accessAuthMigrationMarker) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.State == b.State && a.ID == b.ID
}

func importAccessLegacyState(encoded string) (accessV2ActiveState, bool, error) {
	base := accessV2ActiveState{RecordBinding: accessRecordBinding(encoded), Epoch: 1, Families: []accessV2Family{}}
	state, err := loadAccessV2StateFile(accessV2StatePath())
	if err != nil {
		return base, false, nil
	}
	if state == nil {
		return base, true, nil
	}
	active := state.Active
	binding := accessRecordBinding(encoded)
	switch {
	case state.Pending != nil && accessRecordBinding(state.Pending.PasswordRecord) == binding:
		active = state.Pending.Next
	case state.Pending != nil && (active.RecordBinding == binding || state.Pending.FromRecordBinding == binding):
		// Config still carries the active record; discard the pending candidate.
	case state.Pending != nil:
		active = accessRevokedState(active, binding)
	case active.RecordBinding != binding:
		active = accessRevokedState(active, binding)
	}
	if active.RecordBinding != binding {
		return base, false, nil
	}
	if err := validateAccessDBState(accessDBState{
		PasswordRecord: encoded,
		V2Available:    true,
		Active:         active,
	}); err != nil {
		return base, false, nil
	}
	return active, true, nil
}

func (m *accessAuthManager) openMigratedAccessDB() (accessDBState, *accessDB, error) {
	cfg, err := readAccessMigrationConfig()
	if err != nil {
		return accessDBState{}, nil, err
	}
	path := accessDBPath()
	_, statErr := os.Lstat(path)
	dbExists := statErr == nil
	if statErr != nil && !os.IsNotExist(statErr) {
		return accessDBState{}, nil, statErr
	}
	if cfg.AccessAuthMigration == nil {
		if dbExists {
			return accessDBState{}, nil, errors.New("auth database exists without a migration marker")
		}
		if _, err := parseAccessPasswordHash(cfg.AccessPasswordHash); err != nil {
			return accessDBState{}, nil, err
		}
		marker, err := newAccessMigrationMarker("pending")
		if err != nil {
			return accessDBState{}, nil, err
		}
		if err := writeAccessMigrationConfig(nil, cfg.AccessPasswordHash, marker, cfg.AccessPasswordHash); err != nil {
			return accessDBState{}, nil, err
		}
		cfg.AccessAuthMigration = marker
	}
	migrationID, err := accessMigrationID(cfg.AccessAuthMigration)
	if err != nil {
		return accessDBState{}, nil, err
	}
	switch cfg.AccessAuthMigration.State {
	case "pending":
		if _, err := parseAccessPasswordHash(cfg.AccessPasswordHash); err != nil {
			return accessDBState{}, nil, err
		}
		store, err := openAccessDB(path, !dbExists)
		if err != nil {
			return accessDBState{}, nil, err
		}
		store.migrationID = migrationID
		pristine, err := store.isPristine()
		if err != nil {
			store.close()
			return accessDBState{}, nil, err
		}
		var state accessDBState
		if pristine {
			active, available, err := importAccessLegacyState(cfg.AccessPasswordHash)
			if err != nil {
				store.close()
				return accessDBState{}, nil, err
			}
			state = accessDBState{PasswordRecord: cfg.AccessPasswordHash, MigrationID: migrationID, V2Available: available, Active: active}
			if err := store.initialize(state); err != nil {
				store.close()
				return accessDBState{}, nil, err
			}
		} else {
			state, err = store.verify(migrationID)
			if err != nil {
				store.close()
				return accessDBState{}, nil, err
			}
			if state.PasswordRecord != cfg.AccessPasswordHash {
				store.close()
				return accessDBState{}, nil, errors.New("pending auth database verifier does not match Config")
			}
		}
		state, err = store.verify(migrationID)
		if err != nil {
			store.close()
			return accessDBState{}, nil, err
		}
		if state.PasswordRecord != cfg.AccessPasswordHash {
			store.close()
			return accessDBState{}, nil, errors.New("imported auth database verifier does not match Config")
		}
		complete := *cfg.AccessAuthMigration
		complete.State = "complete"
		if err := writeAccessMigrationConfig(cfg.AccessAuthMigration, cfg.AccessPasswordHash, &complete, ""); err != nil {
			store.close()
			return accessDBState{}, nil, err
		}
		verifiedConfig, err := readAccessMigrationConfig()
		if err != nil || verifiedConfig.AccessPasswordHash != "" || !sameAccessMigrationMarker(verifiedConfig.AccessAuthMigration, &complete) {
			store.close()
			if err == nil {
				err = errors.New("completed auth migration Config did not verify")
			}
			return accessDBState{}, nil, err
		}
		removeLegacyAccessState()
		return state, store, nil
	case "complete":
		if cfg.AccessPasswordHash != "" {
			return accessDBState{}, nil, errors.New("completed auth migration still has a Config verifier")
		}
		if !dbExists {
			return accessDBState{}, nil, os.ErrNotExist
		}
		store, err := openAccessDB(path, false)
		if err != nil {
			return accessDBState{}, nil, err
		}
		store.migrationID = migrationID
		state, err := store.verify(migrationID)
		if err != nil {
			store.close()
			return accessDBState{}, nil, err
		}
		marker := *cfg.AccessAuthMigration
		if err := writeAccessMigrationConfig(&marker, "", &marker, ""); err != nil {
			store.close()
			return accessDBState{}, nil, err
		}
		verifiedConfig, err := readAccessMigrationConfig()
		if err != nil || verifiedConfig.AccessPasswordHash != "" || !sameAccessMigrationMarker(verifiedConfig.AccessAuthMigration, &marker) {
			store.close()
			if err == nil {
				err = errors.New("completed auth migration Config did not verify")
			}
			return accessDBState{}, nil, err
		}
		removeLegacyAccessState()
		return state, store, nil
	default:
		return accessDBState{}, nil, errors.New("invalid auth migration marker state")
	}
}

func removeLegacyAccessState() {
	if err := os.Remove(accessV2StatePath()); err != nil && !os.IsNotExist(err) {
		log.Printf("[auth] could not remove legacy auth state after verified migration")
	}
}
