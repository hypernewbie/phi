//go:build !unix

package phic

import "errors"

// TTY is a stub on non-Unix platforms. The plan targets macOS
// and Linux first; the Windows client requires a separate
// console implementation.
type TTY struct{}

// Resize is the cross-platform resize record. The non-Unix
// version is never produced because OpenTTY always fails.
type Resize struct{ Cols, Rows uint16 }

// OpenTTY returns an error: the first version does not target
// non-Unix platforms.
func OpenTTY() (*TTY, error) { return nil, errors.New("phic: unix-only first version") }

// Resizes is a no-op channel accessor that always returns nil.
func (t *TTY) Resizes() <-chan Resize { return nil }

// Read is a stub that always returns an error.
func (t *TTY) Read(_ []byte) (int, error) { return 0, errors.New("phic: unix-only first version") }

// Write is a stub that always returns an error.
func (t *TTY) Write(p []byte) (int, error) { return len(p), nil }

// EncodeResize is a stub that returns nil.
func (t *TTY) EncodeResize(_ Resize) []byte { return nil }

// Close is a no-op.
func (t *TTY) Close() error { return nil }

// Size is a stub that returns an error.
func (t *TTY) Size() (int, int, error) { return 0, 0, errors.New("phic: unix-only first version") }
