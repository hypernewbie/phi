//go:build windows

package access

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	localSystemSID       = "S-1-5-18"
	builtinAdminsSID     = "S-1-5-32-544"
	errAccessDBACLString = "auth database ACL is not restricted to its owner"
)

func currentAccessDBUser() (*windows.SID, string, error) {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return nil, "", err
	}
	defer token.Close()

	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return nil, "", errors.New(errAccessDBACLString)
	}
	sidCopy, err := user.User.Sid.Copy()
	if err != nil {
		return nil, "", errors.New(errAccessDBACLString)
	}
	return sidCopy, sidCopy.String(), nil
}

func currentAccessDBUserSID() (string, error) {
	_, sidStr, err := currentAccessDBUser()
	return sidStr, err
}

func secureAccessDBFile(path string, _ os.FileInfo) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("auth database path is not a regular file")
	}

	userSIDObj, userSID, err := currentAccessDBUser()
	if err != nil {
		return errors.New(errAccessDBACLString)
	}

	// Build a protected DACL granting full control only to the current user,
	// Local System, and Built-in Administrators, stripping inherited parent ACEs.
	sddl := "D:P"
	seen := make(map[string]bool, 3)
	for _, sid := range []string{userSID, localSystemSID, builtinAdminsSID} {
		if sid == "" || seen[sid] {
			continue
		}
		seen[sid] = true
		sddl += "(A;;FA;;;" + sid + ")"
	}

	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return errors.New(errAccessDBACLString)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return errors.New(errAccessDBACLString)
	}

	// Prefer normalising ownership to the current user SID as well so switching
	// between elevated and standard sessions never leaves an unreachable owner;
	// fall back to updating the protected DACL alone if ownership cannot change.
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		userSIDObj,
		nil,
		dacl,
		nil,
	); err != nil {
		if err := windows.SetNamedSecurityInfo(
			path,
			windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
			nil,
			nil,
			dacl,
			nil,
		); err != nil {
			return errors.New(errAccessDBACLString)
		}
	}

	return verifyAccessDBFileACL(path)
}

func verifyAccessDBFileACL(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New(errAccessDBACLString)
	}

	userSID, err := currentAccessDBUserSID()
	if err != nil {
		return errors.New(errAccessDBACLString)
	}

	sd, err := windows.GetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil || sd == nil || !sd.IsValid() {
		return errors.New(errAccessDBACLString)
	}

	// When running elevated on Windows, newly created files default their object
	// owner to BUILTIN\Administrators rather than the individual user SID.
	ownerSID, _, err := sd.Owner()
	if err != nil || ownerSID == nil || !ownerSID.IsValid() {
		return errors.New(errAccessDBACLString)
	}
	ownerStr := ownerSID.String()
	if ownerStr != userSID && ownerStr != builtinAdminsSID && ownerStr != localSystemSID {
		return errors.New(errAccessDBACLString)
	}

	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PRESENT == 0 || control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New(errAccessDBACLString)
	}

	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount == 0 {
		return errors.New(errAccessDBACLString)
	}

	hasUserAllow := false
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil || ace == nil {
			return errors.New(errAccessDBACLString)
		}
		if ace.Header.AceFlags&windows.INHERITED_ACE != 0 {
			return errors.New(errAccessDBACLString)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !aceSID.IsValid() {
			return errors.New(errAccessDBACLString)
		}
		sidStr := aceSID.String()
		if sidStr != userSID && sidStr != localSystemSID && sidStr != builtinAdminsSID {
			return errors.New(errAccessDBACLString)
		}
		if sidStr == userSID {
			hasUserAllow = true
		}
	}
	if !hasUserAllow {
		return errors.New(errAccessDBACLString)
	}
	return nil
}
