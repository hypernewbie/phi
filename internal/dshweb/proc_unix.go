//go:build darwin || linux

package dshweb

import "syscall"

// newSysAttr places the owned child in its own process group so
// termination reaches the whole tree.
func newSysAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup signals the owned process group. A negative pid
// targets the group; errors (including already-exited) are ignored by
// the caller.
func killProcessGroup(pid int, sig syscall.Signal) error {
	return syscall.Kill(-pid, sig)
}

func supportedPlatform() bool { return true }
