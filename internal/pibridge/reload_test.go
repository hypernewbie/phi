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

func uptr(u uint64) *uint64 { return &u }

func idleReloadReadiness() *pibridgepb.ReloadReadiness {
	return &pibridgepb.ReloadReadiness{RunId: uptr(0), ContextRevision: uptr(0), Idle: true}
}

func reloadHello(pane, proc string, gen uint64, state pibridgepb.LogicalState, ready *pibridgepb.ReloadReadiness) *pibridgepb.PiToPhi {
	return &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PiToPhi_Hello{
			Hello: &pibridgepb.Hello{
				ProtocolVersion: ProtocolVersion,
				SessionId:       "sess", RuntimeId: "rt",
				Capabilities: []string{CapabilityLifecycle, CapabilityContext, CapabilityCompact, CapabilityReload},
				CurrentState: &pibridgepb.StateSnapshot{
					State:     state,
					SessionId: "sess", LeafId: "leaf",
					Model:            &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
					CompactReadiness: &pibridgepb.CompactReadiness{Idle: true},
					ReloadReadiness:  ready,
				},
			},
		},
	}
}

// openReloadStream registers a lease and opens an accepted idle stream
// with reload capability. It returns the stream, process ID, token,
// cancel, and the live publication revision for stamps.
func openReloadStream(t *testing.T, s *Server, sock, pane string) (pibridgepb.Integration_ConnectClient, string, string, context.CancelFunc, uint64) {
	t.Helper()
	proc, token, err := s.RegisterPending(pane)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, pane, proc, token)
	if err := stream.Send(reloadHello(pane, proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReloadReadiness())); err != nil {
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

type reloadWireRequest struct {
	id              string
	session, leaf   string
	model           *pibridgepb.ModelSnapshot
	run, contextRev uint64
	hasCounters     bool
}

func recvReloadRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) reloadWireRequest {
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
		req := r.msg.GetReloadRequest()
		if req == nil {
			t.Fatalf("not a reload request: %v", r.msg.GetPayload())
		}
		out := reloadWireRequest{
			id: req.GetRequestId(), session: req.GetExpectedSessionId(),
			leaf: req.GetExpectedLeafId(), model: req.GetExpectedModel(),
		}
		if req.ExpectedRunId != nil && req.ExpectedContextRevision != nil {
			out.run, out.contextRev = *req.ExpectedRunId, *req.ExpectedContextRevision
			out.hasCounters = true
		}
		return out
	case <-ctx.Done():
		t.Fatalf("timed out waiting for reload request")
		return reloadWireRequest{}
	}
}

func sendReloadAck(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, gen uint64, res *pibridgepb.ReloadAck) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PiToPhi_ReloadAck{ReloadAck: res},
	}); err != nil {
		t.Fatalf("send ack: %v", err)
	}
}

func sendReloadSnapshot(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, gen uint64, snap *pibridgepb.StateSnapshot) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: snap},
	}); err != nil {
		t.Fatalf("send snapshot: %v", err)
	}
}

func idleSnapshotWithReload(session, leaf string, rev uint64, ready *pibridgepb.ReloadReadiness) *pibridgepb.StateSnapshot {
	return &pibridgepb.StateSnapshot{
		State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: session, LeafId: leaf,
		Model:            &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
		StateRevision:    rev,
		CompactReadiness: &pibridgepb.CompactReadiness{Idle: true},
		ReloadReadiness:  ready,
	}
}

func releaseReloadSnapshot(highWater uint64) *pibridgepb.StateSnapshot {
	return idleSnapshotWithReload("sess", "leaf", 3, &pibridgepb.ReloadReadiness{
		RunId: uptr(0), ContextRevision: uptr(0), Idle: true, HighWater: uptr(highWater),
	})
}

func reloadAckMsg(id string, outcome pibridgepb.ReloadDispatchOutcome, reason string) *pibridgepb.PiToPhi {
	return &pibridgepb.PiToPhi{
		Payload: &pibridgepb.PiToPhi_ReloadAck{ReloadAck: &pibridgepb.ReloadAck{
			RequestId: id, Outcome: outcome, Reason: reason,
		}},
	}
}

func reloadRefusalReason(t *testing.T, err error) string {
	t.Helper()
	var refusal *ReloadRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("err %v, want *ReloadRefusal", err)
	}
	return refusal.Reason
}

func reloadUnknownID(t *testing.T, err error) string {
	t.Helper()
	var unknown *ReloadUnknown
	if !errors.As(err, &unknown) {
		t.Fatalf("err %v, want *ReloadUnknown", err)
	}
	return unknown.RequestID
}

func TestRequestReloadRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openReloadStream(t, s, sock, "pane-r1")
	defer cancel()

	type outcome struct {
		res ReloadResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
		done <- outcome{res: res, err: err}
	}()
	wire := recvReloadRequest(t, stream)
	if wire.id != "1" {
		t.Fatalf("id %q, want canonical \"1\"", wire.id)
	}
	if wire.session != "sess" || wire.leaf != "leaf" {
		t.Fatalf("expected identity %q/%q, want sess/leaf", wire.session, wire.leaf)
	}
	if wire.model == nil || wire.model.GetProvider() != "p" || wire.model.GetModel() != "m" {
		t.Fatalf("expected model %+v, want p/m", wire.model)
	}
	if !wire.hasCounters || wire.run != 0 || wire.contextRev != 0 {
		t.Fatalf("expected run/context %+v, want explicit 0/0", wire)
	}
	sendReloadAck(t, stream, "pane-r1", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
	})
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestReload: %v", o.err)
		}
		if o.res.RequestID != "1" || o.res.Outcome != pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED || o.res.Reason != "" {
			t.Fatalf("result %+v", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestReload hung")
	}
	// A dispatch receipt never retires: the operation stays
	// unresolved until release evidence arrives.
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); reloadRefusalReason(t, err) != "pending" {
		t.Fatalf("post-dispatch reason %v, want pending", err)
	}
	// Release evidence retires; the next operation allocates the
	// next monotonic ID, never reused.
	sendReloadSnapshot(t, stream, "pane-r1", proc, 1, releaseReloadSnapshot(1))
	time.Sleep(200 * time.Millisecond)
	rev2, _ := s.PublicationRevision(proc)
	done2 := make(chan outcome, 1)
	go func() {
		rctx, rstop := context.WithTimeout(context.Background(), 5*time.Second)
		defer rstop()
		res, err := s.RequestReload(rctx, proc, 1, rev2, 0, 0)
		done2 <- outcome{res: res, err: err}
	}()
	wire2 := recvReloadRequest(t, stream)
	if wire2.id != "2" {
		t.Fatalf("second id %q, want \"2\"", wire2.id)
	}
	sendReloadAck(t, stream, "pane-r1", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire2.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED, Reason: "busy",
	})
	select {
	case o := <-done2:
		if o.err != nil {
			t.Fatalf("second RequestReload: %v", o.err)
		}
		if o.res.Outcome != pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED || o.res.Reason != "busy" {
			t.Fatalf("result %+v, want refused/busy", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second RequestReload hung")
	}
	// A host refusal retires at once: the next dispatch proceeds
	// without further release evidence.
	rev3, _ := s.PublicationRevision(proc)
	done3 := make(chan outcome, 1)
	go func() {
		rctx, rstop := context.WithTimeout(context.Background(), 5*time.Second)
		defer rstop()
		res, err := s.RequestReload(rctx, proc, 1, rev3, 0, 0)
		done3 <- outcome{res: res, err: err}
	}()
	wire3 := recvReloadRequest(t, stream)
	sendReloadAck(t, stream, "pane-r1", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire3.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
	})
	select {
	case o := <-done3:
		if o.err != nil {
			t.Fatalf("third RequestReload: %v", o.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("third RequestReload hung")
	}
}

func TestRequestReloadEmptyLeaf(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-rnoleaf")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-rnoleaf", proc, token)
	defer cancel()
	hello := reloadHello("pane-rnoleaf", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReloadReadiness())
	hello.GetHello().GetCurrentState().LeafId = ""
	if err := stream.Send(hello); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, stream)
	rev, _ := s.PublicationRevision(proc)
	done := make(chan ReloadResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
		if err != nil {
			t.Errorf("RequestReload: %v", err)
			return
		}
		done <- res
	}()
	wire := recvReloadRequest(t, stream)
	if wire.leaf != "" {
		t.Fatalf("expected leaf %q, want known empty", wire.leaf)
	}
	sendReloadAck(t, stream, "pane-rnoleaf", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
	})
	select {
	case res := <-done:
		if res.Outcome != pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestReload hung")
	}
}

func TestRequestReloadAdmissionRefusals(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()

	newIdle := func(t *testing.T, pane string) (pibridgepb.Integration_ConnectClient, string, context.CancelFunc, uint64) {
		t.Helper()
		stream, proc, _, cancel, rev := openReloadStream(t, s, sock, pane)
		return stream, proc, cancel, rev
	}

	t.Run("stale stamps", func(t *testing.T) {
		_, proc, cancel, rev := newIdle(t, "pane-rstale")
		defer cancel()
		stamps := map[string][4]uint64{
			"generation": {2, rev, 0, 0},
			"pubrev":     {1, rev + 10, 0, 0},
			"run":        {1, rev, 9, 0},
			"context":    {1, rev, 0, 9},
		}
		for name, stamp := range stamps {
			_, err := s.RequestReload(ctx, proc, stamp[0], stamp[1], stamp[2], stamp[3])
			if reloadRefusalReason(t, err) != "stale" {
				t.Fatalf("%s reason %v, want stale", name, err)
			}
		}
	})

	t.Run("busy states", func(t *testing.T) {
		// Running logical state refuses even with idle readiness.
		stream, proc, cancel, _ := newIdle(t, "pane-rrun")
		defer cancel()
		sendReloadSnapshot(t, stream, "pane-rrun", proc, 1, &pibridgepb.StateSnapshot{
			State: pibridgepb.LogicalState_LOGICAL_STATE_RUNNING, SessionId: "sess", LeafId: "leaf",
			Model:           &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
			ReloadReadiness: idleReloadReadiness(),
		})
		time.Sleep(200 * time.Millisecond)
		rev, _ := s.PublicationRevision(proc)
		if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); reloadRefusalReason(t, err) != "busy" {
			t.Fatalf("running reason %v, want busy", err)
		}

		// Missing readiness, missing counters, and not-idle all
		// refuse busy: none proves an idle fence.
		cases := map[string]*pibridgepb.ReloadReadiness{
			"absent":          nil,
			"missing run":     {ContextRevision: uptr(0), Idle: true},
			"missing context": {RunId: uptr(0), Idle: true},
			"not idle":        {RunId: uptr(0), ContextRevision: uptr(0), Idle: false},
		}
		i := 0
		for name, ready := range cases {
			i++
			pane := "pane-rbusy"
			stream, proc, cancel, _ := newIdle(t, pane+string(rune('a'+i)))
			func() {
				defer cancel()
				sendReloadSnapshot(t, stream, pane+string(rune('a'+i)), proc, 1, idleSnapshotWithReload("sess", "leaf", 3, ready))
				time.Sleep(200 * time.Millisecond)
				rev, _ := s.PublicationRevision(proc)
				_, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
				if reloadRefusalReason(t, err) != "busy" {
					t.Fatalf("%s reason %v, want busy", name, err)
				}
			}()
		}
	})

	t.Run("queued and active", func(t *testing.T) {
		stream, proc, cancel, _ := newIdle(t, "pane-rqueue")
		defer cancel()
		sendReloadSnapshot(t, stream, "pane-rqueue", proc, 1, idleSnapshotWithReload("sess", "leaf", 3,
			&pibridgepb.ReloadReadiness{RunId: uptr(0), ContextRevision: uptr(0), Idle: true, HasPendingMessages: true}))
		time.Sleep(200 * time.Millisecond)
		rev, _ := s.PublicationRevision(proc)
		if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); reloadRefusalReason(t, err) != "queued" {
			t.Fatalf("queued reason %v", err)
		}
		sendReloadSnapshot(t, stream, "pane-rqueue", proc, 1, idleSnapshotWithReload("sess", "leaf", 4,
			&pibridgepb.ReloadReadiness{RunId: uptr(0), ContextRevision: uptr(0), Idle: true, CompactionActive: true}))
		time.Sleep(200 * time.Millisecond)
		rev, _ = s.PublicationRevision(proc)
		if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); reloadRefusalReason(t, err) != "compaction-active" {
			t.Fatalf("active reason %v", err)
		}
	})

	t.Run("pending self and cross mutation", func(t *testing.T) {
		stream, proc, cancel, rev := newIdle(t, "pane-rpend")
		defer cancel()
		// Occupy the process with an unresolved Compact.
		creq := make(chan error, 1)
		go func() {
			cctx, cstop := context.WithTimeout(context.Background(), 5*time.Second)
			defer cstop()
			_, err := s.RequestCompact(cctx, proc, 1, rev)
			creq <- err
		}()
		_ = recvCompactRequest(t, stream)
		if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); reloadRefusalReason(t, err) != "pending" {
			t.Fatalf("cross reason %v, want pending", err)
		}
		// Resolve the Compact, then occupy with an unresolved Reload.
		sendCompactResult(t, stream, "pane-rpend", proc, 1, &pibridgepb.CompactResult{
			RequestId: "1", Outcome: pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED,
		})
		select {
		case err := <-creq:
			if err != nil {
				t.Fatalf("compact: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("compact hung")
		}
		rreq := make(chan error, 1)
		go func() {
			cctx, cstop := context.WithTimeout(context.Background(), 5*time.Second)
			defer cstop()
			_, err := s.RequestReload(cctx, proc, 1, rev, 0, 0)
			rreq <- err
		}()
		wire := recvReloadRequest(t, stream)
		if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); reloadRefusalReason(t, err) != "pending" {
			t.Fatalf("self reason %v, want pending", err)
		}
		// The unresolved Reload also excludes a fresh Compact.
		if _, err := s.RequestCompact(ctx, proc, 1, rev); compactRefusalReason(t, err) != "pending" {
			t.Fatalf("compact cross reason %v, want pending", err)
		}
		sendReloadAck(t, stream, "pane-rpend", proc, 1, &pibridgepb.ReloadAck{
			RequestId: wire.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED, Reason: "busy",
		})
		select {
		case err := <-rreq:
			if err != nil {
				t.Fatalf("reload: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("reload hung")
		}
	})
}

func TestRequestReloadUnavailable(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()

	if _, err := s.RequestReload(ctx, "nope", 1, 1, 0, 0); err == nil || !strings.Contains(err.Error(), "unknown process") {
		t.Fatalf("err %v, want unknown process", err)
	}
	// A lease without a live peer cannot dispatch.
	proc, _, err := s.RegisterPending("pane-rpeerless")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	if _, err := s.RequestReload(ctx, proc, 1, 1, 0, 0); err == nil || !strings.Contains(err.Error(), "no live peer") {
		t.Fatalf("err %v, want no live peer", err)
	}
	// A stream without the reload capability cannot dispatch.
	proc2, token2, err := s.RegisterPending("pane-rnocap")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc2)
	stream2, cancel2 := openStream(t, sock, "pane-rnocap", proc2, token2)
	defer cancel2()
	hello := compactHello("pane-rnocap", proc2, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReadiness(), nil)
	if err := stream2.Send(hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	recvAccepted(t, stream2)
	rev2, _ := s.PublicationRevision(proc2)
	if _, err := s.RequestReload(ctx, proc2, 1, rev2, 0, 0); err == nil || !strings.Contains(err.Error(), "capability") {
		t.Fatalf("err %v, want capability miss", err)
	}
	// A caller that is already done never dispatches.
	_, proc3, _, cancel3, rev3 := openReloadStream(t, s, sock, "pane-rdone")
	defer cancel3()
	done, stopDone := context.WithCancel(context.Background())
	stopDone()
	if _, err := s.RequestReload(done, proc3, 1, rev3, 0, 0); err == nil || !strings.Contains(err.Error(), "caller done") {
		t.Fatalf("err %v, want caller done", err)
	}
}

func TestRequestReloadDropsUncertainOutcome(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openReloadStream(t, s, sock, "pane-runcertain")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer stop()
		_, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
		errCh <- err
	}()
	wire := recvReloadRequest(t, stream)
	// UNSPECIFIED is dropped, never delivered: the waiter times
	// out unknown and the operation stays unresolved.
	sendReloadAck(t, stream, "pane-runcertain", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_UNSPECIFIED,
	})
	select {
	case err := <-errCh:
		if reloadUnknownID(t, err) != wire.id {
			t.Fatalf("err %v, want unknown for %s", err, wire.id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after uncertain outcome")
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); reloadRefusalReason(t, err) != "pending" {
		t.Fatalf("post-unknown reason %v, want pending", err)
	}
}

func TestRequestReloadIgnoresStrayReceipts(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openReloadStream(t, s, sock, "pane-rstray")
	defer cancel()

	done := make(chan ReloadResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
		if err != nil {
			t.Errorf("RequestReload: %v", err)
			return
		}
		done <- res
	}()
	wire := recvReloadRequest(t, stream)
	// Empty, unsolicited, foreign, and unknown-enum receipts drop.
	for _, ack := range []*pibridgepb.ReloadAck{
		{RequestId: "", Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED},
		{RequestId: "999", Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED},
		{RequestId: wire.id, Outcome: pibridgepb.ReloadDispatchOutcome(99)},
	} {
		sendReloadAck(t, stream, "pane-rstray", proc, 1, ack)
	}
	// A hostile reason coerces to empty, never an error.
	sendReloadAck(t, stream, "pane-rstray", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED, Reason: "injected\ntext",
	})
	select {
	case res := <-done:
		if res.Outcome != pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED || res.Reason != "" {
			t.Fatalf("result %+v, want refused/empty", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestReload hung after stray receipts")
	}
}

func TestRequestReloadTimeoutKeepsOperation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openReloadStream(t, s, sock, "pane-rtimeout")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer stop()
		_, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
		errCh <- err
	}()
	wire := recvReloadRequest(t, stream)
	select {
	case err := <-errCh:
		if reloadUnknownID(t, err) != wire.id {
			t.Fatalf("err %v, want unknown for %s", err, wire.id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after timeout")
	}
	// Expiry never retires: release evidence does.
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); reloadRefusalReason(t, err) != "pending" {
		t.Fatalf("post-timeout reason %v, want pending", err)
	}
	sendReloadSnapshot(t, stream, "pane-rtimeout", proc, 1, releaseReloadSnapshot(1))
	time.Sleep(200 * time.Millisecond)
	rev2, _ := s.PublicationRevision(proc)
	done := make(chan ReloadResult, 1)
	go func() {
		rctx, rstop := context.WithTimeout(context.Background(), 5*time.Second)
		defer rstop()
		res, err := s.RequestReload(rctx, proc, 1, rev2, 0, 0)
		if err != nil {
			t.Errorf("next RequestReload: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvReloadRequest(t, stream)
	if wire2.id == wire.id {
		t.Fatal("request id reused after release")
	}
	sendReloadAck(t, stream, "pane-rtimeout", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire2.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v, want fresh operation", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("next RequestReload hung")
	}
}

func TestRequestReloadPeerLossKeepsOperation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel, rev := openReloadStream(t, s, sock, "pane-rloss")

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
		errCh <- err
	}()
	wire := recvReloadRequest(t, stream)
	cancel() // drop only the bridge stream, not the process
	select {
	case err := <-errCh:
		if reloadUnknownID(t, err) != wire.id {
			t.Fatalf("err %v, want unknown for %s", err, wire.id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after peer loss")
	}
	// Same-generation reconnect keeps the unresolved operation.
	stream2, cancel2 := openStream(t, sock, "pane-rloss", proc, token)
	defer cancel2()
	if err := stream2.Send(reloadHello("pane-rloss", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReloadReadiness())); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	recvAccepted(t, stream2)
	rev2, _ := s.PublicationRevision(proc)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestReload(ctx, proc, 1, rev2, 0, 0); reloadRefusalReason(t, err) != "pending" {
		t.Fatalf("post-loss reason %v, want pending", err)
	}
	// Release evidence on the new stream retires it.
	sendReloadSnapshot(t, stream2, "pane-rloss", proc, 1, releaseReloadSnapshot(1))
	time.Sleep(200 * time.Millisecond)
	rev3, _ := s.PublicationRevision(proc)
	done := make(chan ReloadResult, 1)
	go func() {
		rctx, rstop := context.WithTimeout(context.Background(), 5*time.Second)
		defer rstop()
		res, err := s.RequestReload(rctx, proc, 1, rev3, 0, 0)
		if err != nil {
			t.Errorf("next RequestReload: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvReloadRequest(t, stream2)
	if wire2.id == wire.id {
		t.Fatal("request id reused after peer-loss release")
	}
	sendReloadAck(t, stream2, "pane-rloss", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire2.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v, want fresh operation", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("next RequestReload hung")
	}
	_ = stream
}

func TestRequestReloadReplacementKeepsWithoutEvidence(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel, _ := openReloadStream(t, s, sock, "pane-rreplace")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		rev, _ := s.PublicationRevision(proc)
		_, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
		errCh <- err
	}()
	wire := recvReloadRequest(t, stream)
	// A new runtime generation keeps the operation: the waiter
	// reports unknown, never a stale satisfaction.
	stream2, cancel2 := openStream(t, sock, "pane-rreplace", proc, token)
	defer cancel2()
	hello2 := reloadHello("pane-rreplace", proc, 2, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReloadReadiness())
	hello2.GetHello().RuntimeId = "rt2"
	// No high-water coverage yet: the Hello carries no release
	// evidence, so the operation survives replacement.
	if err := stream2.Send(hello2); err != nil {
		t.Fatalf("hello2: %v", err)
	}
	recvAccepted(t, stream2)
	select {
	case err := <-errCh:
		if reloadUnknownID(t, err) != wire.id {
			t.Fatalf("err %v, want unknown for %s", err, wire.id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after replacement")
	}
	rev2, _ := s.PublicationRevision(proc)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestReload(ctx, proc, 2, rev2, 0, 0); reloadRefusalReason(t, err) != "pending" {
		t.Fatalf("post-replacement reason %v, want pending", err)
	}
	// An old-generation receipt cannot satisfy or clear anything.
	sendReloadAck(t, stream2, "pane-rreplace", proc, 2, &pibridgepb.ReloadAck{
		RequestId: wire.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
	})
	time.Sleep(200 * time.Millisecond)
	if _, err := s.RequestReload(ctx, proc, 2, rev2, 0, 0); reloadRefusalReason(t, err) != "pending" {
		t.Fatalf("post-stray reason %v, want pending", err)
	}
	// Release evidence from the replacement runtime retires it.
	sendReloadSnapshot(t, stream2, "pane-rreplace", proc, 2, releaseReloadSnapshot(1))
	time.Sleep(200 * time.Millisecond)
	rev3, _ := s.PublicationRevision(proc)
	done := make(chan ReloadResult, 1)
	go func() {
		rctx, rstop := context.WithTimeout(context.Background(), 5*time.Second)
		defer rstop()
		res, err := s.RequestReload(rctx, proc, 2, rev3, 0, 0)
		if err != nil {
			t.Errorf("gen2 RequestReload: %v", err)
			return
		}
		done <- res
	}()
	wire2 := recvReloadRequest(t, stream2)
	if wire2.id == wire.id {
		t.Fatal("request id reused across generations")
	}
	sendReloadAck(t, stream2, "pane-rreplace", proc, 2, &pibridgepb.ReloadAck{
		RequestId: wire2.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
	})
	select {
	case res := <-done:
		if res.RequestID != wire2.id {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("gen2 RequestReload hung")
	}
}

func TestRequestReloadSendMissReleasesRecord(t *testing.T) {
	s := NewServer()
	proc, _, err := s.RegisterPending("pane-rqueue")
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
	l.caps = []string{CapabilityReload, CapabilityLifecycle}
	l.lastState = idleSnapshotWithReload("sess", "leaf", 1, idleReloadReadiness())
	l.pubRev = 7
	l.mu.Unlock()
	for i := 0; i < maxQueuedMessages; i++ {
		if !p.sendNonfatal(acceptedMsg(4)) {
			t.Fatalf("fill %d rejected early", i)
		}
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestReload(ctx, proc, 1, 7, 0, 0); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("err %v, want unavailable send miss", err)
	}
	// Never dispatched means no retained operation: the next caller
	// is fenced by the queue again, not by a phantom pending op.
	l.mu.Lock()
	stuck := l.reload != nil
	l.mu.Unlock()
	if stuck {
		t.Fatal("send miss retained a phantom operation")
	}
}

func TestRequestReloadRevokeReleasesOperation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, rev := openReloadStream(t, s, sock, "pane-rrevoke")
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestReload(ctx, proc, 1, rev, 0, 0)
		errCh <- err
	}()
	wire := recvReloadRequest(t, stream)
	s.Revoke(proc)
	select {
	case err := <-errCh:
		if reloadUnknownID(t, err) != wire.id {
			t.Fatalf("err %v, want unknown for %s", err, wire.id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter hung after revoke")
	}
	// The lease is gone: later callers fail unavailable, and no
	// record survives the revoke.
	s.reg.mu.Lock()
	_, stillThere := s.reg.byProcess[proc]
	s.reg.mu.Unlock()
	if stillThere {
		t.Fatal("revoke kept the lease")
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestReload(ctx, proc, 1, rev, 0, 0); err == nil || !strings.Contains(err.Error(), "unknown process") {
		t.Fatalf("err %v, want unknown process", err)
	}
}

func TestRequestReloadReplacementBetweenDeliveryAndConsumption(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel, _ := openReloadStream(t, s, sock, "pane-r1race")
	defer cancel()
	l, _ := s.reg.lookupByProcess(proc)

	// Each iteration delivers the dispatch receipt, then replaces
	// the dispatch peer while the waiter is gated inside
	// consumption: replacement strictly precedes the currency
	// check, so the waiter reports unknown every time while the
	// dispatched operation itself stays unresolved. A missing
	// waiter fence returns DISPATCHED instead.
	for i := 0; i < 5; i++ {
		rev, _ := s.PublicationRevision(proc)
		parent, stop := context.WithTimeout(context.Background(), 5*time.Second)
		gated := newGateContext(parent)
		errCh := make(chan error, 1)
		go func() {
			_, err := s.RequestReload(gated, proc, 1, rev, 0, 0)
			errCh <- err
		}()
		wire := recvReloadRequest(t, stream)
		l.mu.Lock()
		dispatchPeer := l.peer
		l.mu.Unlock()
		if err := s.handleMessage(l, dispatchPeer, reloadAckMsg(wire.id, pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED, "")); err != nil {
			stop()
			t.Fatalf("iter %d deliver: %v", i, err)
		}
		// The waiter has the receipt and is gated: swap first,
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
			if reloadUnknownID(t, err) != wire.id {
				t.Fatalf("iter %d err %v, want unknown for %s", i, err, wire.id)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("iter %d waiter hung", i)
		}
		stop()
		l.mu.Lock()
		if l.reload == nil {
			l.mu.Unlock()
			t.Fatalf("iter %d retired a dispatched operation", i)
		}
		// Retire through release evidence so the next
		// iteration dispatches again.
		l.reload = nil
		l.peer = dispatchPeer
		l.mu.Unlock()
	}
}

func TestReconcileReloadRetirementRules(t *testing.T) {
	cases := []struct {
		name    string
		ready   *pibridgepb.ReloadReadiness
		retired bool
	}{
		{"absent", nil, false},
		{"missing high-water", &pibridgepb.ReloadReadiness{RunId: uptr(0), ContextRevision: uptr(0), Idle: true}, false},
		{"uncovered", &pibridgepb.ReloadReadiness{RunId: uptr(0), ContextRevision: uptr(0), Idle: true, HighWater: uptr(0)}, false},
		{"pending", &pibridgepb.ReloadReadiness{RunId: uptr(0), ContextRevision: uptr(0), Idle: true, HighWater: uptr(1), ReloadPending: true}, false},
		{"released", &pibridgepb.ReloadReadiness{RunId: uptr(0), ContextRevision: uptr(0), Idle: true, HighWater: uptr(1)}, true},
		{"covered above", &pibridgepb.ReloadReadiness{RunId: uptr(5), ContextRevision: uptr(9), Idle: false, HighWater: uptr(7)}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := &lease{reload: &reloadOp{id: "1", ch: make(chan ReloadResult, 1), waiter: false}}
			snap := &pibridgepb.StateSnapshot{ReloadReadiness: tc.ready}
			l.mu.Lock()
			reconcileReloadRetirement(l, snap)
			retired := l.reload == nil
			l.mu.Unlock()
			if retired != tc.retired {
				t.Fatalf("retired %v, want %v", retired, tc.retired)
			}
		})
	}
}

func TestAllocReloadIDBoundaryAndConcurrent(t *testing.T) {
	s := NewServer()
	s.reloadSeq.Store(math.MaxUint64 - 1)
	id, ok := s.allocReloadID()
	if !ok || id != math.MaxUint64 {
		t.Fatalf("id %d ok %v, want MaxUint64 once", id, ok)
	}
	if _, ok := s.allocReloadID(); ok {
		t.Fatal("allocator wrapped past MaxUint64")
	}
	s2 := NewServer()
	const n = 64
	ids := make([]uint64, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id, ok := s2.allocReloadID()
			if !ok {
				t.Errorf("worker %d failed", i)
				return
			}
			ids[i] = id
		}(i)
	}
	wg.Wait()
	seen := map[uint64]bool{}
	for _, id := range ids {
		if id == 0 || seen[id] {
			t.Fatalf("ids %v, want unique positive", ids)
		}
		seen[id] = true
	}
}

func TestReloadSequenceSaturates(t *testing.T) {
	s := NewServer()
	proc, _, err := s.RegisterPending("reload-saturate")
	if err != nil {
		t.Fatal(err)
	}
	s.Complete(proc)
	l, _ := s.reg.lookupByProcess(proc)
	p := newPeer(1, "sess", newBlockingStream())
	l.mu.Lock()
	l.peer, l.maxGen, l.runtimeID, l.sessionID = p, 1, "rt", "sess"
	l.caps = []string{CapabilityReload}
	l.lastState = idleSnapshotWithReload("sess", "leaf", 1, idleReloadReadiness())
	l.mu.Unlock()
	s.reloadSeq.Store(math.MaxUint64)
	for i := 0; i < 2; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		_, err := s.RequestReload(ctx, proc, 1, l.pubRev, 0, 0)
		cancel()
		var unavailable *ReloadUnavailable
		if !errors.As(err, &unavailable) {
			t.Fatalf("attempt %d reused exhausted ID space: %v", i+1, err)
		}
	}
	if len(p.sendCh) != 0 {
		t.Fatal("exhausted allocator dispatched a request")
	}
}

func TestReloadCapabilityNegotiatedIndependently(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	// Reload without Compact: reload dispatches, compact cannot.
	proc, token, err := s.RegisterPending("pane-rindep")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-rindep", proc, token)
	defer cancel()
	hello := reloadHello("pane-rindep", proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReloadReadiness())
	hello.GetHello().Capabilities = []string{CapabilityLifecycle, CapabilityReload}
	hello.GetHello().GetCurrentState().CompactReadiness = nil
	if err := stream.Send(hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	accepted := recvAccepted(t, stream)
	found := false
	for _, c := range accepted.Capabilities {
		if c == CapabilityReload {
			found = true
		}
		if c == CapabilityCompact {
			t.Fatal("unadvertised compact capability accepted")
		}
	}
	if !found {
		t.Fatal("reload capability not accepted")
	}
	rev, _ := s.PublicationRevision(proc)
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := s.RequestCompact(ctx, proc, 1, rev); err == nil || !strings.Contains(err.Error(), "capability") {
		t.Fatalf("compact err %v, want capability miss", err)
	}
	done := make(chan ReloadResult, 1)
	go func() {
		rctx, rstop := context.WithTimeout(context.Background(), 5*time.Second)
		defer rstop()
		res, err := s.RequestReload(rctx, proc, 1, rev, 0, 0)
		if err != nil {
			t.Errorf("RequestReload: %v", err)
			return
		}
		done <- res
	}()
	wire := recvReloadRequest(t, stream)
	sendReloadAck(t, stream, "pane-rindep", proc, 1, &pibridgepb.ReloadAck{
		RequestId: wire.id, Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
	})
	select {
	case res := <-done:
		if res.Outcome != pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestReload hung")
	}
}

func TestReloadReadinessCopies(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	gotCh := make(chan *ReloadReadiness, 1)
	s.SetOnState(func(_, _ string, _, _ uint64, _, _ bool, _, _ string, _ []string, _ *ContextUsage, _ *Readiness, reload *ReloadReadiness) {
		if reload == nil {
			return
		}
		select {
		case gotCh <- reload:
		default:
		}
	})
	stream, proc, _, cancel, _ := openReloadStream(t, s, sock, "pane-rcopy")
	defer cancel()
	var got *ReloadReadiness
	select {
	case got = <-gotCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for reload readiness callback")
	}
	if !got.HasRunID || got.RunID != 0 || !got.HasContextRevision || got.ContextRevision != 0 {
		t.Fatalf("onState reload %+v, want explicit zero counters", got)
	}
	if !got.Idle || got.HasHighWater {
		t.Fatalf("onState reload %+v, want idle without high-water", got)
	}
	view, ok := s.PaneState(proc)
	if !ok || view.Reload == nil || !view.Reload.HasRunID || view.Reload.RunID != 0 {
		t.Fatalf("pane state reload %+v, want explicit zero", view.Reload)
	}
	// Release evidence updates the retained copy, including an
	// explicit high-water mark.
	sendReloadSnapshot(t, stream, "pane-rcopy", proc, 1, releaseReloadSnapshot(4))
	time.Sleep(200 * time.Millisecond)
	view, _ = s.PaneState(proc)
	if view.Reload == nil || !view.Reload.HasHighWater || view.Reload.HighWater != 4 {
		t.Fatalf("pane state reload %+v, want high-water 4", view.Reload)
	}
}
