//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package phic

import "golang.org/x/sys/unix"

// termios constants differ between Linux (TCGETS/TCSETS) and
// the BSD-derived kernels (TIOCGETA/TIOCSETA). The IoctlGetTermios
// signature is the same on both, so a build-tag switch is enough.
const (
	termiosGet = unix.TIOCGETA
	termiosSet = unix.TIOCSETA
)
