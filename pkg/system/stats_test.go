package system

import (
	"context"
	"math"
	"testing"
	"time"
)

func TestSampler_FirstCallReturnsZeroOrValid(t *testing.T) {
	// First call is the warm-up; result should be 0.0 (gopsutil convention
	// for cpu.Percent(0, false) with no prior sample) or any small float
	// if gopsutil changes its semantics. Must not panic, must not error.
	s := NewSampler()
	stats, err := s.Sample(context.Background())
	if err != nil {
		t.Fatalf("first Sample failed: %v", err)
	}
	if stats.CPUPercent < 0 || stats.CPUPercent > 100 {
		t.Errorf("CPU percent out of range [0, 100]: %v", stats.CPUPercent)
	}
	if stats.CPUPeakPercent < 0 || stats.CPUPeakPercent > 100 {
		t.Errorf("peak CPU percent out of range [0, 100]: %v", stats.CPUPeakPercent)
	}
	if stats.CPUPeakPercent < stats.CPUPercent {
		t.Errorf("peak CPU should be >= aggregate CPU: peak=%v aggregate=%v", stats.CPUPeakPercent, stats.CPUPercent)
	}
	if stats.Timestamp.IsZero() {
		t.Error("timestamp should be set")
	}
}

func TestSampler_SecondCallAfterSleep(t *testing.T) {
	// Second call after a brief sleep should return a non-negative
	// percentage. We don't assert a specific range — on idle systems
	// it may be ~0-2%, on a busy test runner it could be much higher.
	s := NewSampler()
	if _, err := s.Sample(context.Background()); err != nil {
		t.Fatalf("first Sample failed: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	stats, err := s.Sample(context.Background())
	if err != nil {
		t.Fatalf("second Sample failed: %v", err)
	}
	if stats.CPUPercent < 0 {
		t.Errorf("CPU percent negative: %v", stats.CPUPercent)
	}
	if stats.CPUPeakPercent < 0 {
		t.Errorf("peak CPU percent negative: %v", stats.CPUPeakPercent)
	}
	if stats.CPUPeakPercent < stats.CPUPercent {
		t.Errorf("peak CPU should be >= aggregate CPU: peak=%v aggregate=%v", stats.CPUPeakPercent, stats.CPUPercent)
	}
	if stats.Timestamp.IsZero() {
		t.Error("timestamp should be set")
	}
}

func TestSampler_RespectsContextCancellation(t *testing.T) {
	s := NewSampler()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// Should not panic; gopsutil may return an error or partial result
	// when context is already cancelled.
	_, _ = s.Sample(ctx)
}

func TestSummarizeCPUPercent(t *testing.T) {
	avg, peak := summarizeCPUPercent([]float64{0, 50, 100})
	if avg != 50 {
		t.Fatalf("avg: want 50, got %v", avg)
	}
	if peak != 100 {
		t.Fatalf("peak: want 100, got %v", peak)
	}
}

func TestSummarizeCPUPercent_ClampsAndSkipsBadValues(t *testing.T) {
	avg, peak := summarizeCPUPercent([]float64{-10, 25, 200, math.NaN(), math.Inf(1)})
	if avg != 41.666666666666664 {
		t.Fatalf("avg: want clamped average, got %v", avg)
	}
	if peak != 100 {
		t.Fatalf("peak: want clamped peak 100, got %v", peak)
	}
}
