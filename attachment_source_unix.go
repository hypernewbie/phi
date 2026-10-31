//go:build unix

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func attachmentSourceIdentity(info os.FileInfo) string {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)
}

func openAttachmentSource(path string) (*os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("not an absolute path")
	}
	path = filepath.Clean(path)
	parentPath, base := filepath.Dir(path), filepath.Base(path)
	if base == "." || base == string(filepath.Separator) {
		return nil, fmt.Errorf("not a file path")
	}
	parent, err := openAttachmentDirectoryNoFollow(parentPath)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	fd, err := unix.Openat(int(parent.Fd()), base, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG {
		_ = unix.Close(fd)
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("not a regular file")
	}
	return os.NewFile(uintptr(fd), path), nil
}

func openAttachmentDirectoryNoFollow(path string) (*os.File, error) {
	fd, err := unix.Open(string(filepath.Separator), unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.Trim(path, string(filepath.Separator)), string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		next, openErr := unix.Openat(fd, part, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), path), nil
}
