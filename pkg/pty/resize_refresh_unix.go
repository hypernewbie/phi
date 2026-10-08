//go:build !windows

package pty

import (
	"fmt"

	gopty "github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/unix"
)

func (p *Pty) resizeAndRefresh(cols, rows uint16) error {
	// TIOCSWINSZ only signals the foreground application when the size changes.
	// An equal-size resize is Phi's explicit redraw request on reattach/wake.
	var same bool
	var group int
	if pt, ok := p.pt.(gopty.UnixPty); ok {
		_ = pt.Control(func(fd uintptr) {
			size, err := unix.IoctlGetWinsize(int(fd), unix.TIOCGWINSZ)
			same = err == nil && size.Col == cols && size.Row == rows
			if same {
				group, _ = unix.IoctlGetInt(int(fd), unix.TIOCGPGRP)
			}
		})
	}
	if err := p.pt.Resize(int(cols), int(rows)); err != nil {
		return err
	}
	if !same {
		return nil
	}
	// Signal the foreground job, not just the shell/session leader. Never
	// signal group zero: that would target the Phi server's own process group.
	if group > 0 {
		return unix.Kill(-group, unix.SIGWINCH)
	}
	if p.cmd != nil && p.cmd.Process != nil {
		return p.cmd.Process.Signal(unix.SIGWINCH)
	}
	return fmt.Errorf("PTY refresh: foreground process unavailable")
}
