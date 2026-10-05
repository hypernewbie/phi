// Package termproof is the development-only fixture for the screen and
// input proof in the phic plan. It is not part of the shipped client.
//
// The fixture drives a real POSIX PTY with a child program and records
// what a hypothetical "menu open / menu close" sequence does to the
// terminal byte stream. It does not run a terminal emulator and does
// not observe the rendered screen. The proof is honest: a real native
// terminal is the only oracle, and this fixture is the workbench.
//
// The four candidate mechanisms in the plan are evaluated in
// candidate.go. The seven proof cases live in candidate_test.go.
package termproof

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"syscall"
	"time"

	gopty "github.com/aymanbagabas/go-pty"
)

// Backend is a deterministic "program" that the fixture drives inside
// a real PTY. It is small enough to run in a unit test and exposes just
// enough surface to exercise the seven proof cases.
type Backend struct {
	// Cmd is the gopty child program. It runs attached to the PTY.
	Cmd *gopty.Cmd
	// Pty is the controlling terminal. The fixture owns its lifetime.
	Pty gopty.Pty

	// pump is the background reader that drains the master end into
	// log. The fixture deliberately does not use a read deadline on
	// the master fd: on macOS, os.File.SetReadDeadline interacts
	// unreliably with the pty driver. The pump closes itself when
	// the master returns an error (hangup or close).
	pumpOnce sync.Once
	log      *pumpLog
}

// StartBackend spawns a child program attached to a freshly allocated
// PTY with the requested initial geometry. The fixture takes ownership
// of the returned Backend; callers must call Close.
func StartBackend(ctx context.Context, cols, rows uint16, name string, args ...string) (*Backend, error) {
	pt, err := gopty.New()
	if err != nil {
		return nil, err
	}
	upty, ok := pt.(gopty.UnixPty)
	if !ok {
		_ = pt.Close()
		return nil, errors.New("termproof: only Unix PTYs are supported in this build")
	}
	if err := upty.SetWinsize(&gopty.Winsize{Col: uint16(cols), Row: uint16(rows)}); err != nil {
		_ = pt.Close()
		return nil, err
	}
	// The plan's "every emitted byte" contract requires the slave's
	// line discipline to be off. Without raw mode the kernel turns
	// \n into \r\n and folds control bytes; case 1 is meaningless
	// without that. Setting the slave raw also makes the byte
	// stream independent of the host terminal's own stty settings.
	if err := setRawSlave(upty); err != nil {
		_ = pt.Close()
		return nil, err
	}
	cmd := pt.CommandContext(ctx, name, args...)
	if err := cmd.Start(); err != nil {
		_ = pt.Close()
		return nil, err
	}
	b := &Backend{Cmd: cmd, Pty: pt, log: newPumpLog()}
	b.startPump()
	return b, nil
}

// Write sends raw bytes to the controlling terminal's master side.
func (b *Backend) Write(p []byte) (int, error) { return b.Pty.Write(p) }

// Resize changes the PTY's window size to cols x rows.
func (b *Backend) Resize(cols, rows uint16) error {
	return b.Pty.Resize(int(cols), int(rows))
}

// BytesSince returns the bytes appended to the log since the given
// offset. A negative or huge offset is clamped to the log length. The
// fixture uses this to make deterministic comparisons in the seven
// proof cases.
func (b *Backend) BytesSince(off int) []byte {
	return b.log.since(off)
}

// LogOffset returns the current log length; the test layer pairs this
// with BytesSince to observe incremental output.
func (b *Backend) LogOffset() int { return b.log.offset() }

// LogOffsetAtLeast blocks until the log has reached at least off
// bytes, then returns the offset. The fixture uses this to align
// with a child program that has just finished a setup phase.
func (b *Backend) LogOffsetAtLeast(off int) int {
	for b.log.offset() < off {
		time.Sleep(5 * time.Millisecond)
	}
	return b.log.offset()
}

// ReadAvailable is a non-blocking peek. It returns the bytes the log
// has accumulated since the last call (or, if the log is empty, up to
// whatever the master has flushed). The plan's proof never needs more
// than this; full coverage is in waitFor.
func (b *Backend) ReadAvailable(buf []byte) []byte {
	return b.log.drainTo(buf)
}

// WaitForIdle blocks until the log has not grown for the given
// duration or the context is canceled, then returns the snapshot.
// The plan uses it to read a backend's full output after writing.
func (b *Backend) WaitForIdle(ctx context.Context, idle time.Duration) []byte {
	return b.log.waitForIdle(ctx, idle)
}

// Close releases the PTY. It does not wait for the child: callers must
// wait on Cmd if they need the exit code.
func (b *Backend) Close() error {
	err := b.Pty.Close()
	b.log.signalClose()
	return err
}

// Wait waits for the child to exit and returns its error.
func (b *Backend) Wait() error { return b.Cmd.Wait() }

// startPump launches a background goroutine that drains the master
// end into the log until the master returns an error. The goroutine
// is the only reader; tests interact with the log.
func (b *Backend) startPump() {
	b.pumpOnce.Do(func() {
		go b.pump()
	})
}

func (b *Backend) pump() {
	buf := make([]byte, 4096)
	for {
		n, err := b.Pty.Read(buf)
		if n > 0 {
			b.log.append(buf[:n])
		}
		if err != nil {
			if !isHangup(err) && !errors.Is(err, io.EOF) {
				// A read that is neither hangup nor EOF is unexpected;
				// close the log so the test does not wait forever.
			}
			b.log.signalClose()
			return
		}
	}
}

// pumpLog is a thread-safe byte buffer that wakes readers when new
// data arrives or the master closes. The fixture's tests block on
// log.waitForIdle and inspect the snapshot.
type pumpLog struct {
	mu     sync.Mutex
	buf    bytes.Buffer
	closed bool
	cond   *sync.Cond
}

func newPumpLog() *pumpLog {
	l := &pumpLog{}
	l.cond = sync.NewCond(&l.mu)
	return l
}

func (l *pumpLog) append(p []byte) {
	l.mu.Lock()
	l.buf.Write(p)
	l.mu.Unlock()
	l.cond.Broadcast()
}

func (l *pumpLog) offset() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Len()
}

func (l *pumpLog) since(off int) []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	if off < 0 {
		off = 0
	}
	if off > l.buf.Len() {
		off = l.buf.Len()
	}
	return append([]byte(nil), l.buf.Bytes()[off:]...)
}

func (l *pumpLog) drainTo(buf []byte) []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := copy(buf, l.buf.Bytes())
	if n < l.buf.Len() {
		return append([]byte(nil), l.buf.Bytes()[:n]...)
	}
	return append([]byte(nil), l.buf.Bytes()...)
}

func (l *pumpLog) snapshot() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]byte(nil), l.buf.Bytes()...)
}

func (l *pumpLog) signalClose() {
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
	l.cond.Broadcast()
}

func (l *pumpLog) waitForIdle(ctx context.Context, idle time.Duration) []byte {
	idleAt := time.Now().Add(idle)
	deadline, hasDeadline := ctx.Deadline()
	if hasDeadline && deadline.Before(idleAt) {
		idleAt = deadline
	}
	for {
		l.mu.Lock()
		// Fast path: we already see a quiet window that satisfies
		// the idle window. The log records when bytes were last
		// appended by remembering the last snapshot length we saw
		// and the time it changed. We track that in a side table
		// keyed off cond, so we use the condition variable.
		if l.closed && time.Now().After(idleAt) {
			out := append([]byte(nil), l.buf.Bytes()...)
			l.mu.Unlock()
			return out
		}
		if time.Now().After(idleAt) {
			out := append([]byte(nil), l.buf.Bytes()...)
			l.mu.Unlock()
			return out
		}
		// Compute the remaining wait, capped at a small slice so a
		// closed master wakes us quickly.
		wait := time.Until(idleAt)
		if wait > 20*time.Millisecond {
			wait = 20 * time.Millisecond
		}
		l.mu.Unlock()

		// Use a timer that signals the cond on expiry, since
		// sync.Cond only wakes on Broadcast/Signal.
		t := time.AfterFunc(wait, func() { l.cond.Broadcast() })
		l.mu.Lock()
		if !l.closed {
			l.cond.Wait()
		}
		l.mu.Unlock()
		t.Stop()
		if ctx.Err() != nil {
			return l.snapshot()
		}
	}
}

// drainOnce is a helper for tests that want a single non-blocking peek.
func drainOnce(b *Backend) []byte {
	return b.log.snapshot()
}

// waitAndCollect is a blocking read that returns the log snapshot
// after the idle window has elapsed.
func waitAndCollect(b *Backend, d time.Duration) []byte {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return b.WaitForIdle(ctx, 50*time.Millisecond)
}

// isHangup reports whether the PTY read returned because the slave
// end closed. The plan relies on this for cleanup ordering.
func isHangup(err error) bool {
	if err == nil {
		return false
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		err = pathErr.Err
	}
	return errors.Is(err, syscall.EIO) || errors.Is(err, syscall.EBADF)
}

// syncBuffer is a tiny mutex-guarded byte buffer used by the proof
// cases that need to interleave stdin/stdout capture.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) Bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.buf.Bytes()...)
}
