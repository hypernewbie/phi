package dshweb

import (
	"io"
	"os/exec"
	"syscall"
)

// Process is one owned child for readiness and termination.
type Process interface {
	Pid() int
	Wait() error
}

// Starter spawns the configured executable. Tests inject a fake;
// production uses realStarter.
type Starter interface {
	Start(command string, args []string, dir string, env []string) (Process, io.ReadCloser, io.ReadCloser, error)
}

type realStarter struct{}

func (realStarter) Start(command string, args []string, dir string, env []string) (Process, io.ReadCloser, io.ReadCloser, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.SysProcAttr = newSysAttr()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdout.Close()
		return nil, nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, nil, nil, err
	}
	return &execProcess{cmd: cmd}, stdout, stderr, nil
}

type execProcess struct {
	cmd *exec.Cmd
}

func (p *execProcess) Pid() int {
	if p.cmd == nil || p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *execProcess) Wait() error {
	if p.cmd == nil {
		return nil
	}
	return p.cmd.Wait()
}

// killGroup signals the owned process group. Tests override it to avoid
// touching real process groups.
var killGroup = killProcessGroup

// terminateProcess ends the owned process tree within termGrace plus
// killGrace. TERM first, then one bounded KILL; never two full waits.
// waitDone is closed by the single Wait owner. A nil or already-reaped
// process returns at once.
func terminateProcess(proc Process, waitDone <-chan struct{}, clock Clock) {
	if proc == nil || proc.Pid() <= 0 {
		return
	}
	select {
	case <-waitDone:
		// The leader can exit while descendants still hold its process
		// group (and pipes). Clean those up once, in the lifetime owner.
		_ = killGroup(proc.Pid(), syscall.SIGKILL)
		return
	default:
	}
	_ = killGroup(proc.Pid(), syscall.SIGTERM)
	select {
	case <-waitDone:
		_ = killGroup(proc.Pid(), syscall.SIGKILL)
		return
	case <-clock.After(termGrace):
	}
	_ = killGroup(proc.Pid(), syscall.SIGKILL)
	select {
	case <-waitDone:
	case <-clock.After(killGrace):
	}
}
