//go:build profiling

package main

import (
	"log/slog"
	"time"

	"github.com/hypernewbie/phi/internal/diagnostics"
)

// diagnosticsProcessStartedAt anchors elapsed_seconds in private snapshots.
// Set once at process initialization; no timer or goroutine reads it.
var diagnosticsProcessStartedAt = time.Now()

// startPrivateDiagnostics starts the private loopback diagnostics server
// when dir is set, and returns its cleanup func. An empty dir returns a
// no-op close. Startup failure warns and continues without diagnostics.
func startPrivateDiagnostics(dir string) func() {
	noop := func() {}
	if dir == "" {
		return noop
	}
	server, err := diagnostics.Start(dir, diagnosticsProcessStartedAt, Commit)
	if err != nil {
		slog.Warn("private diagnostics unavailable; Phi will continue", "err", err)
		return noop
	}
	server.SetOwnershipStats(func() any {
		if wsHub == nil {
			return nil
		}
		return wsHub.MemoryStats()
	})
	slog.Info("private diagnostics ready", "dir", server.Dir())
	return func() {
		if err := server.Close(); err != nil {
			slog.Warn("private diagnostics cleanup incomplete", "err", err)
		}
	}
}
