//go:build linux

package phic

import "golang.org/x/sys/unix"

// Linux uses TCGETS/TCSETS where BSD uses TIOCGETA/TIOCSETA.
const (
	termiosGet = unix.TCGETS
	termiosSet = unix.TCSETS
)
