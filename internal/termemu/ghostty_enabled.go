//go:build cgo && (((darwin || linux) && (amd64 || arm64)) || (windows && amd64))

package termemu

// NewGhostty returns a Terminal backed by the pinned libghostty-vt static
// library. The native artifacts live under native/libghostty-vt/ and the C
// directives that point CGO at them live in ghostty_cgo.go.
func NewGhostty(opts Options) (Terminal, error) {
	return newGhostty(opts)
}

// Supported reports whether the native adapter is compiled in.
func Supported() bool { return true }
