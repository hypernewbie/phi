//go:build unix

package phic

import (
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

// Pager runs `less -R` on a temporary file. The plan: "Run
// the pager locally with an argument vector" and "Do not
// build a shell command from a path or title."
type Pager struct {
	path string
}

// NewPager writes content to a temporary file with owner-only
// permissions and returns a Pager that owns the file.
func NewPager(content string) (*Pager, error) {
	f, err := os.CreateTemp("", "phic-pager-*.txt")
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(f.Name(), 0o600); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return nil, err
	}
	if _, err := io.WriteString(f, content); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return nil, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(f.Name())
		return nil, err
	}
	return &Pager{path: f.Name()}, nil
}

// PagerBinary returns the pager command. Default is "less".
func PagerBinary() string {
	if v := os.Getenv("PHIC_PAGER"); v != "" {
		return v
	}
	return "less"
}

// PagerArgs returns the pager's argument vector. The plan:
// `less -R`.
func PagerArgs() []string {
	return []string{"-R"}
}

// Path returns the absolute path of the temp file.
func (p *Pager) Path() string {
	if p.path == "" {
		return ""
	}
	abs, _ := filepath.Abs(p.path)
	return abs
}

// Close deletes the temp file. Safe to call more than once.
func (p *Pager) Close() error {
	if p.path == "" {
		return nil
	}
	err := os.Remove(p.path)
	p.path = ""
	return err
}

// RunPager lends the existing TTY to a child. It must be called only when
// no relay reader owns that TTY; live overlays remain disabled.
func RunPager(ctx context.Context, tty *TTY, file string) (runErr error) {
	if tty == nil {
		return errors.New("phic: pager needs a TTY")
	}
	wasRaw := tty.raw
	if err := tty.Restore(); err != nil {
		return err
	}
	defer func() {
		err := tty.Restore()
		if wasRaw {
			err = tty.EnterRaw()
		}
		if runErr == nil {
			runErr = err
		}
	}()
	fd, err := unix.Dup(tty.fd)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), "phic-pager-tty")
	defer f.Close()
	bin := PagerBinary()
	args := append(PagerArgs(), file)
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdin = f
	cmd.Stdout = f
	cmd.Stderr = f
	return cmd.Run()
}
