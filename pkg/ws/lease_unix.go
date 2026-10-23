//go:build unix

package ws

import (
	"os"

	"golang.org/x/sys/unix"
)

func lockFileNonblocking(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

func lockFileBlocking(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX)
}
