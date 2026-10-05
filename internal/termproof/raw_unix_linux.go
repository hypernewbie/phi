//go:build linux

package termproof

import "golang.org/x/sys/unix"

const (
	termiosGet = unix.TCGETS
	termiosSet = unix.TCSETS
)
