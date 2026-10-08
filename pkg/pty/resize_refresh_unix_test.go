//go:build !windows

package pty

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestEqualSizeResizeRefreshesForegroundApplicationWithoutChangingGrid(t *testing.T) {
	p, err := startWithSize(context.Background(), t.TempDir(), "/bin/sh", []string{"-c", `trap 'printf "REFRESH\\n"' WINCH; printf 'READY\n'; while :; do read x || :; done`}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Kill() })
	messages := make(chan string, 8)
	go func() {
		buf := make([]byte, 1024)
		var pending []byte
		for {
			n, err := p.Read(buf)
			pending = append(pending, buf[:n]...)
			for {
				at := bytes.IndexByte(pending, '\n')
				if at < 0 {
					break
				}
				messages <- string(bytes.TrimSpace(pending[:at]))
				pending = pending[at+1:]
			}
			if err != nil {
				if err != io.EOF {
					messages <- err.Error()
				}
				close(messages)
				return
			}
		}
	}()
	// A deadline is only a missing-notification failure bound, not a latency
	// assertion. Completion is the application's explicit signal acknowledgement.
	await := func(want string) {
		t.Helper()
		select {
		case got := <-messages:
			if got != want {
				t.Fatalf("got %q want %q", got, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("application did not acknowledge PTY refresh")
		}
	}
	await("READY")
	for i := 0; i < 2; i++ {
		if err = p.Resize(80, 24); err != nil {
			t.Fatal(err)
		}
		await("REFRESH")
		size, e := unix.IoctlGetWinsize(int(p.pt.Fd()), unix.TIOCGWINSZ)
		if e != nil || size.Col != 80 || size.Row != 24 {
			t.Fatalf("refresh changed authoritative geometry: %+v %v", size, e)
		}
	}
}
