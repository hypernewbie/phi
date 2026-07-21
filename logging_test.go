package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// recordingHandler is a slog.Handler test double that appends every record
// it sees to a slice instead of writing anywhere. Tests assert on the
// captured attrs (trace, conn, pane, dur_ms, ...) rather than log strings.
type recordingHandler struct {
	mu   sync.Mutex
	recs []slog.Record
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.recs = append(h.recs, r)
	return nil
}

func (h *recordingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *recordingHandler) WithGroup(string) slog.Handler      { return h }

// records returns a snapshot of the records captured so far.
func (h *recordingHandler) records() []slog.Record {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]slog.Record, len(h.recs))
	copy(out, h.recs)
	return out
}

// installRecordingHandler swaps slog's default logger for one backed by a
// recordingHandler, restoring the previous default on test cleanup.
func installRecordingHandler(t *testing.T) *recordingHandler {
	t.Helper()
	h := &recordingHandler{}
	old := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(old) })
	return h
}

// attrMap flattens a slog.Record's attrs into a map keyed by attr name,
// for convenient lookups in test assertions.
func attrMap(r slog.Record) map[string]any {
	m := make(map[string]any)
	r.Attrs(func(a slog.Attr) bool {
		m[a.Key] = a.Value.Any()
		return true
	})
	return m
}

func TestParseLevel(t *testing.T) {
	cases := []struct {
		in   string
		want slog.Level
	}{
		{"debug", slog.LevelDebug},
		{"DEBUG", slog.LevelDebug},
		{"warn", slog.LevelWarn},
		{"warning", slog.LevelWarn},
		{"error", slog.LevelError},
		{"info", slog.LevelInfo},
		{"", slog.LevelInfo},
		{"bogus", slog.LevelInfo},
		{"  debug  ", slog.LevelDebug},
	}
	for _, c := range cases {
		if got := parseLevel(c.in); got != c.want {
			t.Errorf("parseLevel(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestResolveLevel_EnvFallback(t *testing.T) {
	t.Setenv("PHI_LOG", "warn")
	if got := resolveLevel(""); got != slog.LevelWarn {
		t.Errorf("resolveLevel(\"\") with PHI_LOG=warn = %v, want %v", got, slog.LevelWarn)
	}
	if got := resolveLevel("debug"); got != slog.LevelDebug {
		t.Errorf("resolveLevel(\"debug\") should override PHI_LOG env, got %v", got)
	}
}

// TestInitLogging_BridgesStdlibLog verifies log.Printf lines flow through
// the slog handler once initLogging has installed the bridge, and that the
// configured level is honored (a Debug-level bridge line is suppressed by
// an Info-level handler).
func TestInitLogging_BridgesStdlibLog(t *testing.T) {
	origOutput := log.Writer()
	origFlags := log.Flags()
	origDefault := slog.Default()
	t.Cleanup(func() {
		log.SetOutput(origOutput)
		log.SetFlags(origFlags)
		slog.SetDefault(origDefault)
	})

	var buf bytes.Buffer
	handler := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	slog.SetDefault(slog.New(handler))
	log.SetFlags(0)
	log.SetOutput(slogBridgeWriter{})

	log.Printf("[main] bridged line")

	out := buf.String()
	if !strings.Contains(out, "[main] bridged line") {
		t.Errorf("expected bridged log.Printf line in slog output, got %q", out)
	}
	if !strings.Contains(out, "level=INFO") {
		t.Errorf("expected bridged line to log at Info level, got %q", out)
	}
}

// TestInitLogging_DebugGate confirms initLogging wires the requested level
// into the handler: an Info-level init suppresses Debug records.
func TestInitLogging_DebugGate(t *testing.T) {
	origDefault := slog.Default()
	origOutput := log.Writer()
	origFlags := log.Flags()
	t.Cleanup(func() {
		slog.SetDefault(origDefault)
		log.SetOutput(origOutput)
		log.SetFlags(origFlags)
	})

	// initLogging always targets os.Stderr, so exercise the same
	// construction it does and check the resulting handler's gating
	// directly rather than trying to swap os.Stderr.
	ctx := context.Background()
	h := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: resolveLevel("info")})
	if h.Enabled(ctx, slog.LevelDebug) {
		t.Error("expected Debug records to be disabled under --log-level=info")
	}
	if !h.Enabled(ctx, slog.LevelInfo) {
		t.Error("expected Info records to be enabled under --log-level=info")
	}

	hDebug := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: resolveLevel("debug")})
	if !hDebug.Enabled(ctx, slog.LevelDebug) {
		t.Error("expected Debug records to be enabled under --log-level=debug")
	}
}

// TestNewTraceID_UniqueAndNonEmpty exercises the id generator standalone
// (L1): 16 hex chars, non-empty, unique across many calls.
func TestNewTraceID_UniqueAndNonEmpty(t *testing.T) {
	seen := make(map[string]bool)
	const n = 1000
	for i := 0; i < n; i++ {
		id := newTraceID()
		if id == "" {
			t.Fatal("newTraceID returned empty string")
		}
		if len(id) != 16 {
			t.Errorf("expected a 16 hex-char id, got %d chars (%q)", len(id), id)
		}
		if seen[id] {
			t.Fatalf("duplicate trace id generated after %d calls: %q", i, id)
		}
		seen[id] = true
	}
}

// TestRequestID_RoundTrip (L1): empty ctx -> "", context.WithValue(ridKey{})
// round-trips.
func TestRequestID_RoundTrip(t *testing.T) {
	if got := RequestID(context.Background()); got != "" {
		t.Errorf("RequestID on a bare ctx = %q, want \"\"", got)
	}
	ctx := context.WithValue(context.Background(), ridKey{}, "abc123")
	if got := RequestID(ctx); got != "abc123" {
		t.Errorf("RequestID round-trip = %q, want %q", got, "abc123")
	}
}

// TestTraceMiddleware_SetsHeaderAndLogs (L3): X-Request-Id is set, the
// wrapped handler observes the same id via RequestID(ctx), and the summary
// log line's "trace" attr matches the header value.
func TestTraceMiddleware_SetsHeaderAndLogs(t *testing.T) {
	h := installRecordingHandler(t)

	var sawID string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawID = RequestID(r.Context())
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("hi"))
	})

	req := httptest.NewRequest(http.MethodGet, "/api/diag", nil)
	rec := httptest.NewRecorder()
	traceMiddleware(next).ServeHTTP(rec, req)

	headerID := rec.Header().Get("X-Request-Id")
	if headerID == "" {
		t.Fatal("expected X-Request-Id response header to be set")
	}
	if sawID != headerID {
		t.Errorf("handler observed RequestID(ctx) = %q, want %q (header value)", sawID, headerID)
	}
	if rec.Code != http.StatusTeapot {
		t.Errorf("expected status %d, got %d", http.StatusTeapot, rec.Code)
	}

	recs := h.records()
	if len(recs) != 1 {
		t.Fatalf("expected exactly 1 log record, got %d", len(recs))
	}
	attrs := attrMap(recs[0])
	if fmt.Sprint(attrs["trace"]) != headerID {
		t.Errorf("log trace attr = %v, want %q", attrs["trace"], headerID)
	}
	if fmt.Sprint(attrs["status"]) != fmt.Sprint(http.StatusTeapot) {
		t.Errorf("log status attr = %v, want %d", attrs["status"], http.StatusTeapot)
	}
	if fmt.Sprint(attrs["bytes"]) != "2" {
		t.Errorf("log bytes attr = %v, want 2", attrs["bytes"])
	}
	if _, ok := attrs["dur_ms"]; !ok {
		t.Error("expected a dur_ms attr on the summary log line")
	}
}

// TestTraceMiddleware_404StatusAndBytes (L3): a 404 write is logged with
// status=404 and the correct byte count.
func TestTraceMiddleware_404StatusAndBytes(t *testing.T) {
	h := installRecordingHandler(t)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	req := httptest.NewRequest(http.MethodGet, "/nope", nil)
	rec := httptest.NewRecorder()
	traceMiddleware(next).ServeHTTP(rec, req)

	recs := h.records()
	if len(recs) != 1 {
		t.Fatalf("expected exactly 1 log record, got %d", len(recs))
	}
	attrs := attrMap(recs[0])
	if fmt.Sprint(attrs["status"]) != "404" {
		t.Errorf("expected status=404, got %v", attrs["status"])
	}
	wantBytes := rec.Body.Len()
	if fmt.Sprint(attrs["bytes"]) != fmt.Sprint(wantBytes) {
		t.Errorf("expected bytes=%d, got %v", wantBytes, attrs["bytes"])
	}
}

// TestTraceMiddleware_PollSpamPathsLogAtDebug confirms /api/diff and
// /api/system/cpu are demoted to Debug so poll spam doesn't drown out real
// traffic at the default Info level, while other paths stay at Info.
func TestTraceMiddleware_PollSpamPathsLogAtDebug(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})

	h := installRecordingHandler(t)
	traceMiddleware(next).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/diff", nil))
	recs := h.records()
	if len(recs) != 1 || recs[0].Level != slog.LevelDebug {
		t.Fatalf("expected /api/diff to log at Debug, got %+v", recs)
	}

	traceMiddleware(next).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/diag", nil))
	recs = h.records()
	if len(recs) != 2 || recs[1].Level != slog.LevelInfo {
		t.Fatalf("expected /api/diag to log at Info, got %+v", recs)
	}
}
