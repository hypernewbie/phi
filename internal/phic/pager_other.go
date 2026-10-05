//go:build !unix

package phic

import "errors"

// Pager is a Windows stub. The plan targets macOS and Linux
// first; the Windows client requires a separate console
// implementation.
type Pager struct{}

// NewPager is a stub that returns an error on Windows.
func NewPager(_ string) (*Pager, error) {
	return nil, errors.New("phic: pager not supported on Windows")
}

func (p *Pager) Path() string { return "" }
func (p *Pager) Close() error { return nil }
func PagerBinary() string     { return "" }
func PagerArgs() []string     { return nil }
func RunPager(_ any, _ any, _ string) error {
	return errors.New("phic: pager not supported on Windows")
}
