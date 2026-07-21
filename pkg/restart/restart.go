package restart

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
)

// PortWaiter is a tiny helper used by both Unix and Windows restart
// paths to verify a TCP port is free before re-binding.
type PortWaiter struct {
	addr        string
	maxAttempts int
	interval    time.Duration
}

// NewPortWaiter returns a waiter that tries to dial addr up to
// maxAttempts times, sleeping interval between attempts. Used to
// confirm the old process has released the port after we exit /
// exec-replace.
func NewPortWaiter(addr string, maxAttempts int, interval time.Duration) *PortWaiter {
	if maxAttempts <= 0 {
		maxAttempts = 50 // 5s at 100ms
	}
	if interval <= 0 {
		interval = 100 * time.Millisecond
	}
	return &PortWaiter{
		addr:        addr,
		maxAttempts: maxAttempts,
		interval:    interval,
	}
}

// Wait releases when either a TCP connection to addr succeeds (meaning
// the new process is bound and listening) or maxAttempts elapses (the
// new process failed to bind). Either way we return — caller decides
// what to do.
func (p *PortWaiter) Wait(ctx context.Context) error {
	var lastErr error
	for i := 0; i < p.maxAttempts; i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		d := net.Dialer{Timeout: 200 * time.Millisecond}
		conn, err := d.Dial("tcp", p.addr)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		lastErr = err
		time.Sleep(p.interval)
	}
	if lastErr != nil {
		return fmt.Errorf("port %s never came back up after %d attempts: %w", p.addr, p.maxAttempts, lastErr)
	}
	return fmt.Errorf("port %s never came back up after %d attempts", p.addr, p.maxAttempts)
}

// BindWithRetry binds addr, retrying until maxWait. Needed on Windows restart
// where the old process briefly still holds the socket. No-op fast path on Unix.
func BindWithRetry(addr string, maxWait time.Duration, interval time.Duration) (net.Listener, error) {
	if maxWait <= 0 {
		maxWait = 5 * time.Second
	}
	if interval <= 0 {
		interval = 100 * time.Millisecond
	}
	deadline := time.Now().Add(maxWait)
	var lastErr error
	for {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("could not bind %s after %s: %w", addr, maxWait, lastErr)
		}
		time.Sleep(interval)
	}
}

// ExecSelf replaces the current process image with the same binary,
// passing the same arguments. Unix-only. Returns only on error.
func ExecSelf(args []string, env []string) error {
	if runtime.GOOS == "windows" {
		return fmt.Errorf("ExecSelf is unix-only; use SpawnDetached on Windows")
	}
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not resolve own path: %w", err)
	}
	return syscall.Exec(exePath, args, env)
}

// SpawnDetached starts a brand-new copy of the current binary with the
// same args and a fresh env. On Windows the new process is detached
// (no shared console) so it survives the parent's exit. Returns only
// once the child has been spawned (not when it has finished binding).
func SpawnDetached(args []string, env []string) (int, error) {
	exePath, err := os.Executable()
	if err != nil {
		return 0, fmt.Errorf("could not resolve own path: %w", err)
	}
	cmd := exec.Command(exePath, args[1:]...)
	cmd.Env = env

	// Detach stdio so the new process doesn't inherit the parent's
	// controlling terminal / pipes. Critical on Windows where a
	// shared console would tie the child's lifetime to ours.
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	// Platform-specific sysproc attrs (see restart_unix.go, restart_windows.go).
	applyDetachedSysProcAttr(cmd)

	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("spawn detached: %w", err)
	}
	// Release the child immediately - we don't want to wait on it.
	return cmd.Process.Pid, nil
}
