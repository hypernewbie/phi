package pty

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
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
	cmd       *gopty.Cmd
	pt        gopty.Pty
	Closed    chan struct{}
	closeOnce sync.Once
}

func (p *Pty) closePTY() {
	p.closeOnce.Do(func() {
		_ = p.pt.Close()
	})
}

// ResolveCommand checks if a specific binary exists, particularly for agy.
// It tries common install locations across platforms before falling back to PATH lookup.
func ResolveCommand(command string) string {
	if command == "agy" {
		home, _ := os.UserHomeDir()
		candidates := []string{
			filepath.Join(home, ".gemini", "antigravity-cli", "bin", "agy"),
		}
		for _, p := range candidates {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return command
}

// validateWorkingDir confirms dir exists and is a directory. An empty dir is allowed
// (the PTY inherits the server process's cwd). A missing dir is reported with a clear,
// actionable error rather than letting it surface later as the kernel's misleading
// "fork/exec <shell>: no such file or directory" — which blames the binary, not the
// path. This commonly happens when a config carries paths from another machine.
func validateWorkingDir(dir string) error {
	if dir == "" {
		return nil
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("project directory %q doesn't exist on this machine", dir)
	}
	return nil
}

func Start(dir string, command string, args []string) (*Pty, error) {
	resolvedCmd := ResolveCommand(command)

	// Resolve the full path before creating the command — go-pty's Windows
	// path resolver incorrectly joins Dir+command when Dir is set.
	resolvedPath, err := exec.LookPath(resolvedCmd)
	if err != nil {
		return nil, fmt.Errorf("command %q not found in PATH — is it installed?", resolvedCmd)
	}

	// Validate the working directory up front so a stale/cross-platform path produces a
	// clear message instead of the kernel's misleading "fork/exec <shell>" ENOENT later.
	if err := validateWorkingDir(dir); err != nil {
		return nil, err
	}

	pt, err := gopty.New()
	if err != nil {
		return nil, err
	}

	cmd := pt.Command(resolvedPath, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()

	// On Windows, strip any stray UNIX-like SHELL environment variable to prevent
	// cross-platform tools (like Pi Coder) from trying to run commands via a broken/WSL bash.
	if runtime.GOOS == "windows" {
		var cleanEnv []string
		for _, env := range cmd.Env {
			if !strings.HasPrefix(strings.ToUpper(env), "SHELL=") {
				cleanEnv = append(cleanEnv, env)
			}
		}
		cmd.Env = cleanEnv
	}

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
	// Enable 24-bit true colour support for agents.
	cmd.Env = append(cmd.Env, "COLORTERM=truecolor")


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
		p.closePTY()
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
	p.closePTY()
	return nil
}
