package obs

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// BenchmarkTimingInactive measures the pass-through cost with no capture:
// no store, no context copy, no allocation beyond the handler chain.
func BenchmarkTimingInactive(b *testing.B) {
	wrapped := WrapTimingHTTP(timingMux())
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wrapped.ServeHTTP(httptest.NewRecorder(), req)
	}
}

// BenchmarkTimingAdmitted measures one admitted root per request. The
// capture resets outside measured batches so the 256-root budget never
// fills mid-batch; the exhausted path is failure handling, not overhead.
func BenchmarkTimingAdmitted(b *testing.B) {
	wrapped := WrapTimingHTTP(timingMux())
	const batch = 200
	for i := 0; i < b.N; {
		capture, ok := BeginTimingCapture()
		if !ok {
			b.Fatal("begin capture")
		}
		for j := 0; j < batch && i < b.N; j++ {
			req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
			wrapped.ServeHTTP(httptest.NewRecorder(), req)
			i++
		}
		b.StopTimer()
		snapshot := capture.Finish()
		if snapshot.RootsDropped != 0 {
			b.Fatalf("budget filled mid-batch: %+v", snapshot)
		}
		b.StartTimer()
	}
}
