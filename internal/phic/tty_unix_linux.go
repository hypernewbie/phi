//go:build linux

package phic

import "golang.org/x/sys/unix"

// Linux uses TCGETS/TCSETS where BSD uses TIOCGETA/TIOCSETA.
const (
	termiosGet = unix.TCGETS
	termiosSet = unix.TCSETS
)

func waitTTY(fd, milliseconds int) (bool, error) {
	fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	n, err := unix.Poll(fds, milliseconds)
	if err != nil {
		return false, err
	}
	if n == 0 {
		return false, nil
	}
	if fds[0].Revents&unix.POLLIN != 0 {
		return true, nil
	}
	return false, unix.EIO
}
