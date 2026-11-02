//go:build !profiling

package server

import "log/slog"

// StartPrivateDiagnostics is a no-op in normal builds: the private
// diagnostics implementation is compiled out. A nonempty dir warns once
// that a profiling build is required; it never touches the directory.
func StartPrivateDiagnostics(dir string) func() {
	if dir != "" {
		slog.Warn("private diagnostics require a binary built with -tags=profiling; continuing without diagnostics")
	}
	return func() {}
}
