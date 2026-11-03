//go:build otel

package pibridge

import (
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// withSpanRecorder installs a recorder-backed provider and a W3C propagator as
// global state. obs.Init is never called in tests, so the propagator must be set
// here or extraction silently no-ops and the span arrives as a fresh root.
// Global state: callers must not use t.Parallel().
func withSpanRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	sr := tracetest.NewSpanRecorder()
	prevProvider := otel.GetTracerProvider()
	prevProp := otel.GetTextMapPropagator()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr)))
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		otel.SetTracerProvider(prevProvider)
		otel.SetTextMapPropagator(prevProp)
	})
	return sr
}

// settledMessage is the cheapest valid envelope that reaches a return without
// touching a live peer: an unknown route errors, so use a payload handleMessage
// accepts and drops, keeping the test about span parentage only.
func settledMessage(traceparent string) *pibridgepb.PiToPhi {
	return &pibridgepb.PiToPhi{
		PaneId:      "pane-trace",
		ProcessId:   "proc-trace",
		Traceparent: traceparent,
	}
}

// TestHandleMessageParentsToPeerTraceparent is the MVP's core claim: a trace id
// minted by the Pi extension arrives in the envelope and parents the Phi span.
func TestHandleMessageParentsToPeerTraceparent(t *testing.T) {
	sr := withSpanRecorder(t)
	s := NewServer()
	proc, _, err := s.RegisterPending("pane-trace")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	l, ok := s.reg.lookupByProcess(proc)
	if !ok {
		t.Fatal("lease missing")
	}

	const (
		wantTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
		wantSpan  = "00f067aa0ba902b7"
	)
	p := newPeer(1, "sess", nil)
	l.mu.Lock()
	l.maxGen, l.runtimeID, l.sessionID = 1, "rt", "sess"
	l.peer = p
	l.mu.Unlock()

	msg := settledMessage("00-" + wantTrace + "-" + wantSpan + "-01")
	msg.Payload = &pibridgepb.PiToPhi_HistoryResponse{
		HistoryResponse: &pibridgepb.HistoryResponse{RequestId: "no-such-request"},
	}
	// An unknown request id is dropped by deliverHistory without error, so the
	// span is the only thing this test observes.
	_ = s.handleMessage(l, p, msg)

	spans := sr.Ended()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	got := spans[0]
	if got.SpanContext().TraceID().String() != wantTrace {
		t.Errorf("trace id = %s, want %s (traceparent not propagated across the hop)",
			got.SpanContext().TraceID(), wantTrace)
	}
	if got.Parent().SpanID().String() != wantSpan {
		t.Errorf("parent span id = %s, want %s", got.Parent().SpanID(), wantSpan)
	}
}

// TestHandleMessageMalformedTraceparentStartsFreshTrace covers the
// graceful-degradation rule: a peer that sends garbage must still be served, and
// the span simply roots itself instead of parenting.
func TestHandleMessageMalformedTraceparentStartsFreshTrace(t *testing.T) {
	sr := withSpanRecorder(t)
	s := NewServer()
	proc, _, err := s.RegisterPending("pane-bad-trace")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	l, ok := s.reg.lookupByProcess(proc)
	if !ok {
		t.Fatal("lease missing")
	}
	p := newPeer(1, "sess", nil)
	l.mu.Lock()
	l.maxGen, l.runtimeID, l.sessionID = 1, "rt", "sess"
	l.peer = p
	l.mu.Unlock()

	msg := settledMessage("not-a-traceparent")
	msg.Payload = &pibridgepb.PiToPhi_HistoryResponse{
		HistoryResponse: &pibridgepb.HistoryResponse{RequestId: "no-such-request"},
	}
	if err := s.handleMessage(l, p, msg); err != nil {
		t.Fatalf("malformed traceparent must not error, got %v", err)
	}

	spans := sr.Ended()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	got := spans[0]
	if !got.SpanContext().TraceID().IsValid() {
		t.Fatal("span has no trace id")
	}
	if got.Parent().IsValid() {
		t.Errorf("malformed header must not produce a remote parent, got %s", got.Parent().SpanID())
	}
}
