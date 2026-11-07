package access

import (
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAccessDBFileURIEdgeCases(t *testing.T) {
	testCases := []struct {
		name       string
		path       string
		wantURI    string
		wantPath   string
	}{
		{
			name:     "Windows drive uppercase backslash",
			path:     `C:\Users\test\auth.db`,
			wantURI:  "file:///C:/Users/test/auth.db",
			wantPath: "/C:/Users/test/auth.db",
		},
		{
			name:     "Windows drive lowercase slash",
			path:     "d:/phi/auth.db",
			wantURI:  "file:///d:/phi/auth.db",
			wantPath: "/d:/phi/auth.db",
		},
		{
			name:     "Unix-style path",
			path:     "/tmp/phi/auth.db",
			wantURI:  "file:///tmp/phi/auth.db",
			wantPath: "/tmp/phi/auth.db",
		},
		{
			name:     "Windows drive path with spaces",
			path:     `C:\Users\test user\sub dir\auth.db`,
			wantURI:  "file:///C:/Users/test%20user/sub%20dir/auth.db",
			wantPath: "/C:/Users/test user/sub dir/auth.db",
		},
		{
			name:     "Windows drive path with special characters",
			path:     `C:\Users\test#dir\query?name\pct%sign\auth.db`,
			wantURI:  "file:///C:/Users/test%23dir/query%3Fname/pct%25sign/auth.db",
			wantPath: "/C:/Users/test#dir/query?name/pct%sign/auth.db",
		},
		{
			name:     "Unix-style path with spaces and special characters",
			path:     "/tmp/phi dir/hash#tag/q?mark/pct%value/auth.db",
			wantURI:  "file:///tmp/phi%20dir/hash%23tag/q%3Fmark/pct%25value/auth.db",
			wantPath: "/tmp/phi dir/hash#tag/q?mark/pct%value/auth.db",
		},
		{
			name:     "Windows drive path lowercase with special characters and spaces",
			path:     "d:/phi spaces/tag#1/find?all/ratio%50/auth.db",
			wantURI:  "file:///d:/phi%20spaces/tag%231/find%3Fall/ratio%2550/auth.db",
			wantPath: "/d:/phi spaces/tag#1/find?all/ratio%50/auth.db",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			got := accessDBFileURI(tc.path)
			if got != tc.wantURI {
				t.Fatalf("accessDBFileURI(%q) = %q, want %q", tc.path, got, tc.wantURI)
			}

			parsed, err := url.Parse(got)
			if err != nil {
				t.Fatalf("url.Parse(%q) failed: %v", got, err)
			}
			if parsed.Scheme != "file" {
				t.Errorf("parsed URL scheme = %q, want file", parsed.Scheme)
			}
			if parsed.Path != tc.wantPath {
				t.Errorf("parsed URL path = %q, want %q", parsed.Path, tc.wantPath)
			}
			if parsed.RawQuery != "" {
				t.Errorf("parsed URL query unexpectedly retained: %q", parsed.RawQuery)
			}
			if parsed.Fragment != "" {
				t.Errorf("parsed URL fragment unexpectedly retained: %q", parsed.Fragment)
			}
		})
	}
}

func TestReadOnlyAccessDBVerifierEdgeCases(t *testing.T) {
	t.Run("missing file returns error", func(t *testing.T) {
		missingPath := filepath.Join(t.TempDir(), "missing-auth.db")
		if _, err := readOnlyAccessDBVerifier(missingPath); err == nil {
			t.Fatal("expected error for non-existent file, got nil")
		} else if !os.IsNotExist(err) && !errors.Is(err, os.ErrNotExist) {
			t.Logf("missing file returned expected error: %v", err)
		}
	})

	t.Run("directory path returns not a regular file error", func(t *testing.T) {
		dirPath := t.TempDir()
		_, err := readOnlyAccessDBVerifier(dirPath)
		if err == nil {
			t.Fatal("expected error for directory path, got nil")
		}
		if !strings.Contains(err.Error(), "auth database path is not a regular file") {
			t.Fatalf("unexpected error message: got %q, want substring 'auth database path is not a regular file'", err.Error())
		}
	})

	t.Run("uninitialised empty file returns unsupported schema error", func(t *testing.T) {
		emptyFile := filepath.Join(t.TempDir(), "empty.db")
		if err := os.WriteFile(emptyFile, []byte{}, 0o600); err != nil {
			t.Fatalf("create empty file: %v", err)
		}
		_, err := readOnlyAccessDBVerifier(emptyFile)
		if err == nil {
			t.Fatal("expected error for empty file, got nil")
		}
		if !strings.Contains(err.Error(), "unsupported auth database schema") {
			t.Fatalf("unexpected error message: got %q, want substring 'unsupported auth database schema'", err.Error())
		}
	})

	t.Run("database with wrong user version returns unsupported schema error", func(t *testing.T) {
		wrongVersionFile := filepath.Join(t.TempDir(), "wrong_version.db")
		db, err := sql.Open("sqlite", accessDBFileURI(wrongVersionFile))
		if err != nil {
			t.Fatalf("open sqlite db: %v", err)
		}
		if _, err := db.Exec("PRAGMA user_version = 42"); err != nil {
			_ = db.Close()
			t.Fatalf("set PRAGMA user_version: %v", err)
		}
		_ = db.Close()

		_, err = readOnlyAccessDBVerifier(wrongVersionFile)
		if err == nil {
			t.Fatal("expected error for wrong user version, got nil")
		}
		if !strings.Contains(err.Error(), "unsupported auth database schema") {
			t.Fatalf("unexpected error message: got %q, want substring 'unsupported auth database schema'", err.Error())
		}
	})

	t.Run("initialised schema with 0 rows in auth_state returns unavailable error", func(t *testing.T) {
		zeroRowsFile := filepath.Join(t.TempDir(), "zero_rows.db")
		db, err := sql.Open("sqlite", accessDBFileURI(zeroRowsFile))
		if err != nil {
			t.Fatalf("open sqlite db: %v", err)
		}
		if _, err := db.Exec("PRAGMA user_version = 1"); err != nil {
			_ = db.Close()
			t.Fatalf("set PRAGMA user_version: %v", err)
		}
		for _, stmt := range accessDBSchemaSQL {
			if _, err := db.Exec(stmt); err != nil {
				_ = db.Close()
				t.Fatalf("exec schema statement: %v", err)
			}
		}
		_ = db.Close()

		_, err = readOnlyAccessDBVerifier(zeroRowsFile)
		if err == nil {
			t.Fatal("expected error for 0 rows in auth_state, got nil")
		}
		if !strings.Contains(err.Error(), "auth database state is unavailable") {
			t.Fatalf("unexpected error message: got %q, want substring 'auth database state is unavailable'", err.Error())
		}
	})

	t.Run("initialised schema with corrupted password record returns error", func(t *testing.T) {
		corruptFile := filepath.Join(t.TempDir(), "corrupt_record.db")
		db, err := sql.Open("sqlite", accessDBFileURI(corruptFile))
		if err != nil {
			t.Fatalf("open sqlite db: %v", err)
		}
		if _, err := db.Exec("PRAGMA user_version = 1"); err != nil {
			_ = db.Close()
			t.Fatalf("set PRAGMA user_version: %v", err)
		}
		for _, stmt := range accessDBSchemaSQL {
			if _, err := db.Exec(stmt); err != nil {
				_ = db.Close()
				t.Fatalf("exec schema statement: %v", err)
			}
		}
		var epoch [8]byte
		var migrationID [16]byte
		if _, err := db.Exec(`INSERT INTO auth_state(singleton_id, password_record, record_id, epoch, refresh_key, v2_available, migration_id)
			VALUES(1, ?, ?, ?, ?, ?, ?)`, "corrupted$not_a_valid_hash", []byte{}, epoch[:], []byte{}, 1, migrationID[:]); err != nil {
			_ = db.Close()
			t.Fatalf("insert corrupted auth state: %v", err)
		}
		_ = db.Close()

		_, err = readOnlyAccessDBVerifier(corruptFile)
		if err == nil {
			t.Fatal("expected error for corrupted password record, got nil")
		}
	})

	t.Run("valid initialised accessDB returns exact encoded password hash", func(t *testing.T) {
		validFile := filepath.Join(t.TempDir(), "valid_auth.db")
		store, err := openAccessDB(validFile, true)
		if err != nil {
			t.Fatalf("openAccessDB failed: %v", err)
		}
		defer store.close()

		active, migrationID, err := accessDBTestState()
		if err != nil {
			t.Fatalf("accessDBTestState failed: %v", err)
		}
		encoded := testAccessHash()
		active.RecordBinding = accessRecordBinding(encoded)

		state := accessDBState{
			PasswordRecord: encoded,
			MigrationID:    migrationID,
			V2Available:    true,
			Active:         active,
		}
		if err := store.initialize(state); err != nil {
			t.Fatalf("initialize failed: %v", err)
		}
		if err := store.close(); err != nil {
			t.Fatalf("close failed: %v", err)
		}

		got, err := readOnlyAccessDBVerifier(validFile)
		if err != nil {
			t.Fatalf("readOnlyAccessDBVerifier failed: %v", err)
		}
		if got != encoded {
			t.Fatalf("readOnlyAccessDBVerifier returned %q, want %q", got, encoded)
		}
	})
}

func TestAccessDBCloseAndPristineIdempotency(t *testing.T) {
	t.Run("close on nil and already closed accessDB is safe and returns nil", func(t *testing.T) {
		var nilDB *accessDB
		if err := nilDB.close(); err != nil {
			t.Errorf("nil *accessDB close returned error: %v", err)
		}

		dbPath := filepath.Join(t.TempDir(), "idempotent_close.db")
		store, err := openAccessDB(dbPath, true)
		if err != nil {
			t.Fatalf("openAccessDB failed: %v", err)
		}
		if err := store.close(); err != nil {
			t.Fatalf("first close failed: %v", err)
		}
		if err := store.close(); err != nil {
			t.Errorf("second close on already closed store returned error: %v", err)
		}
	})

	t.Run("openAccessDB without create on missing path returns os.ErrNotExist", func(t *testing.T) {
		missingPath := filepath.Join(t.TempDir(), "missing_dir", "auth.db")
		store, err := openAccessDB(missingPath, false)
		if store != nil {
			_ = store.close()
			t.Fatalf("expected nil store for missing path, got %v", store)
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("openAccessDB error = %v, want os.ErrNotExist", err)
		}
	})

	t.Run("isPristine returns true on fresh db and false after initialize", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "pristine_check.db")
		store, err := openAccessDB(dbPath, true)
		if err != nil {
			t.Fatalf("openAccessDB failed: %v", err)
		}
		defer store.close()

		pristine, err := store.isPristine()
		if err != nil {
			t.Fatalf("isPristine failed on fresh database: %v", err)
		}
		if !pristine {
			t.Fatal("expected freshly opened database to be pristine")
		}

		active, migrationID, err := accessDBTestState()
		if err != nil {
			t.Fatalf("accessDBTestState failed: %v", err)
		}
		encoded := testAccessHash()
		active.RecordBinding = accessRecordBinding(encoded)

		state := accessDBState{
			PasswordRecord: encoded,
			MigrationID:    migrationID,
			V2Available:    true,
			Active:         active,
		}
		if err := store.initialize(state); err != nil {
			t.Fatalf("initialize failed: %v", err)
		}

		pristine, err = store.isPristine()
		if err != nil {
			t.Fatalf("isPristine failed after initialize: %v", err)
		}
		if pristine {
			t.Fatal("expected initialised database not to be pristine")
		}
	})
}

func TestSecureAndVerifyAccessDBFileMissingAndDirectory(t *testing.T) {
	t.Run("missing path returns error", func(t *testing.T) {
		missingPath := filepath.Join(t.TempDir(), "missing.db")
		if err := secureAccessDBFile(missingPath, nil); err == nil {
			t.Errorf("secureAccessDBFile on missing path returned nil, want error")
		}
		if err := verifyAccessDBFileACL(missingPath); err == nil {
			t.Errorf("verifyAccessDBFileACL on missing path returned nil, want error")
		}
	})

	t.Run("directory path returns error", func(t *testing.T) {
		dirPath := filepath.Join(t.TempDir(), "test_dir")
		if err := os.MkdirAll(dirPath, 0o700); err != nil {
			t.Fatalf("MkdirAll failed: %v", err)
		}
		info, err := os.Lstat(dirPath)
		if err != nil {
			t.Fatalf("Lstat failed: %v", err)
		}
		if err := secureAccessDBFile(dirPath, info); err == nil {
			t.Errorf("secureAccessDBFile on directory path returned nil, want error")
		}
		if err := verifyAccessDBFileACL(dirPath); err == nil {
			t.Errorf("verifyAccessDBFileACL on directory path returned nil, want error")
		}
	})
}
