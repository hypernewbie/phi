//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package phic

import (
	"golang.org/x/sys/unix"
	"time"
)

// termios constants differ between Linux (TCGETS/TCSETS) and
// the BSD-derived kernels (TIOCGETA/TIOCSETA). The IoctlGetTermios
// signature is the same on both, so a build-tag switch is enough.
const (
	termiosGet = unix.TIOCGETA
	termiosSet = unix.TIOCSETA
)

// Darwin's /dev/tty alias does not support poll (POLLNVAL). Select works
// for both that alias and a real PTY, including cooked password input.
func waitTTY(fd, milliseconds int) (bool, error) {
	if fd < 0 || fd >= unix.FD_SETSIZE {
		return false, unix.EINVAL
	}
	var read unix.FdSet
	read.Set(fd)
	timeout := unix.NsecToTimeval((time.Duration(milliseconds) * time.Millisecond).Nanoseconds())
	n, err := unix.Select(fd+1, &read, nil, nil, &timeout)
	return n > 0 && read.IsSet(fd), err
}
