// Package termproof is the development-only fixture for the
// screen and input proof in the phic plan. It is not part of
// the shipped client.
package termproof

import (
	"bytes"
	"context"
	"errors"
	"os"
	"sync"
	"syscall"
	"time"

	gopty "github.com/aymanbagabas/go-pty"
)

// Backend is a deterministic "program" that the fixture drives
// inside a real PTY.
type Backend struct {
	Cmd *gopty.Cmd
	Pty gopty.Pty

	pumpOnce  sync.Once
	closeOnce sync.Once
	waitOnce  sync.Once
	closeErr  error
	waitErr   error
	log       *pumpLog
}

// StartBackend spawns a child program attached to a freshly
// allocated PTY with the requested initial geometry.
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
	// Same mask as the client's makeRaw. Required for the
	// "every emitted byte" contract.
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

func (b *Backend) Write(p []byte) (int, error)     { return b.Pty.Write(p) }
func (b *Backend) Resize(cols, rows uint16) error  { return b.Pty.Resize(int(cols), int(rows)) }
func (b *Backend) BytesSince(off int) []byte       { return b.log.since(off) }
func (b *Backend) LogOffset() int                  { return b.log.offset() }
func (b *Backend) ReadAvailable(buf []byte) []byte { return b.log.drainTo(buf) }
func (b *Backend) WaitForIdle(ctx context.Context, idle time.Duration) []byte {
	return b.log.waitForIdle(ctx, idle)
}
func (b *Backend) Close() error {
	b.closeOnce.Do(func() {
		b.closeErr = b.Pty.Close()
		b.log.signalClose()
		if b.Cmd.Process != nil {
			_ = b.Cmd.Process.Kill()
		}
		_ = b.Wait()
	})
	return b.closeErr
}
func (b *Backend) Wait() error {
	b.waitOnce.Do(func() { b.waitErr = b.Cmd.Wait() })
	return b.waitErr
}

func (b *Backend) startPump() {
	b.pumpOnce.Do(func() { go b.pump() })
}

func (b *Backend) pump() {
	buf := make([]byte, 4096)
	for {
		n, err := b.Pty.Read(buf)
		if n > 0 {
			b.log.append(buf[:n])
		}
		if err != nil {
			b.log.signalClose()
			return
		}
	}
}

// pumpLog is a thread-safe byte buffer that wakes readers on
// new data or close.
type pumpLog struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	closed    bool
	lastWrite time.Time
	cond      *sync.Cond
}

func newPumpLog() *pumpLog {
	l := &pumpLog{}
	l.cond = sync.NewCond(&l.mu)
	return l
}

func (l *pumpLog) append(p []byte) {
	l.mu.Lock()
	l.buf.Write(p)
	l.lastWrite = time.Now()
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
		if last := l.lastWrite.Add(idle); last.After(idleAt) {
			idleAt = last
		}
		if hasDeadline && deadline.Before(idleAt) {
			idleAt = deadline
		}
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
		wait := time.Until(idleAt)
		if wait > 20*time.Millisecond {
			wait = 20 * time.Millisecond
		}
		l.mu.Unlock()
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

func drainOnce(b *Backend) []byte { return b.log.snapshot() }

func waitAndCollect(b *Backend, d time.Duration) []byte {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return b.WaitForIdle(ctx, 50*time.Millisecond)
}

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
