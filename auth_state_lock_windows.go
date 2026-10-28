//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

func lockAuthStateFile(f *os.File) error {
	return lockAuthStateRegion(f, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY)
}

func unlockAuthStateRegionUnlock(f *os.File) error {
	return lockAuthStateRegion(f, 0)
}

func lockAuthStateRegion(f *os.File, flags uint32) error {
	var overlapped windows.Overlapped
	// One byte is enough: only this lock file is ever locked and the handle
	// stays open for as long as the process owns the state.
	return windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &overlapped)
}

func unlockAuthStateFile(f *os.File) error {
	return unlockAuthStateRegionUnlock(f)
}
