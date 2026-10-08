package phic

import "time"

const (
	// Outlast the server's five-minute heartbeat grace period. Switching
	// views or suspending the device must not trigger a tight idle timeout.
	paneReadTimeout  = 6 * time.Minute
	paneWriteTimeout = time.Minute
)
