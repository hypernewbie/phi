//go:build windows

package access

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"golang.org/x/sys/windows"
)

func TestAccessDBWindowsACLHealsInheritedAndPermissiveDACL(t *testing.T) {
	withTempConfig(t)

	userSID, err := currentAccessDBUserSID()
	if err != nil {
		t.Fatalf("currentAccessDBUserSID: %v", err)
	}

	// Create a parent directory with an explicit inheritable Allow rule for
	// BUILTIN\Users (S-1-5-32-545), simulating a profile directory with extra
	// sandbox/group ACEs that newly created files inherit by default on Windows.
	parentDir := filepath.Join(t.TempDir(), "inherited-parent")
	if err := os.MkdirAll(parentDir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	parentSDDL := "D:P(A;OICI;FA;;;" + userSID + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)"
	parentSD, err := windows.SecurityDescriptorFromString(parentSDDL)
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString parent: %v", err)
	}
	parentDACL, _, err := parentSD.DACL()
	if err != nil {
		t.Fatalf("parentSD.DACL: %v", err)
	}
	if err := windows.SetNamedSecurityInfo(
		parentDir,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		parentDACL,
		nil,
	); err != nil {
		t.Fatalf("SetNamedSecurityInfo parentDir: %v", err)
	}

	dbPath := filepath.Join(parentDir, "auth.db")
	f, err := os.OpenFile(dbPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	_ = f.Close()

	// Before secureAccessDBFile runs, the raw file inherits BUILTIN\Users from parentDir
	// and has an unprotected DACL, which verifyAccessDBFileACL must flag.
	if err := verifyAccessDBFileACL(dbPath); err == nil {
		t.Fatal("expected raw inherited file to fail verifyAccessDBFileACL before securing")
	}

	// Opening the DB via openAccessDB must heal the inherited DACL automatically
	// and succeed without requiring manual intervention.
	store, err := openAccessDB(dbPath, false)
	if err != nil {
		t.Fatalf("openAccessDB failed to heal inherited Windows ACL: %v", err)
	}
	defer store.close()

	if err := verifyAccessDBFileACL(dbPath); err != nil {
		t.Fatalf("verifyAccessDBFileACL after openAccessDB: %v", err)
	}

	// Tamper with the DACL by granting BUILTIN\Users read access and verify that
	// verifyAccessDBFileACL catches it, then confirm secureAccessDBFile repairs it.
	tamperedSDDL := "D:P(A;;FA;;;" + userSID + ")(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)"
	tamperedSD, err := windows.SecurityDescriptorFromString(tamperedSDDL)
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString tampered: %v", err)
	}
	tamperedDACL, _, err := tamperedSD.DACL()
	if err != nil {
		t.Fatalf("tamperedSD.DACL: %v", err)
	}
	if err := windows.SetNamedSecurityInfo(
		dbPath,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		tamperedDACL,
		nil,
	); err != nil {
		t.Fatalf("SetNamedSecurityInfo tampered: %v", err)
	}

	if err := verifyAccessDBFileACL(dbPath); err == nil || !strings.Contains(err.Error(), "not restricted to its owner") {
		t.Fatalf("verifyAccessDBFileACL on tampered file = %v, want error containing 'not restricted to its owner'", err)
	}

	info, err := os.Lstat(dbPath)
	if err != nil {
		t.Fatalf("Lstat: %v", err)
	}
	if err := secureAccessDBFile(dbPath, info); err != nil {
		t.Fatalf("secureAccessDBFile failed to repair tampered DACL: %v", err)
	}
	if err := verifyAccessDBFileACL(dbPath); err != nil {
		t.Fatalf("verifyAccessDBFileACL after repair: %v", err)
	}
}

func TestAccessDBWindowsACLConfigureEndToEndWithAdminOwnerAndInheritedACEs(t *testing.T) {
	withTempConfig(t)
	manager := newTestManager(t)

	userSID, err := currentAccessDBUserSID()
	if err != nil {
		t.Fatalf("currentAccessDBUserSID: %v", err)
	}

	encoded := testAccessHash()
	cfg := Config{
		AccessPasswordHash: encoded,
		AccessAuthMigration: &accessAuthMigrationMarker{
			State: "pending",
			ID:    base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
		},
	}
	raw, err := toml.Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal config: %v", err)
	}
	if err := os.WriteFile(configFilePath(), raw, 0o600); err != nil {
		t.Fatalf("WriteFile config: %v", err)
	}

	// Pre-create auth.db with an unprotected DACL and BUILTIN\Users access, and
	// attempt to set BUILTIN\Administrators as owner (matching elevated creation).
	dbPath := manager.accessDBPath()
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	f, err := os.OpenFile(dbPath, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	_ = f.Close()

	adminSID, err := windows.StringToSid(builtinAdminsSID)
	if err != nil {
		t.Fatalf("StringToSid admin: %v", err)
	}
	permissiveSD, err := windows.SecurityDescriptorFromString("D:(A;;FA;;;" + userSID + ")(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;WD)")
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString permissive: %v", err)
	}
	permissiveDACL, _, err := permissiveSD.DACL()
	if err != nil {
		t.Fatalf("permissiveSD.DACL: %v", err)
	}
	_ = windows.SetNamedSecurityInfo(
		dbPath,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION,
		adminSID,
		nil,
		permissiveDACL,
		nil,
	)

	// Configure must heal the ACL on auth.db, complete the migration, and leave
	// the database strictly restricted to the owner without errors.
	if err := manager.Configure(encoded); err != nil {
		t.Fatalf("manager.Configure failed on Windows with pre-existing permissive/admin-owned auth.db: %v", err)
	}
	if err := verifyAccessDBFileACL(dbPath); err != nil {
		t.Fatalf("verifyAccessDBFileACL after Configure: %v", err)
	}
}
