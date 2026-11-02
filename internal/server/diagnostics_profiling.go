//go:build profiling

package server

import (
	"log/slog"
	"time"

	"github.com/hypernewbie/phi/internal/diagnostics"
)

// diagnosticsProcessStartedAt anchors elapsed_seconds in private snapshots.
// Set once at process initialization; no timer or goroutine reads it.
var diagnosticsProcessStartedAt = time.Now()

// StartPrivateDiagnostics starts the private loopback diagnostics server
// when dir is set, and returns its cleanup func. An empty dir returns a
// no-op close. Startup failure warns and continues without diagnostics.
func StartPrivateDiagnostics(dir string) func() {
	noop := func() {}
	if dir == "" {
		return noop
	}
	srv, err := diagnostics.Start(dir, diagnosticsProcessStartedAt, Commit)
	if err != nil {
		slog.Warn("private diagnostics unavailable; Phi will continue", "err", err)
		return noop
	}
	srv.SetOwnershipStats(func() any {
		if Hub == nil {
			return nil
		}
		return Hub.MemoryStats()
	})
	slog.Info("private diagnostics ready", "dir", srv.Dir())
	return func() {
		if err := srv.Close(); err != nil {
			slog.Warn("private diagnostics cleanup incomplete", "err", err)
		}
	}
}
