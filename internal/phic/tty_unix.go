//go:build unix

package phic

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// TTY owns the process's controlling terminal during the relay.
// One TTY is created at startup and is the only writer to /dev/tty.
// Close restores the saved termios and is safe to call more than once.
type TTY struct {
	fd       int
	saved    unix.Termios
	raw      bool
	resizeCh chan Resize
	winCh    chan os.Signal
	stopCh   chan struct{}
}

// Resize is the current terminal size in cells.
type Resize struct{ Cols, Rows uint16 }

// OpenTTY prepares the controlling terminal for raw input.
func OpenTTY() (*TTY, error) {
	fd, err := openControllingTty()
	if err != nil {
		return nil, err
	}
	saved, err := unix.IoctlGetTermios(fd, termiosGet)
	if err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	raw := *saved
	makeRaw(&raw)
	if err := unix.IoctlSetTermios(fd, termiosSet, &raw); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	t := &TTY{
		fd:       fd,
		saved:    *saved,
		raw:      true,
		resizeCh: make(chan Resize, 4),
		stopCh:   make(chan struct{}),
	}
	t.winCh = make(chan os.Signal, 1)
	signal.Notify(t.winCh, syscall.SIGWINCH)
	go t.watchResize()
	return t, nil
}

// makeRaw flips every off-switch the plan requires: no line
// editing, no echo, no signal interpretation, no output
// processing, no input mangling.
func makeRaw(t *unix.Termios) {
	t.Lflag &^= unix.ICANON | unix.ECHO | unix.ECHOE | unix.ISIG | unix.IEXTEN
	t.Oflag &^= unix.OPOST
	t.Iflag &^= unix.IXON | unix.IXOFF | unix.ICRNL | unix.INLCR | unix.IGNCR | unix.ISTRIP
}

// Resizes returns a channel of size changes.
func (t *TTY) Resizes() <-chan Resize { return t.resizeCh }

// Read reads up to len(buf) bytes from the controlling terminal.
func (t *TTY) Read(buf []byte) (int, error) {
	return unix.Read(t.fd, buf)
}

// Write writes to the controlling terminal.
func (t *TTY) Write(p []byte) (int, error) {
	return unix.Write(t.fd, p)
}

// EncodeResize returns a 0x02 frame for the given size.
func (t *TTY) EncodeResize(r Resize) []byte {
	return wireproto.EncodeResizeFrame(r.Cols, r.Rows)
}

// Close restores the saved termios and unblocks the resize
// watcher. Safe to call more than once.
func (t *TTY) Close() error {
	if !t.raw {
		return nil
	}
	t.raw = false
	signal.Stop(t.winCh)
	close(t.stopCh)
	_ = unix.IoctlSetTermios(t.fd, termiosSet, &t.saved)
	return unix.Close(t.fd)
}

func (t *TTY) watchResize() {
	for {
		select {
		case <-t.stopCh:
			return
		case <-t.winCh:
			cols, rows, err := t.Size()
			if err != nil {
				continue
			}
			select {
			case t.resizeCh <- Resize{Cols: uint16(cols), Rows: uint16(rows)}:
			default:
				// Drop coalesced resizes; the next SIGWINCH
				// will deliver the current size.
			}
		}
	}
}

// Size returns the current terminal size.
func (t *TTY) Size() (int, int, error) {
	ws, err := unix.IoctlGetWinsize(t.fd, unix.TIOCGWINSZ)
	if err != nil {
		return 0, 0, err
	}
	return int(ws.Col), int(ws.Row), nil
}

// openControllingTty returns an fd for the controlling terminal.
func openControllingTty() (int, error) {
	if v := os.Getenv("PHIC_TTY_FD"); v != "" {
		var fd int
		if _, err := fmt.Sscanf(v, "%d", &fd); err == nil && fd > 0 {
			return fd, nil
		}
	}
	f, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return 0, errors.New("phic: no controlling terminal: " + err.Error())
	}
	dup, err := unix.Dup(int(f.Fd()))
	_ = f.Close()
	if err != nil {
		return 0, err
	}
	return dup, nil
}
