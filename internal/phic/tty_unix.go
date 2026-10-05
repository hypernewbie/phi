//go:build unix

package phic

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

// TTY owns its descriptor and saved termios. Input remains cooked until
// authentication and startup selection finish. Relay reads are cancellable.
type TTY struct {
	fd            int
	saved         unix.Termios
	raw           bool
	resizeCh      chan Resize
	winCh         chan os.Signal
	stopCh        chan struct{}
	stopped       chan struct{}
	once          sync.Once
	closeErr      error
	keyboardDepth int
	outputLexer   queryGuard
	pendingInput  []byte
}

type Resize struct{ Cols, Rows uint16 }

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
	t := &TTY{fd: fd, saved: *saved, resizeCh: make(chan Resize, 1), stopCh: make(chan struct{}), stopped: make(chan struct{}), winCh: make(chan os.Signal, 1)}
	signal.Notify(t.winCh, syscall.SIGWINCH)
	go t.watchResize()
	t.outputLexer.keyboard = func(delta int) {
		t.keyboardDepth += delta
		if t.keyboardDepth < 0 {
			t.keyboardDepth = 0
		}
	}
	// Preserve a caller's enhanced keyboard stack, while startup menus and
	// password entry use legacy keys. No terminal query is needed.
	if _, err := t.Write([]byte("\x1b[>0u")); err != nil {
		_ = t.Close()
		return nil, err
	}
	return t, nil
}

func (t *TTY) EnterRaw() error {
	if _, err := term.MakeRaw(t.fd); err != nil {
		return err
	}
	t.raw = true
	return nil
}

func (t *TTY) Restore() error {
	if err := unix.IoctlSetTermios(t.fd, termiosSet, &t.saved); err != nil {
		return err
	}
	t.raw = false
	return nil
}

// makeRaw is also used by the PTY fixture. Match x/term's raw mask.
func makeRaw(t *unix.Termios) {
	t.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON | unix.IXOFF
	t.Oflag &^= unix.OPOST
	t.Lflag &^= unix.ECHO | unix.ECHONL | unix.ECHOE | unix.ICANON | unix.ISIG | unix.IEXTEN
	t.Cflag &^= unix.CSIZE | unix.PARENB
	t.Cflag |= unix.CS8
	t.Cc[unix.VMIN] = 1
	t.Cc[unix.VTIME] = 0
}

func (t *TTY) Resizes() <-chan Resize       { return t.resizeCh }
func (t *TTY) Read(buf []byte) (int, error) { return t.ReadContext(context.Background(), buf) }

// Unread is used only after both relay workers have joined. Menu input typed
// in the same OS read as a prefix command must not disappear at the handoff.
func (t *TTY) Unread(data []byte) {
	t.pendingInput = append(append([]byte{}, data...), t.pendingInput...)
}

func (t *TTY) PrepareMenu() error {
	// Abort a partial OSC/DCS/CSI before emitting keyboard-stack controls.
	if err := writeAll(t, []byte("\x18\x1b\\")); err != nil {
		return err
	}
	if t.keyboardDepth > 1 {
		if err := writeAll(t, []byte(fmt.Sprintf("\x1b[<%du", t.keyboardDepth-1))); err != nil {
			return err
		}
	}
	return writeAll(t, []byte(neutralDisplay+"\r\n"))
}

func (t *TTY) PrepareRelay() error {
	if err := t.PrepareMenu(); err != nil {
		return err
	}
	cols, _, err := t.Size()
	if err != nil {
		return err
	}
	return writeAll(t, []byte(clearRelayDisplay+defaultTabStops(cols)))
}

func (t *TTY) ReadContext(ctx context.Context, buf []byte) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if len(t.pendingInput) > 0 {
		n := copy(buf, t.pendingInput)
		t.pendingInput = t.pendingInput[n:]
		return n, nil
	}
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		ready, err := waitTTY(t.fd, 100)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return 0, err
		}
		if !ready {
			continue
		}
		return unix.Read(t.fd, buf)
	}
}
func (t *TTY) Write(p []byte) (int, error) {
	n, err := unix.Write(t.fd, p)
	if n > 0 {
		t.outputLexer.Feed(p[:n])
	}
	return n, err
}
func (t *TTY) EncodeResize(r Resize) []byte { return wireproto.EncodeResizeFrame(r.Cols, r.Rows) }

func (t *TTY) Close() error {
	t.once.Do(func() {
		if t.winCh != nil {
			signal.Stop(t.winCh)
		}
		if t.stopCh != nil {
			close(t.stopCh)
			<-t.stopped
		}
		if t.raw {
			// Cancel a partial escape, leave backend-owned fullscreen/input modes,
			// and return the calling shell to a usable baseline. No screen replay.
			_, _ = t.Write([]byte("\x18\x1b\\\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b[?2004l\x1b[>4;0m\x1b[?1049l\x1b[r\x1b[0m\x1b[?25h"))
		}
		if t.keyboardDepth > 0 {
			_, _ = t.Write([]byte(fmt.Sprintf("\x1b[<%du", t.keyboardDepth)))
		}
		t.closeErr = unix.IoctlSetTermios(t.fd, termiosSet, &t.saved)
		if err := unix.Close(t.fd); t.closeErr == nil {
			t.closeErr = err
		}
	})
	return t.closeErr
}

func (t *TTY) watchResize() {
	defer close(t.stopped)
	for {
		select {
		case <-t.stopCh:
			return
		case <-t.winCh:
			cols, rows, err := t.Size()
			if err != nil || cols <= 0 || rows <= 0 {
				continue
			}
			size := Resize{uint16(cols), uint16(rows)}
			select {
			case t.resizeCh <- size:
			default:
				select {
				case <-t.resizeCh:
				default:
				}
				select {
				case t.resizeCh <- size:
				default:
				}
			}
		}
	}
}
func (t *TTY) Size() (int, int, error) { return term.GetSize(t.fd) }
func openControllingTty() (int, error) {
	if v := os.Getenv("PHIC_TTY_FD"); v != "" {
		fd, err := strconv.Atoi(v)
		if err != nil || fd < 0 {
			return 0, fmt.Errorf("phic: invalid PHIC_TTY_FD")
		}
		return unix.Dup(fd) // Do not close the caller's descriptor.
	}
	f, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return 0, fmt.Errorf("phic: no controlling terminal: %w", err)
	}
	defer f.Close()
	return unix.Dup(int(f.Fd()))
}

func (t *TTY) Password(ctx context.Context, prompt string) (string, error) {
	state, err := unix.IoctlGetTermios(t.fd, termiosGet)
	if err != nil {
		return "", err
	}
	hidden := *state
	hidden.Lflag &^= unix.ECHO | unix.ECHONL
	if err := unix.IoctlSetTermios(t.fd, termiosSet, &hidden); err != nil {
		return "", err
	}
	defer unix.IoctlSetTermios(t.fd, termiosSet, state)
	if _, err := t.Write([]byte(prompt)); err != nil {
		return "", err
	}
	line, err := readLine(ctx, t)
	_, _ = t.Write([]byte("\n"))
	return line, err
}
