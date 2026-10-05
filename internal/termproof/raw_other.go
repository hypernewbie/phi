//go:build !unix

package termproof

import "errors"

// setRawSlave is a no-op on platforms that the plan does not yet
// target. The fixture is unix-only.
func setRawSlave(_ any) error { return errors.New("termproof: unsupported platform") }
