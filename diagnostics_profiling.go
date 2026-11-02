//go:build profiling

package main

import (
	"log/slog"
	"time"

	"github.com/hypernewbie/phi/internal/diagnostics"
	"github.com/hypernewbie/phi/internal/server"
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
	srv, err := diagnostics.Start(dir, diagnosticsProcessStartedAt, server.Commit)
	if err != nil {
		slog.Warn("private diagnostics unavailable; Phi will continue", "err", err)
		return noop
	}
	srv.SetOwnershipStats(func() any {
		if server.Hub == nil {
			return nil
		}
		return server.Hub.MemoryStats()
	})
	slog.Info("private diagnostics ready", "dir", srv.Dir())
	return func() {
		if err := srv.Close(); err != nil {
			slog.Warn("private diagnostics cleanup incomplete", "err", err)
		}
	}
}
