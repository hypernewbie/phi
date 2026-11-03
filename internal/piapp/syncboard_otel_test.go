//go:build otel

package piapp

import (
	"context"
	"net"
	"net/http"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/hypernewbie/phi/internal/config"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"github.com/hypernewbie/phi/pkg/obs"
)

// withRecorder installs a recorder-backed provider plus the W3C propagator, and
// enables the obs gate. Tests never call obs.Init, so without SetEnabledForTest
// the gated WrapHTTP is identity and no child server span would be recorded —
// the assertion would pass while testing nothing. Global state: no t.Parallel().
func withRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	sr := tracetest.NewSpanRecorder()
	prevProvider := otel.GetTracerProvider()
	prevProp := otel.GetTextMapPropagator()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr)))
	otel.SetTextMapPropagator(propagation.TraceContext{})
	restore := obs.SetEnabledForTest(true)
	t.Cleanup(func() {
		restore()
		otel.SetTracerProvider(prevProvider)
		otel.SetTextMapPropagator(prevProp)
	})
	return sr
}

// syncboardBridge builds the minimal Bridge that reaches callSyncboardInternal
// against an in-process handler, matching the existing self-target fixtures.
func syncboardBridge(t *testing.T, local http.Handler) *Bridge {
	t.Helper()
	return &Bridge{
		panes:        map[string]*bridgePane{"pane": {processID: "proc", managed: true}},
		listenerAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 7070},
		Syncboard:    local,
		LoadConfig:   func() (config.Config, error) { return Config{SyncCoordinator: "http://127.0.0.1:7070"}, nil },
	}
}

func okLocalHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"key":"k","value":"{}","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]`))
	})
}

// TestHandleSyncboardSpansShareOneTrace is the MVP claim on the Phi side: the
// handler span and the in-process server span belong to the same trace, with the
// supplied remote parent as the root.
func TestHandleSyncboardSpansShareOneTrace(t *testing.T) {
	sr := withRecorder(t)
	const (
		wantTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
		wantSpan  = "00f067aa0ba902b7"
	)
	ctx := otel.GetTextMapPropagator().Extract(context.Background(),
		propagation.MapCarrier{"traceparent": "00-" + wantTrace + "-" + wantSpan + "-01"})

	bridge := syncboardBridge(t, okLocalHandler())
	got := bridge.handleSyncboard(ctx, "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if got.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE {
		t.Fatalf("outcome = %v, want http response", got.GetOutcome())
	}

	spans := sr.Ended()
	handlerIdx := -1
	for i, s := range spans {
		if s.Name() == "syncboard.handle" {
			handlerIdx = i
			break
		}
	}
	if handlerIdx < 0 {
		t.Fatalf("syncboard.handle span missing from %d recorded spans", len(spans))
	}
	handler := spans[handlerIdx]
	if got := handler.SpanContext().TraceID().String(); got != wantTrace {
		t.Errorf("handler trace id = %s, want %s", got, wantTrace)
	}
	// The handler span must continue the caller's trace, not start a new root.
	if got := handler.Parent().SpanID().String(); got != wantSpan {
		t.Errorf("handler parent span id = %s, want %s", got, wantSpan)
	}
	// The in-process dispatch must be a child of the handler in the same trace.
	// Counted rather than name-matched: the point is the lineage, and a lost
	// parent silently splits the trace into two roots that only look connected
	// because they happen to share a handoff.
	childFound := false
	for _, s := range spans {
		if s.Parent().SpanID() != handler.SpanContext().SpanID() {
			continue
		}
		childFound = true
		if s.SpanContext().TraceID() != handler.SpanContext().TraceID() {
			t.Errorf("child span trace id = %s, want %s", s.SpanContext().TraceID(), handler.SpanContext().TraceID())
		}
	}
	if !childFound {
		t.Errorf("no span parented to syncboard.handle in %d recorded spans", len(spans))
	}
}

// TestHandleSyncboardEmptyTraceparentStillServes is the graceful-degradation
// rule: no traceparent must not change the outcome or the error path.
func TestHandleSyncboardEmptyTraceparentStillServes(t *testing.T) {
	sr := withRecorder(t)
	bridge := syncboardBridge(t, okLocalHandler())

	got := bridge.handleSyncboard(context.Background(), "proc", &pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if got.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || got.GetHttpStatus() != http.StatusOK {
		t.Fatalf("unparented call = %v/%d, want http response 200", got.GetOutcome(), got.GetHttpStatus())
	}
	if len(sr.Ended()) == 0 {
		t.Fatal("expected spans even without a caller traceparent")
	}
}
