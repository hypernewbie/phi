//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

func attachmentSourceIdentity(info os.FileInfo) string {
	stat, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%+v:%d:%d:%d", stat.CreationTime, stat.FileAttributes, stat.FileSizeHigh, stat.FileSizeLow)
}

func openAttachmentSource(path string) (*os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("not an absolute path")
	}
	parentPath := filepath.Dir(filepath.Clean(path))
	name, err := syscall.UTF16PtrFromString(parentPath)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(
		name,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return nil, err
	}
	var info windows.ByHandleFileInformation
	infoErr := windows.GetFileInformationByHandle(handle, &info)
	_ = windows.CloseHandle(handle)
	if infoErr != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		if infoErr != nil {
			return nil, infoErr
		}
		return nil, fmt.Errorf("not a regular parent directory")
	}
	return openAttachmentRegularNoFollow(filepath.Clean(path))
}
