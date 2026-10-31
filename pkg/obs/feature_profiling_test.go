//go:build profiling

package obs

import (
	"context"
	"runtime/pprof"
	"testing"
)

func TestDoFeatureLabelsWorkerGoroutine(t *testing.T) {
	labels := make(chan string, 1)
	release := make(chan struct{})
	go DoFeature("terminal", func(ctx context.Context) {
		label := ""
		pprof.ForLabels(ctx, func(key, value string) bool {
			if key == "feature" {
				label = value
			}
			return true
		})
		labels <- label
		<-release
	})
	defer close(release)
	if got := <-labels; got != "terminal" {
		t.Fatalf("feature label = %q, want terminal", got)
	}
}
