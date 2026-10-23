//go:build windows

package ws

import (
	"os"

	"golang.org/x/sys/windows"
)

func lockFileNonblocking(f *os.File) error {
	return lockRegion(f, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY)
}

func lockFileBlocking(f *os.File) error {
	return lockRegion(f, windows.LOCKFILE_EXCLUSIVE_LOCK)
}

func lockRegion(f *os.File, flags uint32) error {
	var overlapped windows.Overlapped
	// Lock one byte; the region is arbitrary because only this lease file
	// is ever locked and the handle stays open for the owner's lifetime.
	return windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &overlapped)
}
