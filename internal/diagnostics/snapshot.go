package diagnostics

import (
	"context"
	"errors"
	"math"
	"os"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

type snapshotReaders struct {
	rss func(context.Context) (uint64, error)
	cpu func(context.Context) (float64, error)
}

type snapshot struct {
	SchemaVersion  int             `json:"schema_version"`
	PID            int             `json:"pid"`
	BuildCommit    string          `json:"build_commit"`
	StartedAt      string          `json:"started_at"`
	ElapsedSeconds float64         `json:"elapsed_seconds"`
	Process        processSnapshot `json:"process"`
	Go             goSnapshot      `json:"go"`
	Unavailable    []string        `json:"unavailable"`
}

type processSnapshot struct {
	RSSBytes        *uint64  `json:"rss_bytes"`
	CPUTotalSeconds *float64 `json:"cpu_total_seconds"`
}

type goSnapshot struct {
	HeapAllocBytes    uint64 `json:"heap_alloc_bytes"`
	HeapInuseBytes    uint64 `json:"heap_inuse_bytes"`
	HeapSysBytes      uint64 `json:"heap_sys_bytes"`
	HeapReleasedBytes uint64 `json:"heap_released_bytes"`
	StackInuseBytes   uint64 `json:"stack_inuse_bytes"`
	NumGC             uint32 `json:"num_gc"`
	Goroutines        int    `json:"goroutines"`
}

func currentProcessReaders() snapshotReaders {
	proc, procErr := process.NewProcess(int32(os.Getpid()))
	if procErr != nil {
		return snapshotReaders{
			rss: func(context.Context) (uint64, error) { return 0, procErr },
			cpu: func(context.Context) (float64, error) { return 0, procErr },
		}
	}
	return snapshotReaders{
		rss: func(ctx context.Context) (uint64, error) {
			stats, err := proc.MemoryInfoWithContext(ctx)
			if err != nil {
				return 0, err
			}
			if stats == nil {
				return 0, errNoProcessMemory
			}
			return stats.RSS, nil
		},
		cpu: func(ctx context.Context) (float64, error) {
			stats, err := proc.TimesWithContext(ctx)
			if err != nil {
				return 0, err
			}
			if stats == nil {
				return 0, errNoProcessCPU
			}
			return stats.User + stats.System, nil
		},
	}
}

func collectSnapshot(ctx context.Context, startedAt time.Time, commit string, readers snapshotReaders) snapshot {
	result := snapshot{
		SchemaVersion:  1,
		PID:            os.Getpid(),
		BuildCommit:    commit,
		StartedAt:      startedAt.Format(time.RFC3339Nano),
		ElapsedSeconds: time.Since(startedAt).Seconds(),
		Unavailable:    make([]string, 0, 2),
	}

	if rss, err := readers.rss(ctx); err != nil || rss == 0 {
		result.Unavailable = append(result.Unavailable, "process_rss_unavailable")
	} else {
		result.Process.RSSBytes = &rss
	}

	cpu, err := readers.cpu(ctx)
	result.ElapsedSeconds = time.Since(startedAt).Seconds()
	if err != nil || math.IsNaN(cpu) || math.IsInf(cpu, 0) || cpu < 0 {
		result.Unavailable = append(result.Unavailable, "process_cpu_unavailable")
	} else {
		result.Process.CPUTotalSeconds = &cpu
	}

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	result.Go = goSnapshot{
		HeapAllocBytes:    mem.HeapAlloc,
		HeapInuseBytes:    mem.HeapInuse,
		HeapSysBytes:      mem.HeapSys,
		HeapReleasedBytes: mem.HeapReleased,
		StackInuseBytes:   mem.StackInuse,
		NumGC:             mem.NumGC,
		Goroutines:        runtime.NumGoroutine(),
	}
	return result
}

var (
	errNoProcessMemory = errors.New("process memory statistics unavailable")
	errNoProcessCPU    = errors.New("process CPU statistics unavailable")
)
