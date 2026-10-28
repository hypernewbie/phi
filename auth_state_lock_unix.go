//go:build unix

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// lockAuthStateFile takes the exclusive auth-state lock without blocking, so a
// second phi instance discovers that another process owns this state
// directory instead of waiting forever. The pattern matches the WS hub lease in
// pkg/ws/lease_unix.go; auth cannot import it because those helpers are
// unexported.
func lockAuthStateFile(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

func unlockAuthStateFile(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_UN)
}
