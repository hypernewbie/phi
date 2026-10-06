//go:build !cgo || !(((darwin || linux) && (amd64 || arm64)) || (windows && amd64))

package termemu

import "errors"

// NewGhostty returns an error when the libghostty-vt native adapter is not
// compiled in. Supported CGO builds select ghostty_enabled.go automatically.
func NewGhostty(_ Options) (Terminal, error) {
	return nil, errors.New("termemu: this client requires CGO and a supported C compiler (macOS/Linux amd64 or arm64, Windows amd64); rebuild with CGO_ENABLED=1")
}

// Supported reports whether the native adapter is compiled in.
func Supported() bool { return false }
