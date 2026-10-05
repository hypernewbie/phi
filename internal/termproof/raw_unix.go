//go:build unix

package termproof

import (
	gopty "github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/unix"
)

// setRawSlave puts the slave side of the PTY into a line-discipline-
// off state so the byte stream is preserved end-to-end. The plan's
// "every emitted byte" contract is not satisfiable with the default
// cooked mode: \n turns into \r\n, control bytes are interpreted,
// and UTF-8 is mangled.
func setRawSlave(upty gopty.UnixPty) error {
	s := upty.Slave()
	if s == nil {
		return unix.EBADF
	}
	// Reuse termios via TIOCGETA / TIOCSETA. We keep the existing
	// cflag/oflag/lflag shape and zero only the input/echo/processing
	// bits. Sticking to the existing speed and cflag avoids breaking
	// child programs that rely on baud-rate queries.
	t, err := unix.IoctlGetTermios(int(s.Fd()), unix.TIOCGETA)
	if err != nil {
		return err
	}
	// ICANON = line editing (canonical mode). ECHO and ECHOE are
	// output echo. ISIG turns ^C/^Z into signals. IEXTEN enables
	// extended input processing. All four must be off for the
	// "every emitted byte" guarantee.
	t.Lflag &^= unix.ICANON | unix.ECHO | unix.ECHOE | unix.ISIG | unix.IEXTEN
	// OPOST = output processing; turns \n into \r\n on output. Must
	// be off so the master stream preserves the bytes the child
	// wrote.
	t.Oflag &^= unix.OPOST
	// IXON/IXOFF = XON/XOFF flow control. Off so control bytes are
	// never filtered. ICRNL turns \r into \n on input; off so we
	// see \r verbatim.
	t.Iflag &^= unix.IXON | unix.IXOFF | unix.ICRNL | unix.INLCR | unix.IGNCR
	// ISTRIP strips the 8th bit; off so the byte stream is faithful.
	t.Iflag &^= unix.ISTRIP
	return unix.IoctlSetTermios(int(s.Fd()), unix.TIOCSETA, t)
}
