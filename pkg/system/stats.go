// Package system exposes lightweight system-level stats for the CPU
// indicator in the UI header. Currently only CPU percent is sampled;
// memory and per-core breakdowns are intentionally out of scope to
// keep this dependency-free of platform-specific syscalls beyond what
// gopsutil already wraps.
package system

import (
	"context"
	"math"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
)

// Stats holds a snapshot of system-level stats. Fields are
// intentionally simple — the UI uses this only for ambient decoration.
type Stats struct {
	// CPUPercent is aggregate system-wide CPU utilisation as a percentage
	// in [0, 100]. Sampled as a delta between two reads (gopsutil convention)
	// — first call may return 0.0 until a second sample has been taken.
	CPUPercent float64 `json:"cpu"`

	// CPUPeakPercent is the hottest single-core utilisation in [0, 100].
	// The UI uses max(cpu, cpu_peak) for the glow indicator so one saturated
	// core still lights up on Linux/macOS multi-core machines where aggregate
	// CPU can remain below the visual threshold.
	CPUPeakPercent float64 `json:"cpu_peak"`

	// Timestamp is when the sample was taken. The frontend can use this to
	// detect a stale poll and decide whether to clear the indicator.
	Timestamp time.Time `json:"timestamp"`
}

// Sampler maintains a rolling CPU percent sample. cpu.Percent with
// interval=0 returns the delta against the previous call's snapshot,
// which means the very first call returns 0.0 — that's fine for the
// UI because the first poll just leaves the logo idle for ~1s.
type Sampler struct {
	mu       sync.Mutex
	lastTime time.Time
	warm     bool
}

// NewSampler returns a Sampler ready to be used by the HTTP handler.
// The first Sample() call warms the internal counter so the second
// call returns a meaningful delta.
func NewSampler() *Sampler {
	return &Sampler{}
}

// Sample returns the current system-wide CPU percent. Safe for
// concurrent use. The first call after construction returns 0.0
// (warm-up) and primes the delta; subsequent calls return the
// percentage utilisation over the wall-clock interval between calls.
//
// We intentionally use cpu.Percent(0, true) (no blocking interval,
// per-core samples) rather than a fixed sampling interval — the frontend
// already polls at 2s, so the delta will represent roughly that interval.
// Per-core samples let the UI react to one hot core on Linux/macOS; aggregate
// alone often stays below the threshold on high-core-count machines.
func (s *Sampler) Sample(ctx context.Context) (Stats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	perCore, err := cpu.PercentWithContext(ctx, 0, true)
	if err != nil {
		return Stats{}, err
	}

	now := time.Now()
	avg, peak := summarizeCPUPercent(perCore)
	stats := Stats{
		CPUPercent:     avg,
		CPUPeakPercent: peak,
		Timestamp:      now,
	}

	s.lastTime = now
	s.warm = true
	return stats, nil
}

func summarizeCPUPercent(samples []float64) (average float64, peak float64) {
	if len(samples) == 0 {
		return 0, 0
	}

	var total float64
	valid := 0
	for _, sample := range samples {
		if math.IsNaN(sample) || math.IsInf(sample, 0) {
			continue
		}
		if sample < 0 {
			sample = 0
		} else if sample > 100 {
			sample = 100
		}
		total += sample
		valid++
		if sample > peak {
			peak = sample
		}
	}
	if valid == 0 {
		return 0, 0
	}
	return total / float64(valid), peak
}
