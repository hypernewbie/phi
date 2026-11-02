//go:build unix

package pty

import (
	"os"
	"runtime"
	"syscall"
	"time"
)

// drainAvailable reads whatever output is already buffered on the PTY
// master without blocking, up to len(buf). It toggles O_NONBLOCK around
// raw syscalls: Go read deadlines do not support PTY files, and the
// toggle bypasses the runtime poller. SyscallConn.Control keeps the
// descriptor alive until the drain restores its flags, so concurrent
// close cannot invalidate or recycle it. Errors end the drain quietly;
// the next blocking read reports the real condition.
//
// A flooded child refills the ~1 KiB PTY queue within microseconds of
// each read, but only once the scheduler wakes it. An empty poll
// therefore pauses briefly before giving up: under flood the pauses
// collect a full batch per journal admission, while an idle keystroke
// pays one yield plus one short sleep.
func drainAvailable(master *os.File, buf []byte) (int, error) {
	if len(buf) == 0 {
		return 0, nil
	}
	conn, err := master.SyscallConn()
	if err != nil {
		return 0, err
	}
	total := 0
	controlErr := conn.Control(func(rawFD uintptr) {
		fd := int(rawFD)
		if err = syscall.SetNonblock(fd, true); err != nil {
			return
		}
		defer syscall.SetNonblock(fd, false)
		stalls := 0
		for total < len(buf) {
			n, readErr := syscall.Read(fd, buf[total:])
			if n > 0 {
				total += n
				stalls = 0
				continue
			}
			if readErr != nil && readErr != syscall.EAGAIN && readErr != syscall.EWOULDBLOCK {
				break
			}
			stalls++
			switch stalls {
			case 1:
				runtime.Gosched()
			case 2:
				time.Sleep(200 * time.Microsecond)
			default:
				return
			}
		}
	})
	if controlErr != nil {
		return total, controlErr
	}
	return total, err
}
