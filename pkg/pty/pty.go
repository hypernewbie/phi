package pty

import (
	"os"
	"os/exec"

	gopty "github.com/aymanbagabas/go-pty"
)

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
	return p.pt.Write(b)
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
