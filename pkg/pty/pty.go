package pty

import (
	"bytes"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	gopty "github.com/aymanbagabas/go-pty"
)

// crGapDur is the pause inserted after the bytes preceding a \r are written to
// the ConPTY input pipe, before the \r itself. Without it, conhost's ReadFile
// can pull both writes in a single read and re-coalesce them. Tunable for
// testing via PHI_CR_GAP_US (microseconds).
var crGapDur = func() time.Duration {
	if v := os.Getenv("PHI_CR_GAP_US"); v != "" {
		if us, err := strconv.Atoi(v); err == nil {
			return time.Duration(us) * time.Microsecond
		}
	}
	return 10 * time.Millisecond
}()

type Pty struct {
	cmd    *gopty.Cmd
	pt     gopty.Pty
	Closed chan struct{}
}

// ResolveCommand checks if a specific binary exists, particularly for agy
func ResolveCommand(command string) string {
	if command == "agy" {
		const agyPath = "/home/hypernewbie/.gemini/antigravity-cli/bin/agy"
		if _, err := os.Stat(agyPath); err == nil {
			return agyPath
		}
	}
	return command
}

func Start(dir string, command string, args []string) (*Pty, error) {
	resolvedCmd := ResolveCommand(command)

	// Resolve the full path before creating the command — go-pty's Windows
	// path resolver incorrectly joins Dir+command when Dir is set.
	resolvedPath, err := exec.LookPath(resolvedCmd)
	if err != nil {
		resolvedPath = resolvedCmd
	}

	pt, err := gopty.New()
	if err != nil {
		return nil, err
	}

	cmd := pt.Command(resolvedPath, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()

	hasTerm := false
	for _, env := range cmd.Env {
		if len(env) > 5 && env[:5] == "TERM=" {
			hasTerm = true
			break
		}
	}
	if !hasTerm {
		cmd.Env = append(cmd.Env, "TERM=xterm-256color")
	}

	if err := cmd.Start(); err != nil {
		_ = pt.Close()
		return nil, err
	}

	p := &Pty{
		cmd:    cmd,
		pt:     pt,
		Closed: make(chan struct{}),
	}

	go func() {
		_ = cmd.Wait()
		_ = pt.Close()
		close(p.Closed)
	}()

	return p, nil
}

func (p *Pty) Read(b []byte) (int, error) {
	return p.pt.Read(b)
}

func (p *Pty) Write(b []byte) (int, error) {
	// On Windows, a carriage return that shares a single ConPTY input-pipe
	// write with preceding bytes gets coalesced: charm/Bubble Tea's input
	// reader (opencode, claude, agy, pi) treats the bulk chunk as a bracketed
	// paste and inserts the newline literally instead of registering a distinct
	// Enter keypress. Writing each \r on its own — with a brief flush gap after
	// the preceding bytes so conhost drains them in a separate ReadFile — makes
	// Enter fire. A lone \r (direct-mode typing) has no preceding bytes and so
	// incurs no gap.
	if runtime.GOOS != "windows" || !bytes.ContainsRune(b, '\r') {
		return p.pt.Write(b)
	}

	total := 0
	rest := b
	for len(rest) > 0 {
		i := bytes.IndexByte(rest, '\r')
		if i < 0 {
			n, err := p.pt.Write(rest)
			total += n
			return total, err
		}
		if i > 0 {
			n, err := p.pt.Write(rest[:i])
			total += n
			if err != nil {
				return total, err
			}
			if crGapDur > 0 {
				time.Sleep(crGapDur)
			}
		}
		n, err := p.pt.Write([]byte{'\r'})
		total += n
		if err != nil {
			return total, err
		}
		rest = rest[i+1:]
	}
	return total, nil
}

func (p *Pty) Resize(cols, rows uint16) error {
	return p.pt.Resize(int(cols), int(rows))
}

func (p *Pty) Kill() error {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	_ = p.pt.Close()
	return nil
}
