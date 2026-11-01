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
// toggle is invisible to the runtime poller because raw syscalls bypass
// it. The caller is the single reader, so no other goroutine observes
// the transient flag. Errors end the drain quietly; the next blocking
// read reports the real condition.
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
	fd := int(master.Fd())
	if err := syscall.SetNonblock(fd, true); err != nil {
		return 0, err
	}
	defer syscall.SetNonblock(fd, false)
	total := 0
	stalls := 0
	for total < len(buf) {
		n, err := syscall.Read(fd, buf[total:])
		if n > 0 {
			total += n
			stalls = 0
			continue
		}
		if err != nil && err != syscall.EAGAIN && err != syscall.EWOULDBLOCK {
			break
		}
		stalls++
		switch stalls {
		case 1:
			runtime.Gosched()
		case 2:
			time.Sleep(200 * time.Microsecond)
		default:
			return total, nil
		}
	}
	return total, nil
}
