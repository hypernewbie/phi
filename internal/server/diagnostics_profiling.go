//go:build profiling

package server

import (
	"log/slog"

	"github.com/hypernewbie/phi/internal/diagnostics"
	"github.com/hypernewbie/phi/pkg/ws"
)

// startPrivateDiagnostics starts the private loopback diagnostics server
// when dir is set, and returns its cleanup func. An empty dir returns a
// no-op close. Startup failure warns and continues without diagnostics.
func (app *Server) startPrivateDiagnostics(dir string) func() {
	noop := func() {}
	if dir == "" {
		return noop
	}
	srv, err := diagnostics.Start(dir, app.diagnosticsProcessStartedAt, app.commit)
	if err != nil {
		slog.Warn("private diagnostics unavailable; Phi will continue", "err", err)
		return noop
	}
	srv.SetOwnershipStats(func() any {
		if app.hub == nil {
			return nil
		}
		return app.hub.MemoryStats()
	})
	srv.SetRuntimeStats(func() any { return ws.RuntimeStats() })
	slog.Info("private diagnostics ready", "dir", srv.Dir())
	return func() {
		if err := srv.Close(); err != nil {
			slog.Warn("private diagnostics cleanup incomplete", "err", err)
		}
	}
}
