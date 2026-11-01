package ws

import (
	"testing"
)

// Shared fixtures for storage tests.

// retentionTestSource builds deterministic output with line structure so
// suffix comparisons detect any dropped, duplicated, or reordered byte.
func retentionTestSource(t *testing.T, size int) []byte {
	t.Helper()
	out := make([]byte, 0, size)
	for seq := 0; len(out) < size; seq++ {
		line := []byte("retained history line with sequence and Unicode 你🙂\r\n")
		// Stamp the sequence into the line so every window is unique.
		stamped := append([]byte(nil), line...)
		for i := 0; i < 8; i++ {
			stamped[i] = byte(seq >> (8 * i))
		}
		out = append(out, stamped...)
	}
	return out[:size]
}

func TestParseRetentionSegFileRejectsShortNames(t *testing.T) {
	for _, name := range []string{".raw", ".rsz", ".ckpt", "", "s.raw", "s0000000000000001.log"} {
		if gen, ok := parseRetentionSegFile(name); ok {
			t.Fatalf("parseRetentionSegFile(%q) = (%d, true), want rejection", name, gen)
		}
	}
	gen, ok := parseRetentionSegFile("s0000000000000007.ckpt")
	if !ok || gen != 7 {
		t.Fatalf("parseRetentionSegFile(valid) = (%d, %v), want (7, true)", gen, ok)
	}
}

// position reads the pane's floor and head under its lock. A pane that has no
// recording yet has no position to check.
func position(t *testing.T, h *Hub, pane string) (oldest, head uint64, ok bool) {
	t.Helper()
	ph, found := h.LookupPane(pane)
	if !found {
		return 0, 0, false
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	pos := ph.positionLocked()
	return pos.Oldest, pos.Head, true
}
