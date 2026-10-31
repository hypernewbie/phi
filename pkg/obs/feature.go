//go:build profiling

package obs

import (
	"context"
	"runtime/pprof"
)

// DoFeature applies one fixed feature label for the lifetime of fn. Call once
// at a worker boundary, not from a request or per-item loop.
func DoFeature(feature string, fn func(context.Context)) {
	if fn == nil {
		return
	}
	pprof.Do(context.Background(), pprof.Labels("feature", feature), fn)
}
