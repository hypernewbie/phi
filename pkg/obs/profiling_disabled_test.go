//go:build !profiling

package obs

import (
	"context"
	"net/http"
	"runtime/pprof"
	"testing"
)

func TestWrapTimingHTTPIsIdentityWithoutProfiling(t *testing.T) {
	inner := http.NewServeMux()
	if WrapTimingHTTP(inner) != inner {
		t.Fatal("expected WrapTimingHTTP to return the handler unchanged")
	}
}

func TestDoFeatureRunsOnceWithoutLabel(t *testing.T) {
	calls := 0
	DoFeature("terminal", func(ctx context.Context) {
		calls++
		pprof.ForLabels(ctx, func(key, value string) bool {
			if key == "feature" {
				t.Errorf("unexpected feature label %q in normal build", value)
			}
			return true
		})
	})
	if calls != 1 {
		t.Fatalf("DoFeature ran fn %d times, want exactly once", calls)
	}
}
