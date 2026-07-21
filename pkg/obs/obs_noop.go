//go:build !otel

// Package obs is phi's tracing façade: one seam — Span, Init, WrapHTTP,
// TraceIDFromContext — with two build-selected backends, so a single call
// site (e.g. obs.Span(ctx, "git.diff", ...)) instruments both worlds:
//
//   - default build (this file, //go:build !otel): no dependencies. Span
//     is a timed slog.Debug line; WrapHTTP/Init are no-ops; there is no
//     span to read a trace id from, so TraceIDFromContext always returns
//     "".
//   - //go:build otel (obs_otel.go): real OpenTelemetry spans, exported
//     via OTLP, plus otelhttp for the HTTP server span. Only that file
//     imports go.opentelemetry.io/*, so the untagged binary never pulls
//     in the otel SDK — see the build-partition guard in the plan (§E).
package obs

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// Span starts a logical span named name with the given key,value,... attrs.
// In the default build there is no real span: ctx flows through unchanged,
// and the returned end func times the operation and emits one
// slog.Debug("span", ...) line (attrs plus dur_ms, and err on failure) —
// gated behind the Debug level like every other hot-path trace in phi, so
// it costs nothing at the default Info level.
func Span(ctx context.Context, name string, attrs ...any) (context.Context, func(error)) {
	start := time.Now()
	return ctx, func(err error) {
		if !slog.Default().Enabled(ctx, slog.LevelDebug) {
			return
		}
		args := append([]any{"span", name, "dur_ms", time.Since(start).Milliseconds()}, attrs...)
		if err != nil {
			args = append(args, "err", err)
		}
		slog.Default().Debug("span", args...)
	}
}

// Init is a no-op in the default build: there is no OTel provider to stand
// up and no collector endpoint to dial. The returned shutdown is a no-op.
func Init(ctx context.Context, endpoint string) (shutdown func(context.Context) error, err error) {
	return func(context.Context) error { return nil }, nil
}

// WrapHTTP is a no-op in the default build — no OTel server span, no
// traceparent extraction. Just returns h unchanged.
func WrapHTTP(h http.Handler) http.Handler { return h }

// TraceIDFromContext always returns "" in the default build: there is no
// OTel span in ctx to read a trace id from.
func TraceIDFromContext(ctx context.Context) string { return "" }
