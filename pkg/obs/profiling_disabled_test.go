//go:build !profiling

package obs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime/pprof"
	"testing"
)

func TestWrapTimingHTTPIsIdentityWithoutProfiling(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Echo", r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	})
	wrapped := WrapTimingHTTP(inner)
	if reflect.ValueOf(wrapped).Pointer() != reflect.ValueOf(inner).Pointer() {
		t.Fatal("expected WrapTimingHTTP to return the handler unchanged")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot || rec.Header().Get("X-Echo") != "/api/version" {
		t.Fatalf("pass-through broken: code=%d echo=%q", rec.Code, rec.Header().Get("X-Echo"))
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
