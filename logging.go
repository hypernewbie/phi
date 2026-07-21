package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// parseLevel maps a level name (case-insensitive) to a slog.Level.
// Unknown/empty values fall back to Info — the same default phi has always
// had, just now leveled instead of freeform.
func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// resolveLevel applies the documented precedence: --log-level flag, then
// PHI_LOG env var, then "info".
func resolveLevel(flagVal string) slog.Level {
	if flagVal == "" {
		flagVal = os.Getenv("PHI_LOG")
	}
	return parseLevel(flagVal)
}

// initLogging builds the process-wide slog handler (text by default, JSON
// if PHI_LOG_FORMAT=json), installs it via slog.SetDefault, and bridges the
// stdlib "log" package through it so the ~47 existing log.Printf("[tag] ...")
// call sites keep working unchanged — no mechanical rewrite required.
func initLogging(level string) *slog.Logger {
	opts := &slog.HandlerOptions{Level: resolveLevel(level)}

	var handler slog.Handler
	if os.Getenv("PHI_LOG_FORMAT") == "json" {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		handler = slog.NewTextHandler(os.Stderr, opts)
	}

	logger := slog.New(handler)
	slog.SetDefault(logger)

	// Bridge: stdlib log.Printf/log.Print/log.Fatal* lines flow through the
	// same slog handler at Info level, carrying their own "[tag]" prefix as
	// the message text. log.SetFlags(0) drops the stdlib timestamp/prefix so
	// slog's own time/level fields aren't duplicated.
	log.SetFlags(0)
	log.SetOutput(slogBridgeWriter{})

	return logger
}

// slogBridgeWriter forwards stdlib log output into slog.Default() at Info
// level, one record per Write call (the stdlib logger always calls Write
// once per formatted line).
type slogBridgeWriter struct{}

func (slogBridgeWriter) Write(p []byte) (int, error) {
	slog.Default().Info(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// ridKey is the context key under which traceMiddleware stores the
// per-request trace id. Unexported type keeps it collision-proof.
type ridKey struct{}

// RequestID returns the trace id stashed in ctx by traceMiddleware, or ""
// if ctx carries none (e.g. a background job, or a test that never went
// through the middleware).
func RequestID(ctx context.Context) string {
	if v, ok := ctx.Value(ridKey{}).(string); ok {
		return v
	}
	return ""
}

// newTraceID mints a 16-hex-char id from crypto/rand. Deliberately not
// google/uuid — keeps the default build's dependency count at zero.
func newTraceID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand.Read failing is effectively unreachable on supported
		// platforms; fall back to a timestamp so callers still get a
		// non-empty, reasonably-unique id instead of a panic.
		return hex.EncodeToString([]byte(time.Now().Format("20060102150405.000000000")))
	}
	return hex.EncodeToString(b)
}

// debugLogPaths are poll-spam endpoints the front-end hits on a timer;
// logging them at Info would drown out real traffic, so they log at Debug.
var debugLogPaths = map[string]bool{
	"/api/diff":       true,
	"/api/system/cpu": true,
}

// statusWriter wraps http.ResponseWriter to capture the status code and
// byte count traceMiddleware needs for its summary log line.
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wrote {
		w.status = code
		w.wrote = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.status = http.StatusOK
		w.wrote = true
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

// traceMiddleware is the single seam every HTTP request flows through: it
// mints a trace id, exposes it via X-Request-Id and RequestID(ctx), and
// logs one summary line (method, path, status, bytes, duration) per request.
func traceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := newTraceID()
		r = r.WithContext(context.WithValue(r.Context(), ridKey{}, id))
		w.Header().Set("X-Request-Id", id)

		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(sw, r)
		dur := time.Since(start)

		level := slog.LevelInfo
		if debugLogPaths[r.URL.Path] {
			level = slog.LevelDebug
		}
		slog.Default().Log(r.Context(), level, "http",
			"trace", id,
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"bytes", sw.bytes,
			"dur_ms", dur.Milliseconds(),
		)
	})
}
