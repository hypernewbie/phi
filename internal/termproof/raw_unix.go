//go:build unix

package termproof

import (
	gopty "github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/unix"
)

// setRawSlave puts the slave side of the PTY into a line-discipline-
// off state. Without raw mode the kernel turns \n into \r\n,
// echoes input, and interprets control bytes; case 1 of the
// proof is meaningless without that.
func setRawSlave(upty gopty.UnixPty) error {
	s := upty.Slave()
	if s == nil {
		return unix.EBADF
	}
	t, err := unix.IoctlGetTermios(int(s.Fd()), termiosGet)
	if err != nil {
		return err
	}
	// Same mask as the client's makeRaw.
	t.Lflag &^= unix.ICANON | unix.ECHO | unix.ECHOE | unix.ISIG | unix.IEXTEN
	t.Oflag &^= unix.OPOST
	t.Iflag &^= unix.IXON | unix.IXOFF | unix.ICRNL | unix.INLCR | unix.IGNCR | unix.ISTRIP
	return unix.IoctlSetTermios(int(s.Fd()), termiosSet, t)
}
