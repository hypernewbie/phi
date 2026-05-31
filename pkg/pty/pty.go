package pty

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

type Pty struct {
	cmd    *exec.Cmd
	f      *os.File
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
	cmd := exec.Command(resolvedCmd, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()

	// Ensure TUI application gets a valid terminal capability definition
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

	f, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}

	p := &Pty{
		cmd:    cmd,
		f:      f,
		Closed: make(chan struct{}),
	}

	go func() {
		_ = cmd.Wait()
		_ = f.Close()
		close(p.Closed)
	}()

	return p, nil
}

func (p *Pty) Read(b []byte) (int, error) {
	return p.f.Read(b)
}

func (p *Pty) Write(b []byte) (int, error) {
	return p.f.Write(b)
}

func (p *Pty) Resize(cols, rows uint16) error {
	return pty.Setsize(p.f, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
}

func (p *Pty) Kill() error {
	if p.cmd.Process != nil {
		// Try to kill the process group or process
		_ = p.cmd.Process.Signal(syscall.SIGKILL)
	}
	_ = p.f.Close()
	return nil
}
