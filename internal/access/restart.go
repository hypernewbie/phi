package access

import "log"

// RestartOnWindows spawns a detached child and closes auth once the child
// exists. An overlapping call is ignored: the first claim owns the restart.
// The caller supplies spawn and exit so this stays testable.
func RestartOnWindows(auth *Manager, spawnDetached func() (int, error), exit func(int)) {
	if !auth.ClaimRestartAttempt() {
		return
	}
	pid, err := spawnDetached()
	if err != nil {
		auth.CancelRestartAttempt()
		log.Printf("[restart] SpawnDetached failed: %v", err)
		return
	}
	log.Printf("[restart] spawned detached child pid=%d, exiting parent", pid)
	if !auth.BeginClaimedRestart() {
		log.Printf("[restart] could not begin auth shutdown after child spawn")
		return
	}
	exit(0)
}

// RestartOnUnix closes auth before syscall.Exec replaces the process image.
// A failed exec restores ownership; a failed recovery leaves authentication
// unavailable rather than half-open.
func RestartOnUnix(auth *Manager, execSelf func() error) {
	if !auth.BeginRestart() {
		return
	}
	if err := execSelf(); err != nil {
		log.Printf("[restart] ExecSelf failed: %v", err)
		if !auth.RecoverRestart() {
			log.Printf("[restart] auth ownership recovery failed; authentication remains unavailable")
		}
	}
}
