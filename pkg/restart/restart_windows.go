//go:build windows

package restart

import (
	"os/exec"
	"syscall"
)

// applyDetachedSysProcAttr sets Windows-specific flags: CREATE_NEW_PROCESS_GROUP
// + DETACHED_PROCESS so we don't share a console and the child is its own
// process group root.
func applyDetachedSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008 | 0x00000200,
	}
}
