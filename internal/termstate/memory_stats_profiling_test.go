//go:build profiling

package termstate

import (
	"bytes"
	"testing"
)

func TestResidentMemoryBytesAndClosedTerminal(t *testing.T) {
	terminal, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	initial, err := terminal.ResidentMemoryBytes()
	if err != nil || initial == 0 {
		t.Fatalf("initial resident memory = %d, err=%v; want positive size", initial, err)
	}
	if err = terminal.Feed(bytes.Repeat([]byte("profiled scrollback line\r\n"), 4096)); err != nil {
		t.Fatal(err)
	}
	before, err := terminal.Ready()
	if err != nil {
		t.Fatal(err)
	}
	resident, err := terminal.ResidentMemoryBytes()
	if err != nil || resident <= initial {
		t.Fatalf("resident memory = %d, err=%v; want more than initial %d", resident, err, initial)
	}
	after, err := terminal.Ready()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("memory observation changed terminal state")
	}
	if err := terminal.Close(); err != nil {
		t.Fatal(err)
	}
	resident, err = terminal.ResidentMemoryBytes()
	if err != nil || resident != 0 {
		t.Fatalf("closed terminal memory = %d, err=%v; want zero, nil", resident, err)
	}
}
