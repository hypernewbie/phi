package rpc

import (
	"path/filepath"
	"testing"
)

func TestJoinArgsForPS(t *testing.T) {
	got := joinArgsForPS([]string{"--mode", "rpc", "--session", "/w/space dir/it's.jsonl"})
	want := "'--mode' 'rpc' '--session' '/w/space dir/it''s.jsonl'"
	if got != want {
		t.Fatalf("want %q got %q", want, got)
	}
}

func TestSpawnChildRevalidationPreventsCommand(t *testing.T) {
	cwd := t.TempDir()
	_, _, _, err := spawnChild(SpawnOptions{
		Cwd:         cwd,
		SessionPath: filepath.Join(cwd, "missing.jsonl"),
	})
	if err == nil {
		t.Fatal("expected invalid session path to fail before spawning")
	}
}
