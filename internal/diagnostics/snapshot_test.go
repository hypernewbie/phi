//go:build profiling

package diagnostics

import (
	"context"
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestCollectSnapshotKeepsIndependentProcessFailures(t *testing.T) {
	startedAt := time.Now()
	got := collectSnapshot(context.Background(), startedAt, "test-commit", snapshotReaders{
		rss: func(context.Context) (uint64, error) { return 0, context.DeadlineExceeded },
		cpu: func(context.Context) (float64, error) { return 1.25, nil },
	})
	if got.Process.RSSBytes != nil {
		t.Fatalf("RSS = %v, want null", *got.Process.RSSBytes)
	}
	if got.Process.CPUTotalSeconds == nil || *got.Process.CPUTotalSeconds != 1.25 {
		t.Fatalf("CPU = %v, want 1.25", got.Process.CPUTotalSeconds)
	}
	if len(got.Unavailable) != 1 || got.Unavailable[0] != "process_rss_unavailable" {
		t.Fatalf("unavailable = %v", got.Unavailable)
	}
	assertSnapshotJSON(t, got)
}

func TestCollectSnapshotRejectsInvalidProcessValues(t *testing.T) {
	for _, tc := range []struct {
		name string
		cpu  float64
	}{
		{name: "negative", cpu: -1},
		{name: "nan", cpu: math.NaN()},
		{name: "positive infinity", cpu: math.Inf(1)},
		{name: "negative infinity", cpu: math.Inf(-1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := collectSnapshot(context.Background(), time.Now(), "test", snapshotReaders{
				rss: func(context.Context) (uint64, error) { return 4096, nil },
				cpu: func(context.Context) (float64, error) { return tc.cpu, nil },
			})
			if got.Process.RSSBytes == nil || *got.Process.RSSBytes != 4096 {
				t.Fatalf("RSS = %v, want 4096", got.Process.RSSBytes)
			}
			if got.Process.CPUTotalSeconds != nil {
				t.Fatalf("CPU = %v, want null", *got.Process.CPUTotalSeconds)
			}
			if len(got.Unavailable) != 1 || got.Unavailable[0] != "process_cpu_unavailable" {
				t.Fatalf("unavailable = %v", got.Unavailable)
			}
			assertSnapshotJSON(t, got)
		})
	}
}

func TestCollectSnapshotPreservesValidCPUWhenRSSFails(t *testing.T) {
	got := collectSnapshot(context.Background(), time.Now(), "test", snapshotReaders{
		rss: func(context.Context) (uint64, error) { return 0, nil },
		cpu: func(context.Context) (float64, error) { return 0.5, nil },
	})
	if got.Process.RSSBytes != nil {
		t.Fatalf("zero RSS = %v, want null", *got.Process.RSSBytes)
	}
	if got.Process.CPUTotalSeconds == nil || *got.Process.CPUTotalSeconds != 0.5 {
		t.Fatalf("CPU = %v, want 0.5", got.Process.CPUTotalSeconds)
	}
	if len(got.Unavailable) != 1 || got.Unavailable[0] != "process_rss_unavailable" {
		t.Fatalf("unavailable = %v", got.Unavailable)
	}
}

func assertSnapshotJSON(t *testing.T, got snapshot) {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if decoded["schema_version"] != float64(1) {
		t.Fatalf("schema_version = %v", decoded["schema_version"])
	}
	process, ok := decoded["process"].(map[string]any)
	if !ok {
		t.Fatalf("process field is %T", decoded["process"])
	}
	if process["rss_bytes"] != nil && process["cpu_total_seconds"] != nil {
		t.Fatal("test snapshot should include a field encoded as null")
	}
	if decoded["build_commit"] == "" {
		t.Fatal("build_commit is empty")
	}
}
