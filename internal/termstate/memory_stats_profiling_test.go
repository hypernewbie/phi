//go:build profiling

package termstate

import "testing"

func TestLinearMemoryBytesAndClosedTerminal(t *testing.T) {
	terminal, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := terminal.LinearMemoryBytes()
	if err != nil {
		t.Fatal(err)
	}
	if bytes == 0 || bytes%65536 != 0 {
		t.Fatalf("linear memory = %d bytes, want positive page-aligned size", bytes)
	}
	if err := terminal.Close(); err != nil {
		t.Fatal(err)
	}
	bytes, err = terminal.LinearMemoryBytes()
	if err != nil || bytes != 0 {
		t.Fatalf("closed terminal memory = %d, err=%v; want zero, nil", bytes, err)
	}
}
