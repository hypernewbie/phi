//go:build !termemu_ghostty

package termemu

import "errors"

// NewGhostty returns an error when the libghostty-vt native adapter is not
// compiled in. Production builds that link the static library set the
// `termemu_ghostty` build tag and reach ghostty_enabled.go instead.
func NewGhostty(_ Options) (Terminal, error) {
	return nil, errors.New("termemu: libghostty-vt adapter not built; install the pinned native artifacts and pass -tags=termemu_ghostty")
}

// Supported reports whether the native adapter is compiled in.
func Supported() bool { return false }
