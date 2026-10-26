//go:build unix

package phic

import (
	"bytes"
	"context"
	"errors"
	"os"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

func TestTTYOwnsDuplicateRestoresRealTermiosAndKeyboardStack(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()
	before, err := unix.IoctlGetTermios(int(slave.Fd()), termiosGet)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PHIC_TTY_FD", strconv.Itoa(int(slave.Fd())))
	tty, err := OpenTTY()
	if err != nil {
		t.Fatal(err)
	}
	defer tty.Close()
	if tty.fd == int(slave.Fd()) {
		t.Fatal("TTY stole caller descriptor")
	}
	if err := tty.EnterRaw(); err != nil {
		t.Fatal(err)
	}
	// A terminal query before the push must not stop the ownership lexer.
	_, _ = tty.Write([]byte("\x1b[6n\x1b[>"))
	_, _ = tty.Write([]byte("1u"))
	if tty.keyboardDepth != 2 {
		t.Fatalf("lost split keyboard push: %d", tty.keyboardDepth)
	}
	if err := tty.Close(); err != nil {
		t.Fatal(err)
	}
	if err := tty.Close(); err != nil {
		t.Fatal(err)
	}
	after, err := unix.IoctlGetTermios(int(slave.Fd()), termiosGet)
	if err != nil {
		t.Fatalf("closed original caller descriptor: %v", err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("real termios not restored:\nbefore=%+v\nafter=%+v", before, after)
	}
	// On Darwin, creack/pty's master is a blocking non-poller fd; deadlines need a nonblocking duplicate.
	dupFD, err := unix.Dup(int(master.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.SetNonblock(dupFD, true); err != nil {
		_ = unix.Close(dupFD)
		t.Fatal(err)
	}
	pollable := os.NewFile(uintptr(dupFD), "pty-master")
	defer pollable.Close()
	if err := pollable.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set keyboard-stack read deadline: %v", err)
	}
	buf := make([]byte, 512)
	var output []byte
	for !bytes.Contains(output, []byte("\x1b[<2u")) {
		n, err := pollable.Read(buf)
		output = append(output, buf[:n]...)
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				break
			}
			t.Fatalf("read caller keyboard stack: %v; output=%q", err, output)
		}
	}
	if !bytes.Contains(output, []byte("\x1b[<2u")) {
		t.Fatalf("caller keyboard stack not restored: %q", output)
	}
}
func TestTTYIdleReadHonorsContextWithoutClosingDescriptor(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()
	t.Setenv("PHIC_TTY_FD", strconv.Itoa(int(slave.Fd())))
	tty, err := OpenTTY()
	if err != nil {
		t.Fatal(err)
	}
	defer tty.Close()
	if err := tty.EnterRaw(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = tty.ReadContext(ctx, make([]byte, 16))
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("idle read not cancellable: %v", err)
	}
	if _, _, err := tty.Size(); err != nil {
		t.Fatalf("canceled read disposed TTY: %v", err)
	}
}
