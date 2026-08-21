package rpc

import (
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/hypernewbie/phi/pkg/session"
)

// spawnChild starts `pi --mode rpc` with piped stdio; cwd via cmd.Dir.
func spawnChild(opts SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
	if opts.SessionPath != "" {
		if err := session.RevalidatePiSessionPath(opts.Cwd, opts.SessionPath); err != nil {
			return nil, nil, nil, err
		}
	}
	args := []string{"--mode", "rpc"}
	if opts.PiOffline {
		args = append(args, "--offline")
	}
	if opts.SessionPath != "" {
		args = append(args, "--session", opts.SessionPath)
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		ps := "powershell"
		if _, err := exec.LookPath(ps); err == nil {
			cmd = exec.Command(ps, "-NoLogo", "-NoProfile", "-NonInteractive",
				"-Command", "pi "+joinArgsForPS(args))
		}
	}
	if cmd == nil {
		cmd = exec.Command("pi", args...)
	}
	cmd.Dir = opts.Cwd
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, nil, err
	}
	go func() { _ = cmd.Wait() }()
	return &osCmd{Cmd: cmd}, stdin, stdout, nil
}

// osCmd wraps *exec.Cmd to add Kill() so the value satisfies the Cmd
// interface declared in spawn_types.go. *exec.Cmd's Kill lives on
// cmd.Process.Kill, which returns an error if the process is nil.
type osCmd struct {
	*exec.Cmd
}

func (c *osCmd) Kill() error {
	if c.Cmd == nil || c.Cmd.Process == nil {
		return nil
	}
	return c.Cmd.Process.Kill()
}

func joinArgsForPS(args []string) string {
	var b strings.Builder
	for i, a := range args {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteByte('\'')
		b.WriteString(strings.ReplaceAll(a, "'", "''"))
		b.WriteByte('\'')
	}
	return b.String()
}
