//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

type attachmentStoreLock struct {
	file       *os.File
	overlapped windows.Overlapped
}

func lockAttachmentStore(path string) (*attachmentStoreLock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	lock := &attachmentStoreLock{file: f}
	if err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &lock.overlapped); err != nil {
		_ = f.Close()
		return nil, err
	}
	return lock, nil
}

func (l *attachmentStoreLock) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	unlockErr := windows.UnlockFileEx(windows.Handle(l.file.Fd()), 0, 1, 0, &l.overlapped)
	closeErr := l.file.Close()
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}
