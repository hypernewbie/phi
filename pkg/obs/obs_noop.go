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

	"google.golang.org/grpc/stats"
)

// Span starts a logical span named name with the given key,value,... attrs.
// In the default build there is no OTel span. During a private timing
// capture (profiling builds only), allowlisted spans below an API root
// carry a local timing scope.
// Otherwise ctx flows through unchanged. The returned end func also emits
// slog.Debug("span", ...) (attrs plus dur_ms, and err on failure) when Debug
// logging is enabled.
func Span(ctx context.Context, name string, attrs ...any) (context.Context, func(error)) {
	start := time.Now()
	ctx, gen, id, recorded := timingSpanStart(ctx, name)
	return ctx, func(err error) {
		if recorded {
			timingSpanEnd(gen, id)
		}
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

// Enabled is always false in the default build: no provider is ever installed.
func Enabled() bool { return false }

// SetEnabledForTest is a no-op in the default build and exists so test code
// compiles against the same façade in both tag worlds.
func SetEnabledForTest(bool) func() { return func() {} }

// SpanFromTraceparent behaves like Span: there is no propagator and no parent
// to extract, so the header is ignored.
func SpanFromTraceparent(ctx context.Context, _ string, name string, attrs ...any) (context.Context, func(error)) {
	return Span(ctx, name, attrs...)
}

// Transport is unmodified passthrough in the default build.
func Transport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		return http.DefaultTransport
	}
	return base
}

// GRPCServerHandler is nil in the default build: no stream span, no
// per-RPC stats collection.
func GRPCServerHandler() stats.Handler { return nil }

// TraceIDFromContext always returns "" in the default build: there is no
// OTel span in ctx to read a trace id from.
func TraceIDFromContext(ctx context.Context) string { return "" }
