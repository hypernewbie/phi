//go:build profiling

package termstate

import "errors"

var errLinearMemoryUnavailable = errors.New("terminal linear memory unavailable")

// LinearMemoryBytes reports the current addressable WASM memory size. Call
// under the pane lock; Grow(0) reads the page count without changing it.
func (t *Terminal) LinearMemoryBytes() (uint64, error) {
	if t == nil || t.module == nil {
		return 0, nil
	}
	pages, ok := t.module.Memory().Grow(0)
	if !ok {
		return 0, errLinearMemoryUnavailable
	}
	return uint64(pages) * 65536, nil
}
