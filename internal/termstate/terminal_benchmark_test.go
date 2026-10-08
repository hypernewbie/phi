package termstate

import (
	"bytes"
	"testing"
)

func BenchmarkReadyScreenState(b *testing.B) {
	terminal, err := New(b.Context(), 120, 40)
	if err != nil {
		b.Fatal(err)
	}
	defer terminal.Close()
	data := bytes.Repeat([]byte("\x1b[38;2;120;80;220mterminal scrollback line 你🙂\x1b[0m\r\n"), 10000)
	if err = terminal.Feed(data); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err = terminal.Ready(); err != nil {
			b.Fatal(err)
		}
	}
}
func BenchmarkWebAttachScreenState(b *testing.B) {
	terminal, err := New(b.Context(), 120, 40)
	if err != nil {
		b.Fatal(err)
	}
	defer terminal.Close()
	data := bytes.Repeat([]byte("\x1b[38;2;120;80;220mterminal scrollback line 你🙂\x1b[0m\r\n"), 10000)
	if err = terminal.Feed(data); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err = terminal.FormatVTState(); err != nil {
			b.Fatal(err)
		}
	}
}
