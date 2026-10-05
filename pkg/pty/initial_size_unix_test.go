//go:build unix

package pty

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSpawnSetsRequestedSizeBeforeFirstOutput(t *testing.T) {
	m := NewManager()
	inst, err := m.SpawnWithOptions(context.Background(), t.TempDir(), "sh", []string{"-c", "stty size; sleep 2"}, "bash", "", SpawnOptions{Cols: 99, Rows: 41})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Kill(inst.ID)
	got := collectOutput(inst.Pty, "41 99", time.Second)
	if !strings.Contains(got, "41 99") {
		t.Fatalf("child started at wrong size: %q", got)
	}
}
