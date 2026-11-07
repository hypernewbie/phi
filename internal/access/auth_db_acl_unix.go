//go:build unix

package access

import "os"

func secureAccessDBFile(path string, _ os.FileInfo) error {
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	return verifyAccessDBFileACL(path)
}

func verifyAccessDBFileACL(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return os.ErrPermission
	}
	return nil
}
