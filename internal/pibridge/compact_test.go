package pibridge

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func fptr(f float64) *float64 { return &f }

func idleReadiness() *pibridgepb.CompactReadiness {
	return &pibridgepb.CompactReadiness{Idle: true}
}

func compactHello(pane, proc string, gen uint64, state pibridgepb.LogicalState, ready *pibridgepb.CompactReadiness, usage *pibridgepb.ContextUsageSnapshot) *pibridgepb.PiToPhi {
	return &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PiToPhi_Hello{
			Hello: &pibridgepb.Hello{
				ProtocolVersion: ProtocolVersion,
				SessionId:       "sess", RuntimeId: "rt",
				Capabilities: []string{CapabilityLifecycle, CapabilityContext, CapabilityCompact},
				CurrentState: &pibridgepb.StateSnapshot{
					State:     state,
					SessionId: "sess", LeafId: "leaf",
					Model:            &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
					ContextUsage:     usage,
					CompactReadiness: ready,
				},
			},
		},
	}
}

// openCompactStream registers a lease and opens an accepted idle stream
// with context+compact capabilities. It returns the stream, process ID,
// token, cancel, and the live publication revision for stamps.
func openCompactStream(t *testing.T, s *Server, sock, pane string) (pibridgepb.Integration_ConnectClient, string, string, context.CancelFunc, uint64) {
	t.Helper()
	proc, token, err := s.RegisterPending(pane)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, pane, proc, token)
	if err := stream.Send(compactHello(pane, proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReadiness(), nil)); err != nil {
		cancel()
		t.Fatalf("hello: %v", err)
	}
	recvAccepted(t, stream)
	rev, ok := s.PublicationRevision(proc)
	if !ok {
		cancel()
		t.Fatal("no publication revision")
	}
	return stream, proc, token, cancel, rev
}

type compactWireRequest struct {
	id              string
	session, leaf   string
	model           *pibridgepb.ModelSnapshot
	hasExpectedLeaf bool
}

func recvCompactRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) compactWireRequest {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type res struct {
		msg *pibridgepb.PhiToPi
		err error
	}
	ch := make(chan res, 1)
	go func() {
		m, e := stream.Recv()
		ch <- res{msg: m, err: e}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("recv request: %v", r.err)
		}
		req := r.msg.GetCompactRequest()
		if req == nil {
			t.Fatalf("not a compact request: %v", r.msg.GetPayload())
		}
		return compactWireRequest{
			id: req.GetRequestId(), session: req.GetExpectedSessionId(),
			leaf: req.GetExpectedLeafId(), model: req.GetExpectedModel(),
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for compact request")
		return compactWireRequest{}
	}
}

func sendCompactResult(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, gen uint64, res *pibridgepb.CompactResult) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PiToPhi_CompactResult{CompactResult: res},
	}); err != nil {
		t.Fatalf("send result: %v", err)
	}
}

// expectNoCompactRequest fails when any message arrives within the window.
func expectNoCompactRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) {
	t.Helper()
	type res struct {
		msg *pibridgepb.PhiToPi
		err error
	}
	ch := make(chan res, 1)
	go func() {
		m, e := stream.Recv()
		ch <- res{msg: m, err: e}
	}()
	select {
	case r := <-ch:
		if r.err == nil {
			t.Fatalf("unexpected host invocation: %v", r.msg.GetPayload())
		}
	case <-time.After(200 * time.Millisecond):
	}
}

func TestNegotiateContextCompactIndependently(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-caps")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-caps", proc, token)
	defer cancel()
	hello := testHello("pane-caps", proc, 1, CapabilityLifecycle, CapabilityContext, CapabilityCompact, "unknown.future.v9")
	if err := stream.Send(hello); err != nil {
		t.Fatalf("send: %v", err)
	}
	acc := recvAccepted(t, stream)
	want := map[string]bool{CapabilityLifecycle: true, CapabilityContext: true, CapabilityCompact: true}
	if len(acc.GetCapabilities()) != len(want) {
		t.Fatalf("accepted caps %v", acc.GetCapabilities())
	}
	for _, c := range acc.GetCapabilities() {
		if !want[c] {
			t.Fatalf("accepted caps %v", acc.GetCapabilities())
		}
	}
	view, ok := s.PaneState(proc)
	if !ok {
		t.Fatal("lease missing")
	}
	if len(view.Caps) != 3 {
		t.Fatalf("retained caps %v", view.Caps)
	}
	// Context without compact negotiates independently.
	proc2, token2, err := s.RegisterPending("pane-ctx")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc2)
	stream2, cancel2 := openStream(t, sock, "pane-ctx", proc2, token2)
	defer cancel2()
	if err := stream2.Send(testHello("pane-ctx", proc2, 1, CapabilityLifecycle, CapabilityContext)); err != nil {
		t.Fatalf("send: %v", err)
	}
	acc2 := recvAccepted(t, stream2)
	if len(acc2.GetCapabilities()) != 2 {
		t.Fatalf("accepted caps %v", acc2.GetCapabilities())
	}
	// Older hosts with neither capability still work.
	_, proc3, _, cancel3 := openLeaseStream(t, s, sock, "pane-old", CapabilityLifecycle)
	defer cancel3()
	view3, ok := s.PaneState(proc3)
	if !ok || len(view3.Caps) != 1 || view3.Context != nil || view3.Readiness != nil {
		t.Fatalf("legacy view %+v", view3)
	}
}

func TestValidateContextUsage(t *testing.T) {
	if err := validateContextUsage(nil); err != nil {
		t.Fatalf("nil rejected: %v", err)
	}
	valid := []*pibridgepb.ContextUsageSnapshot{
		{Tokens: fptr(0), ContextWindow: fptr(100), Percent: fptr(0)}, // explicit zero stays present
		{ContextWindow: fptr(128000)},                                 // unknown tokens keep a known window
		{Tokens: fptr(maxSafeInteger), ContextWindow: fptr(maxSafeInteger), Percent: fptr(maxSafeInteger)},
		{},
	}
	for i, u := range valid {
		if err := validateContextUsage(u); err != nil {
			t.Fatalf("valid %d rejected: %v", i, err)
		}
	}
	invalid := []*pibridgepb.ContextUsageSnapshot{
		{Tokens: fptr(-1)},
		{Tokens: fptr(math.NaN())},
		{Tokens: fptr(math.Inf(1))},
		{Tokens: fptr(maxSafeInteger + 1)},
		{ContextWindow: fptr(0)},
		{ContextWindow: fptr(-5)},
		{ContextWindow: fptr(math.NaN())},
		{Percent: fptr(50)}, // percent without tokens
		{Tokens: fptr(10), Percent: fptr(-1)},
		{Tokens: fptr(10), Percent: fptr(math.Inf(1))},
	}
	for i, u := range invalid {
		if err := validateContextUsage(u); err == nil {
			t.Fatalf("invalid %d accepted", i)
		}
	}
}

func TestInvalidTelemetryRejectsSnapshot(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-badtele")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	// A hello with invalid telemetry is refused and must not advance
	// the generation or retain anything.
	bad, cancelBad := openStream(t, sock, "pane-badtele", proc, token)
	defer cancelBad()
	hello := compactHello("pane-badtele", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReadiness(),
		&pibridgepb.ContextUsageSnapshot{Tokens: fptr(math.NaN())})
	if err := bad.Send(hello); err != nil {
		t.Fatalf("send: %v", err)
	}
	for {
		_, err := bad.Recv()
		if err != nil {
			break
		}
	}
	// Generation 1 is still free: the refused hello retained nothing.
	good, cancelGood := openStream(t, sock, "pane-badtele", proc, token)
	defer cancelGood()
	if err := good.Send(compactHello("pane-badtele", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReadiness(), nil)); err != nil {
		t.Fatalf("send good: %v", err)
	}
	recvAccepted(t, good)
	view, ok := s.PaneState(proc)
	if !ok || view.Context != nil {
		t.Fatalf("view %+v, want no telemetry after refused hello", view)
	}
	// A live snapshot with invalid telemetry is a protocol error and
	// leaves the retained state untouched.
	invalid := &pibridgepb.PiToPhi{
		PaneId: "pane-badtele", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: &pibridgepb.StateSnapshot{
			State: pibridgepb.LogicalState_LOGICAL_STATE_RUNNING, SessionId: "sess",
			ContextUsage: &pibridgepb.ContextUsageSnapshot{Percent: fptr(10)},
		}},
	}
	if err := good.Send(invalid); err != nil {
		t.Fatalf("send invalid state: %v", err)
	}
	for {
		_, err := good.Recv()
		if err != nil {
			break
		}
	}
	time.Sleep(200 * time.Millisecond)
	view, ok = s.PaneState(proc)
	if !ok || !view.HasState || view.State != pibridgepb.LogicalState_LOGICAL_STATE_IDLE {
		t.Fatalf("retained %+v, want untouched idle baseline", view)
	}
	if view.Context != nil {
		t.Fatalf("retained telemetry %+v, want none", view.Context)
	}
}

func TestTelemetryPropagatesAsCopies(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	type call struct {
		usage     *ContextUsage
		readiness *Readiness
	}
	calls := make(chan call, 8)
	s.SetOnState(func(_, _ string, _, _ uint64, _, _ bool, _, _ string, _ []string, usage *ContextUsage, readiness *Readiness, _ *ReloadReadiness) {
		calls <- call{usage: usage, readiness: readiness}
	})
	proc, token, err := s.RegisterPending("pane-tele")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-tele", proc, token)
	defer cancel()
	hello := compactHello("pane-tele", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE,
		&pibridgepb.CompactReadiness{Idle: true, HasPendingMessages: false, CompactionActive: false, BridgePending: true},
		&pibridgepb.ContextUsageSnapshot{Tokens: fptr(0), ContextWindow: fptr(128000), Percent: fptr(0)})
	if err := stream.Send(hello); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, stream)
	select {
	case c := <-calls:
		if c.usage == nil || !c.usage.HasTokens || c.usage.Tokens != 0 || !c.usage.HasWindow || c.usage.Window != 128000 {
			t.Fatalf("usage %+v, want present zero tokens and window", c.usage)
		}
		if c.readiness == nil || !c.readiness.Idle || !c.readiness.BridgePending {
			t.Fatalf("readiness %+v", c.readiness)
		}
		// Mutating the callback copy must not touch the lease.
		c.usage.Tokens = 999
		c.readiness.Idle = false
	case <-time.After(5 * time.Second):
		t.Fatal("no state callback")
	}
	view, ok := s.PaneState(proc)
	if !ok || view.Context == nil || view.Context.Tokens != 0 || !view.Context.HasTokens {
		t.Fatalf("view %+v, want present zero tokens", view.Context)
	}
	if view.Readiness == nil || !view.Readiness.Idle {
		t.Fatalf("view readiness %+v", view.Readiness)
	}
	view.Context.Tokens = -1
	again, _ := s.PaneState(proc)
	if again.Context.Tokens != 0 {
		t.Fatal("StateView shares mutable telemetry with the lease")
	}
}

func TestRequestCompactRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-c1")
	defer cancel()

	type outcome struct {
		res CompactResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		done <- outcome{res: res, err: err}
	}()
	wire := recvCompactRequest(t, stream)
	if wire.id != "1" {
		t.Fatalf("id %q, want canonical \"1\"", wire.id)
	}
	if wire.session != "sess" || wire.leaf != "leaf" {
		t.Fatalf("expected identity %q/%q, want sess/leaf", wire.session, wire.leaf)
	}
	if wire.model == nil || wire.model.GetProvider() != "p" || wire.model.GetModel() != "m" {
		t.Fatalf("expected model %+v, want p/m", wire.model)
	}
	sendCompactResult(t, stream, "pane-c1", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestCompact: %v", o.err)
		}
		if o.res.RequestID != "1" || o.res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED || o.res.Reason != "" {
			t.Fatalf("result %+v", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestCompact hung")
	}
	// The next operation allocates the next monotonic ID, never reused.
	done2 := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		done2 <- outcome{res: res, err: err}
	}()
	wire2 := recvCompactRequest(t, stream)
	if wire2.id != "2" {
		t.Fatalf("second id %q, want \"2\"", wire2.id)
	}
	sendCompactResult(t, stream, "pane-c1", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire2.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_REFUSED, Reason: "busy",
	})
	select {
	case o := <-done2:
		if o.err != nil {
			t.Fatalf("second RequestCompact: %v", o.err)
		}
		if o.res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_REFUSED || o.res.Reason != "busy" {
			t.Fatalf("result %+v, want refused/busy", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second RequestCompact hung")
	}
}

func TestRequestCompactAbsentModelFence(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-cnomodel")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-cnomodel", proc, token)
	defer cancel()
	hello := compactHello("pane-cnomodel", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReadiness(), nil)
	hello.GetHello().GetCurrentState().Model = nil
	if err := stream.Send(hello); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, stream)
	rev, _ := s.PublicationRevision(proc)
	done := make(chan CompactResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		if err != nil {
			t.Errorf("RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire := recvCompactRequest(t, stream)
	if wire.model != nil {
		t.Fatalf("expected model %+v, want absent (live absence fenced)", wire.model)
	}
	sendCompactResult(t, stream, "pane-cnomodel", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestCompact hung")
	}
}

func compactRefusalReason(t *testing.T, err error) string {
	t.Helper()
	var refusal *CompactRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("err %v, want *CompactRefusal", err)
	}
	return refusal.Reason
}

func TestRequestCompactAdmissionRefusals(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()

	newIdle := func(t *testing.T, pane string) (pibridgepb.Integration_ConnectClient, string, context.CancelFunc, uint64) {
		t.Helper()
		stream, proc, _, cancel, rev := openCompactStream(t, s, sock, pane)
		return stream, proc, cancel, rev
	}

	// Stale generation and revision refuse without invoking the host.
	stream, proc, cancel, rev := newIdle(t, "pane-stale")
	defer cancel()
	if err := func() error { _, err := s.RequestCompact(ctx, proc, 2, rev); return err }(); compactRefusalReason(t, err) != "stale" {
		t.Fatalf("gen mismatch reason %v", err)
	}
	if _, err := s.RequestCompact(ctx, proc, 1, rev+100); compactRefusalReason(t, err) != "stale" {
		t.Fatalf("rev mismatch reason %v", err)
	}
	expectNoCompactRequest(t, stream)

	// A running snapshot refuses busy.
	proc2, token2, err := s.RegisterPending("pane-running")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc2)
	stream2, cancel2 := openStream(t, sock, "pane-running", proc2, token2)
	defer cancel2()
	if err := stream2.Send(compactHello("pane-running", proc2, 1, pibridgepb.LogicalState_LOGICAL_STATE_RUNNING, idleReadiness(), nil)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, stream2)
	rev2, _ := s.PublicationRevision(proc2)
	if _, err := s.RequestCompact(ctx, proc2, 1, rev2); compactRefusalReason(t, err) != "busy" {
		t.Fatalf("running reason %v", err)
	}
	expectNoCompactRequest(t, stream2)

	// Readiness fences refuse with their own reasons.
	readinessCases := []struct {
		name   string
		ready  *pibridgepb.CompactReadiness
		reason string
	}{
		{"not-idle", &pibridgepb.CompactReadiness{Idle: false}, "busy"},
		{"queued", &pibridgepb.CompactReadiness{Idle: true, HasPendingMessages: true}, "queued"},
		{"active", &pibridgepb.CompactReadiness{Idle: true, CompactionActive: true}, "compaction-active"},
		{"bridge-pending", &pibridgepb.CompactReadiness{Idle: true, BridgePending: true}, "pending"},
		{"absent", nil, "busy"},
	}
	for _, c := range readinessCases {
		pane := "pane-ready-" + c.name
		pp, tok, err := s.RegisterPending(pane)
		if err != nil {
			t.Fatalf("register: %v", err)
		}
		s.Complete(pp)
		st, cancelSt := openStream(t, sock, pane, pp, tok)
		defer cancelSt()
		if err := st.Send(compactHello(pane, pp, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, c.ready, nil)); err != nil {
			t.Fatalf("send %s: %v", c.name, err)
		}
		recvAccepted(t, st)
		rr, _ := s.PublicationRevision(pp)
		if _, err := s.RequestCompact(ctx, pp, 1, rr); compactRefusalReason(t, err) != c.reason {
			t.Fatalf("%s reason %v, want %s", c.name, err, c.reason)
		}
		expectNoCompactRequest(t, st)
	}

	// No snapshot at all refuses stale.
	pp, tok, err := s.RegisterPending("pane-nostate")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(pp)
	st, cancelSt := openStream(t, sock, "pane-nostate", pp, tok)
	defer cancelSt()
	hello := testHello("pane-nostate", pp, 1, CapabilityLifecycle, CapabilityCompact)
	hello.GetHello().CurrentState = nil
	if err := st.Send(hello); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, st)
	rr, _ := s.PublicationRevision(pp)
	if _, err := s.RequestCompact(ctx, pp, 1, rr); compactRefusalReason(t, err) != "stale" {
		t.Fatalf("no-state reason %v", err)
	}
	expectNoCompactRequest(t, st)

	// Single-flight: a second caller refuses pending while one runs.
	stream3, proc3, cancel3, rev3 := newIdle(t, "pane-flight")
	defer cancel3()
	first := make(chan error, 1)
	go func() {
		c, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestCompact(c, proc3, 1, rev3)
		first <- err
	}()
	wire := recvCompactRequest(t, stream3)
	if _, err := s.RequestCompact(ctx, proc3, 1, rev3); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("single-flight reason %v", err)
	}
	sendCompactResult(t, stream3, "pane-flight", proc3, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case err := <-first:
		if err != nil {
			t.Fatalf("first: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first hung")
	}
}

func TestRequestCompactUnavailable(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()

	if _, err := s.RequestCompact(ctx, "nope", 1, 1); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("unknown process err %v", err)
	}
	// Peerless lease fails fast.
	proc, _, err := s.RegisterPending("pane-np")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	if _, err := s.RequestCompact(ctx, proc, 1, 1); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("peerless err %v", err)
	}
	// Unnegotiated capability never dispatches.
	_, proc2, _, cancel2 := openLeaseStream(t, s, sock, "pane-nocap", CapabilityLifecycle, CapabilityContext)
	defer cancel2()
	rev2, _ := s.PublicationRevision(proc2)
	if _, err := s.RequestCompact(ctx, proc2, 1, rev2); err == nil || !strings.Contains(err.Error(), "capability") {
		t.Fatalf("no-cap err %v", err)
	}
}

func TestRequestCompactFailedCancelledUncertain(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-cfail")
	defer cancel()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()

	round := func(outcome pibridgepb.CompactOutcome, reason string) CompactResult {
		t.Helper()
		done := make(chan CompactResult, 1)
		go func() {
			res, err := s.RequestCompact(ctx, proc, 1, rev)
			if err != nil {
				t.Errorf("RequestCompact: %v", err)
				return
			}
			done <- res
		}()
		wire := recvCompactRequest(t, stream)
		sendCompactResult(t, stream, "pane-cfail", proc, 1, &pibridgepb.CompactResult{
			RequestId: wire.id, Outcome: outcome, Reason: reason,
		})
		select {
		case res := <-done:
			return res
		case <-time.After(5 * time.Second):
			t.Fatal("RequestCompact hung")
			return CompactResult{}
		}
	}

	if res := round(pibridgepb.CompactOutcome_COMPACT_OUTCOME_FAILED, "error"); res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_FAILED || res.Reason != "error" {
		t.Fatalf("failed %+v", res)
	}
	if res := round(pibridgepb.CompactOutcome_COMPACT_OUTCOME_CANCELLED, "cancelled"); res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_CANCELLED || res.Reason != "cancelled" {
		t.Fatalf("cancelled %+v", res)
	}
	// Host-reported uncertainty reaches the waiter but retains the
	// process record: later callers see pending, not a fresh dispatch.
	if res := round(pibridgepb.CompactOutcome_COMPACT_OUTCOME_UNSPECIFIED, "uncertain"); res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_UNSPECIFIED || res.Reason != "uncertain" {
		t.Fatalf("uncertain %+v", res)
	}
	if _, err := s.RequestCompact(ctx, proc, 1, rev); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("post-uncertain reason %v", err)
	}
	expectNoCompactRequest(t, stream)
}

func TestRequestCompactIgnoresStrayResults(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-cstray")
	defer cancel()

	done := make(chan CompactResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		if err != nil {
			t.Errorf("RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire := recvCompactRequest(t, stream)
	// Unsolicited, empty, and unknown-outcome results never satisfy.
	sendCompactResult(t, stream, "pane-cstray", proc, 1, &pibridgepb.CompactResult{
		RequestId: "9999", Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	sendCompactResult(t, stream, "pane-cstray", proc, 1, &pibridgepb.CompactResult{
		Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	sendCompactResult(t, stream, "pane-cstray", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome(99),
	})
	// Unknown reasons coerce to empty on the matching result.
	sendCompactResult(t, stream, "pane-cstray", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_FAILED, Reason: "<script>",
	})
	select {
	case res := <-done:
		if res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_FAILED || res.Reason != "" {
			t.Fatalf("result %+v, want failed with coerced reason", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestCompact hung")
	}
	// A duplicate of the consumed id is dropped, not redelivered: the
	// next operation dispatches cleanly with a fresh ID.
	sendCompactResult(t, stream, "pane-cstray", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	time.Sleep(100 * time.Millisecond)
	done2 := make(chan CompactResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		if err != nil {
			t.Errorf("second RequestCompact: %v", err)
			return
		}
		done2 <- res
	}()
	wire2 := recvCompactRequest(t, stream)
	if wire2.id == wire.id {
		t.Fatal("request id reused")
	}
	sendCompactResult(t, stream, "pane-cstray", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire2.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done2:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second RequestCompact hung")
	}
}

func TestRequestCompactTimeoutKeepsOperation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-ctimeout")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer stop()
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	wire := recvCompactRequest(t, stream)
	select {
	case err := <-errCh:
		var unknown *CompactUnknown
		if !errors.As(err, &unknown) || unknown.RequestID != wire.id {
			t.Fatalf("err %v, want CompactUnknown for %s", err, wire.id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestCompact hung")
	}
	// The waiter left but the operation stays unresolved: no replay.
	// (No negative Recv check here: an abandoned Recv would race the
	// redispatch Recv below. Consecutive IDs prove no phantom
	// dispatch consumed an allocation instead.)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestCompact(ctx, proc, 1, rev); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("post-timeout reason %v", err)
	}
	// The late host result releases the operation but satisfies no
	// replacement caller: the next dispatch carries a fresh ID.
	sendCompactResult(t, stream, "pane-ctimeout", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	time.Sleep(200 * time.Millisecond)
	done := make(chan CompactResult, 1)
	go func() {
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		if err != nil {
			t.Errorf("next RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvCompactRequest(t, stream)
	if wire2.id != "2" {
		t.Fatalf("second id %q, want consecutive \"2\" (no phantom dispatch)", wire2.id)
	}
	sendCompactResult(t, stream, "pane-ctimeout", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire2.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v, want fresh operation", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("next RequestCompact hung")
	}
}

func TestRequestCompactPeerLossKeepsOperation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel, rev := openCompactStream(t, s, sock, "pane-closs")

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	wire := recvCompactRequest(t, stream)
	cancel() // drop only the bridge stream, not the process
	select {
	case err := <-errCh:
		var unknown *CompactUnknown
		if !errors.As(err, &unknown) || unknown.RequestID != wire.id {
			t.Fatalf("err %v, want CompactUnknown for %s", err, wire.id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after peer loss")
	}
	// Same-generation reconnect keeps the unresolved operation; its
	// late result on the new stream releases it.
	stream2, cancel2 := openStream(t, sock, "pane-closs", proc, token)
	defer cancel2()
	if err := stream2.Send(compactHello("pane-closs", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReadiness(), nil)); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	recvAccepted(t, stream2)
	rev2, _ := s.PublicationRevision(proc)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestCompact(ctx, proc, 1, rev2); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("post-loss reason %v", err)
	}
	sendCompactResult(t, stream2, "pane-closs", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	time.Sleep(200 * time.Millisecond)
	done := make(chan CompactResult, 1)
	go func() {
		res, err := s.RequestCompact(ctx, proc, 1, rev2)
		if err != nil {
			t.Errorf("next RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvCompactRequest(t, stream2)
	if wire2.id == wire.id {
		t.Fatal("request id reused after peer-loss release")
	}
	sendCompactResult(t, stream2, "pane-closs", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire2.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v, want fresh operation", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("next RequestCompact hung")
	}
	_ = stream
}

func TestRequestCompactReplacementClearsOperation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel, _ := openCompactStream(t, s, sock, "pane-creplace")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		rev, _ := s.PublicationRevision(proc)
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	wire := recvCompactRequest(t, stream)
	// A new runtime generation clears the old operation; the waiter
	// reports unknown, never a stale satisfaction.
	stream2, cancel2 := openStream(t, sock, "pane-creplace", proc, token)
	defer cancel2()
	hello2 := compactHello("pane-creplace", proc, 2, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReadiness(), nil)
	hello2.GetHello().RuntimeId = "rt2"
	hello2.GetHello().SessionId = "sess2"
	hello2.GetHello().GetCurrentState().SessionId = "sess2"
	if err := stream2.Send(hello2); err != nil {
		t.Fatalf("hello2: %v", err)
	}
	recvAccepted(t, stream2)
	select {
	case err := <-errCh:
		var unknown *CompactUnknown
		if !errors.As(err, &unknown) || unknown.RequestID != wire.id {
			t.Fatalf("err %v, want CompactUnknown for %s", err, wire.id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after replacement")
	}
	// An old-generation result cannot clear a different operation.
	sendCompactResult(t, stream2, "pane-creplace", proc, 2, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	time.Sleep(200 * time.Millisecond)
	// The new generation admits a fresh operation under its stamps.
	rev2, _ := s.PublicationRevision(proc)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	done := make(chan CompactResult, 1)
	go func() {
		res, err := s.RequestCompact(ctx, proc, 2, rev2)
		if err != nil {
			t.Errorf("gen2 RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvCompactRequest(t, stream2)
	if wire2.id == wire.id {
		t.Fatal("request id reused across generations")
	}
	if wire2.session != "sess2" {
		t.Fatalf("expected session %q, want sess2", wire2.session)
	}
	sendCompactResult(t, stream2, "pane-creplace", proc, 2, &pibridgepb.CompactResult{
		RequestId: wire2.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("gen2 RequestCompact hung")
	}
}

func TestRequestCompactSendMissReleasesRecord(t *testing.T) {
	s := NewServer()
	proc, _, err := s.RegisterPending("pane-queue")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	l, ok := s.reg.lookupByProcess(proc)
	if !ok {
		t.Fatal("lease missing")
	}
	// A writer-blocked peer with a full queue: admission succeeds
	// but the bounded send misses.
	bs := newBlockingStream()
	p := newPeer(1, "sess", bs)
	l.mu.Lock()
	l.maxGen, l.runtimeID, l.sessionID = 1, "rt", "sess"
	l.peer = p
	l.caps = []string{CapabilityCompact, CapabilityLifecycle}
	l.lastState = &pibridgepb.StateSnapshot{
		State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess", LeafId: "leaf",
		Model:            &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
		CompactReadiness: &pibridgepb.CompactReadiness{Idle: true},
	}
	l.pubRev = 7
	l.mu.Unlock()
	for i := 0; i < maxQueuedMessages; i++ {
		if !p.sendNonfatal(acceptedMsg(4)) {
			t.Fatalf("fill %d rejected early", i)
		}
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestCompact(ctx, proc, 1, 7); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("err %v, want unavailable send miss", err)
	}
	// Never dispatched means no retained operation: the next caller
	// is fenced by the queue again, not by a phantom pending op.
	l.mu.Lock()
	stuck := l.compact != nil
	l.mu.Unlock()
	if stuck {
		t.Fatal("send miss retained a phantom operation")
	}
}

func TestRequestCompactRevokeReleasesOperation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-crevoke")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	wire := recvCompactRequest(t, stream)
	_ = wire
	s.Revoke(proc)
	select {
	case err := <-errCh:
		var unknown *CompactUnknown
		if !errors.As(err, &unknown) {
			t.Fatalf("err %v, want CompactUnknown", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after revoke")
	}
}

// sendLiveSnapshot publishes one authoritative live state snapshot on an
// open stream.
func sendLiveSnapshot(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, gen uint64, snap *pibridgepb.StateSnapshot) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: snap},
	}); err != nil {
		t.Fatalf("send snapshot: %v", err)
	}
}

func idleSnapshotWithReadiness(session, leaf string, rev uint64, ready *pibridgepb.CompactReadiness) *pibridgepb.StateSnapshot {
	return &pibridgepb.StateSnapshot{
		State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: session, LeafId: leaf,
		Model:            &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
		StateRevision:    rev,
		CompactReadiness: ready,
	}
}

func compactResultMsg(id string, outcome pibridgepb.CompactOutcome, reason string) *pibridgepb.PiToPhi {
	return &pibridgepb.PiToPhi{
		Payload: &pibridgepb.PiToPhi_CompactResult{CompactResult: &pibridgepb.CompactResult{
			RequestId: id, Outcome: outcome, Reason: reason,
		}},
	}
}

func TestDeliverCompactRejectsStalePeer(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-c1stale")
	defer cancel()

	errCh := make(chan error, 1)
	resCh := make(chan CompactResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		if err != nil {
			errCh <- err
			return
		}
		resCh <- res
	}()
	wire := recvCompactRequest(t, stream)
	l, _ := s.reg.lookupByProcess(proc)
	l.mu.Lock()
	op := l.compact
	l.mu.Unlock()
	if op == nil {
		t.Fatal("no operation installed")
	}
	// An obsolete same-generation peer delivers the matching id: it
	// must neither satisfy the waiter nor release process work.
	stale := newPeer(1, "sess", newBlockingStream())
	if err := s.handleMessage(l, stale, compactResultMsg(wire.id, pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED, "")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	select {
	case res := <-op.ch:
		t.Fatalf("stale peer satisfied the waiter: %+v", res)
	default:
	}
	l.mu.Lock()
	kept, waiter := l.compact == op, op.waiter
	l.mu.Unlock()
	if !kept || !waiter {
		t.Fatal("stale peer disturbed the unresolved operation")
	}
	// The legitimate answer on the live stream still completes.
	sendCompactResult(t, stream, "pane-c1stale", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-resCh:
		if res.RequestID != wire.id {
			t.Fatalf("result %+v", res)
		}
	case err := <-errCh:
		t.Fatalf("RequestCompact: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("RequestCompact hung")
	}
}

func TestDeliverCompactRejectsOlderGeneration(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-c1oldgen")
	defer cancel()

	done := make(chan CompactResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		if err != nil {
			t.Errorf("RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire := recvCompactRequest(t, stream)
	l, _ := s.reg.lookupByProcess(proc)
	l.mu.Lock()
	live := l.peer
	op := l.compact
	// Simulate a behind-generation stream: the lease moved on but
	// this stream did not. Its matching result must drop.
	l.maxGen = 2
	l.mu.Unlock()
	if err := s.handleMessage(l, live, compactResultMsg(wire.id, pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED, "")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	select {
	case res := <-op.ch:
		t.Fatalf("older-generation stream satisfied the waiter: %+v", res)
	default:
	}
	l.mu.Lock()
	kept := l.compact == op
	l.maxGen = 1
	l.mu.Unlock()
	if !kept {
		t.Fatal("older-generation stream released process work")
	}
	sendCompactResult(t, stream, "pane-c1oldgen", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire.id {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestCompact hung")
	}
}

// gateContext wraps a context and blocks its second Err call until
// released. RequestCompact calls Err once at entry and once after
// consuming a queued result, so the gate pins waiter consumption:
// the test swaps the peer only after the waiter signals it has the
// result in hand, making replacement strictly precede consumption
// without sleeps or production hooks.
type gateContext struct {
	context.Context
	mu       sync.Mutex
	calls    int
	consumed chan struct{}
	release  chan struct{}
}

func newGateContext(parent context.Context) *gateContext {
	return &gateContext{Context: parent, consumed: make(chan struct{}), release: make(chan struct{})}
}

func (g *gateContext) Err() error {
	g.mu.Lock()
	g.calls++
	second := g.calls == 2
	g.mu.Unlock()
	if !second {
		return g.Context.Err()
	}
	close(g.consumed)
	<-g.release
	return g.Context.Err()
}

func TestRequestCompactReplacementBetweenDeliveryAndConsumption(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, _ := openCompactStream(t, s, sock, "pane-c1race")
	defer cancel()
	l, _ := s.reg.lookupByProcess(proc)

	// Each iteration delivers the terminal result, then replaces the
	// dispatch peer while the waiter is gated inside consumption:
	// replacement strictly precedes the currency check, so the
	// waiter reports unknown every time while the matching
	// operation itself resolves and the next dispatch proceeds. A
	// missing waiter fence returns COMPLETED instead.
	for i := 0; i < 5; i++ {
		rev, _ := s.PublicationRevision(proc)
		parent, stop := context.WithTimeout(context.Background(), 5*time.Second)
		gated := newGateContext(parent)
		errCh := make(chan error, 1)
		go func() {
			_, err := s.RequestCompact(gated, proc, 1, rev)
			errCh <- err
		}()
		wire := recvCompactRequest(t, stream)
		l.mu.Lock()
		dispatchPeer := l.peer
		l.mu.Unlock()
		if err := s.handleMessage(l, dispatchPeer, compactResultMsg(wire.id, pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED, "")); err != nil {
			stop()
			t.Fatalf("iter %d deliver: %v", i, err)
		}
		// The waiter has the result and is gated: swap first,
		// then let consumption proceed.
		select {
		case <-gated.consumed:
		case <-time.After(5 * time.Second):
			stop()
			t.Fatalf("iter %d waiter never consumed", i)
		}
		l.mu.Lock()
		l.peer = newPeer(1, "sess", newBlockingStream())
		l.mu.Unlock()
		close(gated.release)
		select {
		case err := <-errCh:
			var unknown *CompactUnknown
			if !errors.As(err, &unknown) || unknown.RequestID != wire.id {
				t.Fatalf("iter %d err %v, want CompactUnknown for %s", i, err, wire.id)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("iter %d waiter hung", i)
		}
		stop()
		l.mu.Lock()
		if l.compact != nil {
			l.mu.Unlock()
			t.Fatalf("iter %d left the operation unresolved", i)
		}
		l.peer = dispatchPeer
		l.mu.Unlock()
	}
}

func TestRequestCompactReadinessReleaseRetiresAfterTimeout(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-c2rec")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer stop()
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	wire := recvCompactRequest(t, stream)
	_ = wire
	// The host publishes its pending frame post-invocation; the
	// terminal result is then lost and the waiter expires.
	sendLiveSnapshot(t, stream, "pane-c2rec", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 2,
		&pibridgepb.CompactReadiness{Idle: true, BridgePending: true}))
	time.Sleep(200 * time.Millisecond)
	select {
	case err := <-errCh:
		var unknown *CompactUnknown
		if !errors.As(err, &unknown) {
			t.Fatalf("err %v, want CompactUnknown", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung")
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	rev2, _ := s.PublicationRevision(proc)
	if _, err := s.RequestCompact(ctx, proc, 1, rev2); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("pre-release reason %v, want pending", err)
	}
	// The authoritative released frame retires the operation without
	// synthesizing any result: the next dispatch proceeds cleanly.
	sendLiveSnapshot(t, stream, "pane-c2rec", proc, 1, idleSnapshotWithReadiness("sess", "leaf-after", 3, idleReadiness()))
	time.Sleep(200 * time.Millisecond)
	done := make(chan CompactResult, 1)
	go func() {
		rev3, _ := s.PublicationRevision(proc)
		res, err := s.RequestCompact(ctx, proc, 1, rev3)
		if err != nil {
			t.Errorf("next RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvCompactRequest(t, stream)
	if wire2.id != "2" {
		t.Fatalf("second id %q, want consecutive \"2\"", wire2.id)
	}
	sendCompactResult(t, stream, "pane-c2rec", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire2.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("next RequestCompact hung")
	}
}

func TestRequestCompactReadinessReleaseDefersWhileWaiterAttached(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-c2defer")
	defer cancel()

	done := make(chan CompactResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		if err != nil {
			t.Errorf("RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire := recvCompactRequest(t, stream)
	sendLiveSnapshot(t, stream, "pane-c2defer", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 2,
		&pibridgepb.CompactReadiness{Idle: true, BridgePending: true}))
	time.Sleep(200 * time.Millisecond)
	// The released frame lands while the waiter is still attached:
	// the operation stays until the waiter leaves, so the in-flight
	// terminal result still reaches it instead of being dropped.
	sendLiveSnapshot(t, stream, "pane-c2defer", proc, 1, idleSnapshotWithReadiness("sess", "leaf-after", 3, idleReadiness()))
	time.Sleep(200 * time.Millisecond)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	rev2, _ := s.PublicationRevision(proc)
	if _, err := s.RequestCompact(ctx, proc, 1, rev2); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("attached reason %v, want pending", err)
	}
	sendCompactResult(t, stream, "pane-c2defer", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire.id || res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED {
			t.Fatalf("result %+v, want the true terminal result", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung")
	}
}

func TestRequestCompactStaleReadinessNeverRetires(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel, rev := openCompactStream(t, s, sock, "pane-c2stale")
	defer cancel()
	l, _ := s.reg.lookupByProcess(proc)

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer stop()
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	recvCompactRequest(t, stream)
	sendLiveSnapshot(t, stream, "pane-c2stale", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 2,
		&pibridgepb.CompactReadiness{Idle: true, BridgePending: true}))
	time.Sleep(200 * time.Millisecond)
	select {
	case <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung")
	}
	// Same-generation reconnect without a snapshot republishes the
	// retained pending baseline: no new evidence, no retirement.
	l.mu.Lock()
	origPeer := l.peer
	l.mu.Unlock()
	stream2, cancel2 := openStream(t, sock, "pane-c2stale", proc, token)
	defer cancel2()
	hello := testHello("pane-c2stale", proc, 1, CapabilityLifecycle, CapabilityCompact)
	hello.GetHello().CurrentState = nil
	if err := stream2.Send(hello); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	recvAccepted(t, stream2)
	// A released frame from the obsolete peer is dropped before any
	// reconciliation: stale streams never clear process work.
	released := &pibridgepb.PiToPhi{
		Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: idleSnapshotWithReadiness("sess", "leaf-after", 3, idleReadiness())},
	}
	if err := s.handleMessage(l, origPeer, released); err != nil {
		t.Fatalf("stale handleMessage: %v", err)
	}
	l.mu.Lock()
	kept := l.compact != nil
	l.mu.Unlock()
	if !kept {
		t.Fatal("stale readiness retired the operation")
	}
	// Positive control: the same frame on the live stream retires.
	sendLiveSnapshot(t, stream2, "pane-c2stale", proc, 1, idleSnapshotWithReadiness("sess", "leaf-after", 3, idleReadiness()))
	time.Sleep(200 * time.Millisecond)
	l.mu.Lock()
	retired := l.compact == nil
	l.mu.Unlock()
	if !retired {
		t.Fatal("live released frame did not retire the operation")
	}
}

func TestRequestCompactPreDispatchSnapshotNeverRetires(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-c2pre")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer stop()
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	recvCompactRequest(t, stream)
	// A released frame with no observed pending frame first (as
	// sampled before dispatch) is not release evidence.
	sendLiveSnapshot(t, stream, "pane-c2pre", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 2, idleReadiness()))
	time.Sleep(200 * time.Millisecond)
	select {
	case <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung")
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	rev2, _ := s.PublicationRevision(proc)
	if _, err := s.RequestCompact(ctx, proc, 1, rev2); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("reason %v, want retained pending", err)
	}
}

func TestRequestCompactNewGenProtectedByBridgePending(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel, _ := openCompactStream(t, s, sock, "pane-c2gen")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		rev, _ := s.PublicationRevision(proc)
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	wire := recvCompactRequest(t, stream)
	_ = wire
	// The new runtime still holds the process latch: the fresh
	// generation clears broker request state, but admission stays
	// fenced by the authoritative pending readiness.
	stream2, cancel2 := openStream(t, sock, "pane-c2gen", proc, token)
	defer cancel2()
	hello2 := compactHello("pane-c2gen", proc, 2, pibridgepb.LogicalState_LOGICAL_STATE_IDLE,
		&pibridgepb.CompactReadiness{Idle: true, BridgePending: true}, nil)
	hello2.GetHello().RuntimeId = "rt2"
	hello2.GetHello().SessionId = "sess2"
	hello2.GetHello().GetCurrentState().SessionId = "sess2"
	if err := stream2.Send(hello2); err != nil {
		t.Fatalf("hello2: %v", err)
	}
	recvAccepted(t, stream2)
	select {
	case err := <-errCh:
		var unknown *CompactUnknown
		if !errors.As(err, &unknown) {
			t.Fatalf("err %v, want CompactUnknown", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after replacement")
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	rev2, _ := s.PublicationRevision(proc)
	if _, err := s.RequestCompact(ctx, proc, 2, rev2); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("gen2 reason %v, want pending", err)
	}
	// Once the runtime publishes release, the new generation admits.
	sendLiveSnapshot(t, stream2, "pane-c2gen", proc, 2, idleSnapshotWithReadiness("sess2", "leaf", 2, idleReadiness()))
	time.Sleep(200 * time.Millisecond)
	rev3, _ := s.PublicationRevision(proc)
	done := make(chan CompactResult, 1)
	go func() {
		res, err := s.RequestCompact(ctx, proc, 2, rev3)
		if err != nil {
			t.Errorf("gen2 RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvCompactRequest(t, stream2)
	if wire2.id != "2" {
		t.Fatalf("gen2 id %q, want consecutive \"2\"", wire2.id)
	}
	sendCompactResult(t, stream2, "pane-c2gen", proc, 2, &pibridgepb.CompactResult{
		RequestId: wire2.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("gen2 RequestCompact hung")
	}
}

func TestAllocCompactIDBoundaryAndConcurrent(t *testing.T) {
	s := NewServer()
	s.compactSeq.Store(math.MaxUint64 - 1)
	id, ok := s.allocCompactID()
	if !ok || id != math.MaxUint64 {
		t.Fatalf("boundary id %d ok %v, want MaxUint64", id, ok)
	}
	for i := 0; i < 2; i++ {
		if id, ok := s.allocCompactID(); ok || id != 0 {
			t.Fatalf("exhausted alloc %d yielded %d ok %v", i, id, ok)
		}
	}
	// Concurrent allocation yields unique positive IDs, never zero.
	fresh := NewServer()
	const workers, perWorker = 8, 250
	ids := make(chan uint64, workers*perWorker)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				id, ok := fresh.allocCompactID()
				if !ok || id == 0 {
					t.Errorf("alloc yielded %d ok %v", id, ok)
					return
				}
				ids <- id
			}
		}()
	}
	wg.Wait()
	close(ids)
	seen := map[uint64]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatalf("duplicate id %d", id)
		}
		seen[id] = true
	}
	if len(seen) != workers*perWorker {
		t.Fatalf("%d unique ids, want %d", len(seen), workers*perWorker)
	}
	if n := fresh.compactSeq.Load(); n != workers*perWorker {
		t.Fatalf("counter %d, want %d", n, workers*perWorker)
	}
}

func TestRequestCompactMissingReadinessNeverReleasesAttached(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-c2unk")
	defer cancel()

	done := make(chan CompactResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestCompact(ctx, proc, 1, rev)
		if err != nil {
			t.Errorf("RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire := recvCompactRequest(t, stream)
	sendLiveSnapshot(t, stream, "pane-c2unk", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 2,
		&pibridgepb.CompactReadiness{Idle: true, BridgePending: true}))
	time.Sleep(200 * time.Millisecond)
	// Absent readiness is unknown, never termination: the operation
	// stays, the pending evidence stays, and the in-flight terminal
	// result still reaches the attached waiter.
	sendLiveSnapshot(t, stream, "pane-c2unk", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 3, nil))
	time.Sleep(200 * time.Millisecond)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	rev2, _ := s.PublicationRevision(proc)
	if _, err := s.RequestCompact(ctx, proc, 1, rev2); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("unknown-sample reason %v, want pending", err)
	}
	sendCompactResult(t, stream, "pane-c2unk", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire.id || res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED {
			t.Fatalf("result %+v, want the true terminal result", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung")
	}
}

func TestRequestCompactUnknownThenExpiryStaysUnresolved(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openCompactStream(t, s, sock, "pane-c2unkexp")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer stop()
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	recvCompactRequest(t, stream)
	sendLiveSnapshot(t, stream, "pane-c2unkexp", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 2,
		&pibridgepb.CompactReadiness{Idle: true, BridgePending: true}))
	time.Sleep(200 * time.Millisecond)
	// Pending, then unknown, then expiry: no explicit release was
	// ever observed, so the operation stays unresolved.
	sendLiveSnapshot(t, stream, "pane-c2unkexp", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 3, nil))
	time.Sleep(200 * time.Millisecond)
	select {
	case err := <-errCh:
		var unknown *CompactUnknown
		if !errors.As(err, &unknown) {
			t.Fatalf("err %v, want CompactUnknown", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung")
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	rev2, _ := s.PublicationRevision(proc)
	if _, err := s.RequestCompact(ctx, proc, 1, rev2); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("reason %v, want retained pending", err)
	}
}

func TestRequestCompactUnknownBaselineThenExplicitRelease(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel, rev := openCompactStream(t, s, sock, "pane-c2base")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer stop()
		_, err := s.RequestCompact(ctx, proc, 1, rev)
		errCh <- err
	}()
	wire := recvCompactRequest(t, stream)
	_ = wire
	sendLiveSnapshot(t, stream, "pane-c2base", proc, 1, idleSnapshotWithReadiness("sess", "leaf", 2,
		&pibridgepb.CompactReadiness{Idle: true, BridgePending: true}))
	time.Sleep(200 * time.Millisecond)
	select {
	case <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung")
	}
	// A same-generation reconnect baseline without readiness is
	// unknown: no retirement, and the pending evidence survives the
	// overwrite for the later real release.
	stream2, cancel2 := openStream(t, sock, "pane-c2base", proc, token)
	defer cancel2()
	helloUnknown := compactHello("pane-c2base", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, nil, nil)
	helloUnknown.GetHello().GetCurrentState().CompactReadiness = nil
	if err := stream2.Send(helloUnknown); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	recvAccepted(t, stream2)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	rev2, _ := s.PublicationRevision(proc)
	if _, err := s.RequestCompact(ctx, proc, 1, rev2); compactRefusalReason(t, err) != "pending" {
		t.Fatalf("unknown-baseline reason %v, want pending", err)
	}
	// An explicit release baseline on a further reconnect retires
	// the operation without any resend of the lost result.
	stream3, cancel3 := openStream(t, sock, "pane-c2base", proc, token)
	defer cancel3()
	if err := stream3.Send(compactHello("pane-c2base", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReadiness(), nil)); err != nil {
		t.Fatalf("reconnect2: %v", err)
	}
	recvAccepted(t, stream3)
	rev3, _ := s.PublicationRevision(proc)
	done := make(chan CompactResult, 1)
	go func() {
		res, err := s.RequestCompact(ctx, proc, 1, rev3)
		if err != nil {
			t.Errorf("next RequestCompact: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvCompactRequest(t, stream3)
	if wire2.id != "2" {
		t.Fatalf("second id %q, want consecutive \"2\"", wire2.id)
	}
	sendCompactResult(t, stream3, "pane-c2base", proc, 1, &pibridgepb.CompactResult{
		RequestId: wire2.id, Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("next RequestCompact hung")
	}
}
