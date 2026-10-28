package system

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// WriteFileAtomic writes data to a temp file, syncs it, and renames it to the destination.
func WriteFileAtomic(filename string, data []byte, perm os.FileMode) error {
	return writeFileAtomic(filename, data, perm, false)
}

// syncParentDir makes a rename durable by syncing the directory that holds the
// destination. Windows has no directory fsync: a rename there survives a
// process crash but not a power loss, so this path stays best-effort there and
// callers must not claim power-loss durability on Windows.
func syncParentDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	handle, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("failed to open directory for sync: %w", err)
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return fmt.Errorf("failed to sync directory: %w", err)
	}
	return nil
}

// Test seams. The strict replacement path must propagate each fallible step as
// a real failure, so the three operations that fail in production (chmod, the
// rename, and the parent-directory sync) are variables. Production values are
// the os functions; tests replace them to inject failures. WriteFileAtomic's
// legacy path keeps calling the os functions directly, so this seam cannot
// change its behavior.
var (
	atomicRename  = os.Rename
	atomicChmod   = os.Chmod
	atomicSyncDir = syncParentDir
)

// WriteFileAtomicPreserveExisting replaces filename like WriteFileAtomic, but
// never deletes the existing destination. The Windows fallback in
// WriteFileAtomic removes the destination before retrying the rename, which
// can lose the old file if the retry also fails. Callers that must keep the
// previous contents on failure (config writes) use this variant instead: it
// propagates chmod errors and returns immediately after a failed rename.
func WriteFileAtomicPreserveExisting(filename string, data []byte, perm os.FileMode) error {
	return writeFileAtomic(filename, data, perm, true)
}

func writeFileAtomic(filename string, data []byte, perm os.FileMode, preserveExisting bool) error {
	dir := filepath.Dir(filename)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, "atomic-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		if tmp != nil {
			_ = tmp.Close()
		}
		_ = os.Remove(tmpName)
	}()

	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("failed to write to temp file: %w", err)
	}

	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("failed to sync temp file: %w", err)
	}

	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close temp file: %w", err)
	}
	tmp = nil // Prevent defer from closing it again

	// Set permissions before renaming
	chmod := os.Chmod
	if preserveExisting {
		chmod = atomicChmod
	}
	if err := chmod(tmpName, perm); err != nil && preserveExisting {
		return fmt.Errorf("failed to set permissions on temp file: %w", err)
	}

	if preserveExisting {
		if err := atomicRename(tmpName, filename); err != nil {
			return fmt.Errorf("failed to rename temp file to %s: %w", filename, err)
		}
		// A rename is only durable once the directory entry is synced. A failure
		// here is reported, not rolled back: the rename already happened, so the
		// caller must treat the write as committed-but-unconfirmed.
		return atomicSyncDir(dir)
	}

	// Windows: os.Rename replaces atomically (MOVEFILE_REPLACE_EXISTING); fallback handles AV-locked files.
	if runtime.GOOS == "windows" {
		if err := os.Rename(tmpName, filename); err == nil {
			return nil
		}
		_ = os.Remove(filename)
		if err := os.Rename(tmpName, filename); err != nil {
			return fmt.Errorf("failed to rename temp file to %s: %w", filename, err)
		}
		return nil
	}

	// On Unix/POSIX, os.Rename is atomic and replaces the destination file if it exists.
	if err := os.Rename(tmpName, filename); err != nil {
		return fmt.Errorf("failed to rename temp file to %s: %w", filename, err)
	}

	return nil
}
