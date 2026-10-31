//go:build !profiling

package obs

import (
	"context"
	"net/http"
)

// WrapTimingHTTP is the identity wrapper in normal builds: the timing
// recorder is compiled out, so requests pass through untouched.
func WrapTimingHTTP(next http.Handler) http.Handler { return next }

// DoFeature runs fn synchronously without a pprof label in normal builds.
func DoFeature(_ string, fn func(context.Context)) {
	if fn == nil {
		return
	}
	fn(context.Background())
}

// timingSpanStart never records in normal builds. The constant false keeps
// both Span backends free of timing checks after inlining.
func timingSpanStart(ctx context.Context, _ string) (context.Context, uint64, uint32, bool) {
	return ctx, 0, 0, false
}

func timingSpanEnd(uint64, uint32) {}
