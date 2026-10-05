//go:build unix

package phic

import "golang.org/x/sys/unix"

// cookedTermios returns a sane default for an interactive
// terminal. Used as a baseline for the raw-mode comparison.
func cookedTermios() *unix.Termios {
	t := &unix.Termios{}
	t.Cflag = unix.CREAD | unix.CS8
	t.Iflag = unix.ICRNL | unix.IXON
	t.Oflag = unix.OPOST
	t.Lflag = unix.ICANON | unix.ISIG | unix.IEXTEN
	t.Cc[unix.VEOF] = 0x04
	t.Cc[unix.VEOL] = 0x00
	t.Cc[unix.VINTR] = 0x03
	t.Cc[unix.VKILL] = 0x15
	t.Cc[unix.VMIN] = 0x01
	t.Cc[unix.VQUIT] = 0x1c
	t.Cc[unix.VSTART] = 0x11
	t.Cc[unix.VSTOP] = 0x13
	t.Cc[unix.VSUSP] = 0x1a
	t.Cc[unix.VTIME] = 0x00
	t.Ispeed = unix.B38400
	t.Ospeed = unix.B38400
	return t
}
