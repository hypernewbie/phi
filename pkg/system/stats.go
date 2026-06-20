// Package system exposes lightweight system-level stats for the CPU
// indicator in the UI header. Currently only CPU percent is sampled;
// memory and per-core breakdowns are intentionally out of scope to
// keep this dependency-free of platform-specific syscalls beyond what
// gopsutil already wraps.
package system

import (
	"context"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
)

// Stats holds a snapshot of system-level stats. Fields are
// intentionally simple — the UI uses this only for ambient decoration.
type Stats struct {
	// CPUPercent is the aggregate system-wide CPU utilisation as a
	// percentage in [0, 100]. Sampled as a delta between two reads
	// (gopsutil convention) — first call may return 0.0 until a
	// second sample has been taken.
	CPUPercent float64 `json:"cpu"`

	// Timestamp is when the sample was taken. The frontend can use
	// this to detect a stale poll and decide whether to clear the
	// indicator (e.g. when CPU load returns to normal).
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
// We intentionally use cpu.Percent(0, false) (no blocking interval,
// all cores aggregated) rather than a fixed sampling interval — the
// frontend already polls at 1s, so the delta will represent roughly
// one second of activity.
func (s *Sampler) Sample(ctx context.Context) (Stats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	pct, err := cpu.PercentWithContext(ctx, 0, false)
	if err != nil {
		return Stats{}, err
	}

	now := time.Now()
	stats := Stats{
		Timestamp: now,
	}
	if len(pct) > 0 {
		// gopsutil returns []float64 with one entry per requested core
		// when perCPU=true; we ask for aggregate (false), so it should
		// return [overall]. Be defensive in case the library changes.
		stats.CPUPercent = pct[0]
	}

	s.lastTime = now
	s.warm = true
	return stats, nil
}
