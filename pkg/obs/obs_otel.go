//go:build otel

// This file is the //go:build otel backend for the obs façade — see
// obs_noop.go for the default (dependency-free) backend and the package
// doc comment there for the two-backend design. Only this file imports
// go.opentelemetry.io/*, so the untagged binary never pulls in the otel
// SDK (verified by `go list -deps ./... | grep -c opentelemetry` == 0).
package obs

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.28.0"
	"go.opentelemetry.io/otel/trace"
)

// Span starts a real OTel span named name with the given key,value,...
// attrs, folded into typed attribute.KeyValue via toKV. The returned end
// records the error (if any) and sets the span status before ending it —
// then, for parity with the default build, emits the same timed
// slog.Debug("span", ...) line so a --log-level=debug capture looks
// identical whether or not the otel tag is compiled in.
//
// otel.Tracer(...) is called fresh on every invocation rather than cached
// in a package var: a package-level var would resolve otel.GetTracerProvider()
// once at process/test-binary init — before main()'s obs.Init() (or a
// test's otel.SetTracerProvider) installs the real one — and permanently
// hold the wrong (no-op) tracer. Same footgun as pkg/ws's componentLogger.
func Span(ctx context.Context, name string, attrs ...any) (context.Context, func(error)) {
	tracer := otel.Tracer("github.com/hypernewbie/phi")
	ctx, span := tracer.Start(ctx, name, trace.WithAttributes(toKV(attrs...)...))
	start := time.Now()
	return ctx, func(err error) {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		span.End()

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

// toKV folds a Span key,value,key,value,... vararg list into typed OTel
// attributes.
func toKV(attrs ...any) []attribute.KeyValue {
	var kvs []attribute.KeyValue
	for i := 0; i+1 < len(attrs); i += 2 {
		key, ok := attrs[i].(string)
		if !ok {
			continue
		}
		switch v := attrs[i+1].(type) {
		case string:
			kvs = append(kvs, attribute.String(key, v))
		case int:
			kvs = append(kvs, attribute.Int(key, v))
		case int64:
			kvs = append(kvs, attribute.Int64(key, v))
		case bool:
			kvs = append(kvs, attribute.Bool(key, v))
		case error:
			kvs = append(kvs, attribute.String(key, v.Error()))
		default:
			kvs = append(kvs, attribute.String(key, fmt.Sprint(v)))
		}
	}
	return kvs
}

// Init stands up the OTel SDK: an OTLP/gRPC exporter, a batch processor
// (short timeouts so a dead collector can never block the app), and a
// resource tagged service.name=phi. Fail-open: any error here (or later,
// during background export) is logged via slog.Warn — Init itself never
// returns a fatal error, and an empty endpoint disables tracing entirely.
func Init(ctx context.Context, endpoint string) (shutdown func(context.Context) error, err error) {
	noop := func(context.Context) error { return nil }
	if endpoint == "" {
		return noop, nil
	}

	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		slog.Warn("otel error", "err", err)
	}))

	exp, expErr := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
		otlptracegrpc.WithTimeout(3*time.Second),
	)
	if expErr != nil {
		slog.Warn("otel: failed to create OTLP exporter, tracing disabled", "endpoint", endpoint, "err", expErr)
		return noop, nil
	}

	res := resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceNameKey.String("phi"))

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp,
			sdktrace.WithBatchTimeout(5*time.Second),
			sdktrace.WithExportTimeout(3*time.Second),
		),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)

	return tp.Shutdown, nil
}

// WrapHTTP opens the HTTP server span for every request — traceparent
// extraction, semconv HTTP attributes, the works — via the official
// instrumentation library rather than a hand-rolled middleware.
func WrapHTTP(h http.Handler) http.Handler {
	return otelhttp.NewHandler(h, "phi")
}

// TraceIDFromContext returns the active span's trace id (hex), or "" if
// ctx carries no valid span context.
func TraceIDFromContext(ctx context.Context) string {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return ""
	}
	return sc.TraceID().String()
}
