//go:build profiling

package obs

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Reuse request and writer fixtures in both benchmarks so the reported
// allocations measure the wrapper, not different HTTP test setup costs.
func BenchmarkTimingInactive(b *testing.B) {
	wrapped := WrapTimingHTTP(timingMux())
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	writer := httptest.NewRecorder()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wrapped.ServeHTTP(writer, req)
	}
}

func BenchmarkTimingAdmitted(b *testing.B) {
	b.StopTimer()
	wrapped := WrapTimingHTTP(timingMux())
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	writer := httptest.NewRecorder()
	b.ReportAllocs()
	const batch = 200
	for i := 0; i < b.N; {
		// Begin and finish outside measured batches; never benchmark the
		// exhausted path as admitted capture overhead.
		capture, ok := BeginTimingCapture()
		if !ok {
			b.Fatal("begin capture")
		}
		count := min(batch, b.N-i)
		b.StartTimer()
		for j := 0; j < count; j++ {
			wrapped.ServeHTTP(writer, req)
		}
		b.StopTimer()
		i += count
		if snapshot := capture.Finish(); snapshot.RootsExported != uint32(count) || snapshot.RootsDropped != 0 {
			b.Fatalf("batch was not fully recorded: %+v", snapshot)
		}
	}
}
