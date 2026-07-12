//go:build !windows

package restart

import (
	"os/exec"
	"syscall"
)

// applyDetachedSysProcAttr sets platform-specific flags that put the
// child in its own session so it survives the parent exiting.
func applyDetachedSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
}