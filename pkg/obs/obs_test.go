package obs

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// withDebugHandler installs a Debug-level slog.Default() backed by buf for
// the duration of the test, restoring the previous default on cleanup.
func withDebugHandler(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

// TestSpan_CtxFlowsUnchanged (L1): the default-build Span is ctx-transparent.
func TestSpan_CtxFlowsUnchanged(t *testing.T) {
	type key struct{}
	ctx := context.WithValue(context.Background(), key{}, "marker")
	gotCtx, end := Span(ctx, "test.op")
	defer end(nil)
	if gotCtx.Value(key{}) != "marker" {
		t.Error("expected Span to return ctx unchanged in the default build")
	}
}

// TestSpan_EndIsSafe (L1): end() must never panic, with or without an error.
func TestSpan_EndIsSafe(t *testing.T) {
	withDebugHandler(t)

	_, end := Span(context.Background(), "test.op", "attr", "val")
	end(nil)

	_, end2 := Span(context.Background(), "test.op2")
	end2(context.Canceled)
}

// TestSpan_EmitsDebugLine (L1): end() emits one Debug-level "span" line
// carrying the span name, dur_ms, and any attrs — only when Debug is
// enabled (hot-path cost stays zero at Info, per the WS/PTY guardrail).
func TestSpan_EmitsDebugLine(t *testing.T) {
	buf := withDebugHandler(t)

	_, end := Span(context.Background(), "git.diff", "cwd", "/tmp/repo")
	end(nil)

	out := buf.String()
	if !strings.Contains(out, "span=git.diff") {
		t.Errorf("expected span line to name the op, got %q", out)
	}
	if !strings.Contains(out, "dur_ms=") {
		t.Errorf("expected span line to carry dur_ms, got %q", out)
	}
	if !strings.Contains(out, "cwd=/tmp/repo") {
		t.Errorf("expected span line to carry the attrs passed to Span, got %q", out)
	}
}

// TestSpan_ErrorAttr (L1): end(err) surfaces the error on the debug line.
func TestSpan_ErrorAttr(t *testing.T) {
	buf := withDebugHandler(t)

	_, end := Span(context.Background(), "db.query")
	end(context.Canceled)

	if !strings.Contains(buf.String(), "context canceled") {
		t.Errorf("expected the span's error to appear on the debug line, got %q", buf.String())
	}
}

// TestSpan_SilentAboveDebug: at Info level (the default), Span's end must
// not emit anything — this is what keeps it free on the hot path.
func TestSpan_SilentAboveDebug(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })

	_, end := Span(context.Background(), "hot.path")
	end(nil)

	if buf.Len() != 0 {
		t.Errorf("expected no output at Info level, got %q", buf.String())
	}
}

// TestWrapHTTP_Noop: the default build's WrapHTTP is a pure pass-through.
func TestWrapHTTP_Noop(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	wrapped := WrapHTTP(inner)

	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusTeapot {
		t.Errorf("expected WrapHTTP to pass through unchanged, got status %d", rec.Code)
	}
}

// TestTraceIDFromContext_AlwaysEmpty (L1): no span exists to read a trace
// id from in the default build.
func TestTraceIDFromContext_AlwaysEmpty(t *testing.T) {
	if got := TraceIDFromContext(context.Background()); got != "" {
		t.Errorf("TraceIDFromContext = %q, want \"\" in the default build", got)
	}
}

// TestInit_NoopShutdown: Init never errors and its shutdown is callable.
func TestInit_NoopShutdown(t *testing.T) {
	shutdown, err := Init(context.Background(), "localhost:4317")
	if err != nil {
		t.Fatalf("Init returned an error in the default build: %v", err)
	}
	if shutdown == nil {
		t.Fatal("expected a non-nil shutdown func")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Errorf("expected shutdown to be a no-op, got err: %v", err)
	}
}
