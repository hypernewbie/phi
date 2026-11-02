//go:build !unix

package pty

import (
	"errors"
	"os"
)

// drainAvailable is a Unix-only optimization; other platforms read
// without coalescing.
func drainAvailable(_ *os.File, _ []byte) (int, error) {
	return 0, errors.New("pty drain unavailable")
}
