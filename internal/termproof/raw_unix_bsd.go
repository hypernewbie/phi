//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package termproof

import "golang.org/x/sys/unix"

const (
	termiosGet = unix.TIOCGETA
	termiosSet = unix.TIOCSETA
)
