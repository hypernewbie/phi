package pibridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func recvSkillsRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) string {
	t.Helper()
	streamCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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
		req := r.msg.GetSkillsRequest()
		if req == nil {
			t.Fatalf("not a skills request: %v", r.msg.GetPayload())
		}
		return req.GetRequestId()
	case <-streamCtx.Done():
		t.Fatalf("timed out waiting for skills request")
		return ""
	}
}

func recvInvokeSkillRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) (id, name string) {
	t.Helper()
	streamCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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
		req := r.msg.GetInvokeSkillRequest()
		if req == nil {
			t.Fatalf("not an invoke-skill request: %v", r.msg.GetPayload())
		}
		return req.GetRequestId(), req.GetName()
	case <-streamCtx.Done():
		t.Fatalf("timed out waiting for invoke-skill request")
		return "", ""
	}
}

func sendSkillsResponse(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, res *pibridgepb.SkillsResponse) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_SkillsResponse{SkillsResponse: res},
	}); err != nil {
		t.Fatalf("send response: %v", err)
	}
}

func sendInvokeSkillAck(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, ack *pibridgepb.InvokeSkillAck) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_InvokeSkillAck{InvokeSkillAck: ack},
	}); err != nil {
		t.Fatalf("send ack: %v", err)
	}
}

// expectNoPeerRequest fails when the peer receives anything within a
// short window. A refused request must never reach the peer.
func expectNoPeerRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) {
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
		t.Fatalf("peer received %v", r.msg)
	case <-time.After(200 * time.Millisecond):
	}
}

// expectNoInvokeSkillRequest fails when the peer receives an invoke
// request within a short window. Other lifecycle traffic is ignored:
// only the skill request itself is the fault.
func expectNoInvokeSkillRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) {
	t.Helper()
	deadline := time.After(300 * time.Millisecond)
	for {
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
				return
			}
			if r.msg.GetInvokeSkillRequest() != nil {
				t.Fatalf("peer received an invoke request")
			}
		case <-deadline:
			return
		}
	}
}

func TestRequestSkillsRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k1", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	type outcome struct {
		res SkillsResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestSkills(ctx, proc)
		done <- outcome{res: res, err: err}
	}()
	id := recvSkillsRequest(t, stream)
	if id == "" {
		t.Fatal("empty request id")
	}
	sendSkillsResponse(t, stream, "pane-k1", proc, &pibridgepb.SkillsResponse{
		RequestId: id,
		Skills: []*pibridgepb.SkillRef{
			{Name: "demo-skill", Description: "demo"},
			{Name: "other-skill", Description: ""},
		},
		Truncated: true,
	})
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestSkills: %v", o.err)
		}
		if o.res.Unavailable || !o.res.Truncated || len(o.res.Skills) != 2 {
			t.Fatalf("result %+v", o.res)
		}
		if o.res.Skills[0] != (SkillRef{Name: "demo-skill", Description: "demo"}) {
			t.Fatalf("first %+v", o.res.Skills[0])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestSkills hung")
	}
}

func TestRequestSkillsUnavailable(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k2", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	done := make(chan SkillsResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestSkills(ctx, proc)
		if err != nil {
			t.Errorf("RequestSkills: %v", err)
			return
		}
		done <- res
	}()
	id := recvSkillsRequest(t, stream)
	sendSkillsResponse(t, stream, "pane-k2", proc, &pibridgepb.SkillsResponse{RequestId: id, Unavailable: true})
	select {
	case res := <-done:
		if !res.Unavailable || len(res.Skills) != 0 {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestSkills hung")
	}
}

// A peer that breaks the wire bounds must not deliver a partial list:
// the whole list answers unavailable.
func TestRequestSkillsOverlongEntryIsUnavailable(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k3", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	done := make(chan SkillsResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestSkills(ctx, proc)
		if err != nil {
			t.Errorf("RequestSkills: %v", err)
			return
		}
		done <- res
	}()
	id := recvSkillsRequest(t, stream)
	sendSkillsResponse(t, stream, "pane-k3", proc, &pibridgepb.SkillsResponse{
		RequestId: id,
		Skills: []*pibridgepb.SkillRef{
			{Name: "demo-skill", Description: "demo"},
			{Name: "long-skill", Description: strings.Repeat("x", maxSkillDescriptionBytes+1)},
		},
	})
	select {
	case res := <-done:
		if !res.Unavailable || len(res.Skills) != 0 {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestSkills hung")
	}
}

// A name that cannot address one skill makes the whole list
// unavailable: the bridge never shows a partial list as the session's
// complete skill set.
func TestRequestSkillsUnaddressableEntryIsUnavailable(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k14", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	done := make(chan SkillsResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestSkills(ctx, proc)
		if err != nil {
			t.Errorf("RequestSkills: %v", err)
			return
		}
		done <- res
	}()
	id := recvSkillsRequest(t, stream)
	sendSkillsResponse(t, stream, "pane-k14", proc, &pibridgepb.SkillsResponse{
		RequestId: id,
		Skills: []*pibridgepb.SkillRef{
			{Name: "demo-skill", Description: "demo"},
			{Name: "demo skill", Description: "demo"},
		},
	})
	select {
	case res := <-done:
		if !res.Unavailable || len(res.Skills) != 0 {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestSkills hung")
	}
}

func TestRequestSkillsNegotiation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	_, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k4", CapabilityLifecycle)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := s.RequestSkills(ctx, proc); err == nil {
		t.Fatal("expected negotiation error")
	}
}

func TestRequestSkillsPendingCap(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k5", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	type outcome struct {
		res SkillsResult
		err error
	}
	results := make(chan outcome, maxSkillsPending+1)
	for i := 0; i < maxSkillsPending; i++ {
		go func() {
			res, err := s.RequestSkills(ctx, proc)
			results <- outcome{res: res, err: err}
		}()
	}
	ids := map[string]bool{}
	for i := 0; i < maxSkillsPending; i++ {
		ids[recvSkillsRequest(t, stream)] = true
	}
	if len(ids) != maxSkillsPending {
		t.Fatalf("ids %v, want %d unique", ids, maxSkillsPending)
	}
	if _, err := s.RequestSkills(ctx, proc); err == nil || !strings.Contains(err.Error(), "too many pending") {
		t.Fatalf("err %v, want too-many-pending", err)
	}
	var first string
	for id := range ids {
		first = id
		break
	}
	sendSkillsResponse(t, stream, "pane-k5", proc, &pibridgepb.SkillsResponse{RequestId: first, Skills: []*pibridgepb.SkillRef{{Name: "demo-skill"}}})
	select {
	case o := <-results:
		if o.err != nil || len(o.res.Skills) != 1 {
			t.Fatalf("outcome %+v", o)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first waiter hung")
	}
	go func() {
		res, err := s.RequestSkills(ctx, proc)
		results <- outcome{res: res, err: err}
	}()
	next := recvSkillsRequest(t, stream)
	if ids[next] {
		t.Fatalf("id %s reused", next)
	}
}

func TestRequestSkillsReplacementFailsStaleWaiter(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel := openLeaseStream(t, s, sock, "pane-k6", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestSkills(ctx, proc)
		errCh <- err
	}()
	recvSkillsRequest(t, stream)

	stream2, cancel2 := openStream(t, sock, "pane-k6", proc, token)
	defer cancel2()
	hello2 := testHello("pane-k6", proc, 2, CapabilityLifecycle, CapabilitySkills)
	hello2.GetHello().RuntimeId = "rt2"
	hello2.GetHello().SessionId = "sess2"
	hello2.GetHello().GetCurrentState().SessionId = "sess2"
	if err := stream2.Send(hello2); err != nil {
		t.Fatalf("hello2: %v", err)
	}
	recvAccepted(t, stream2)
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("stale waiter succeeded after replacement")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stale waiter hung after replacement")
	}
}

// A name that cannot address one skill is refused before dispatch:
// "/skill:<name>" would split at the first space.
func TestRequestInvokeSkillRejectsUnaddressableName(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k15", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := s.RequestInvokeSkill(ctx, proc, 1, "demo skill"); err == nil {
		t.Fatal("expected invalid-name error")
	}
	// No request was queued for the peer.
	expectNoPeerRequest(t, stream)
}

func TestRequestInvokeSkillRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k7", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	type outcome struct {
		res InvokeSkillResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestInvokeSkill(ctx, proc, 1, "demo-skill")
		done <- outcome{res: res, err: err}
	}()
	id, name := recvInvokeSkillRequest(t, stream)
	if id == "" || name != "demo-skill" {
		t.Fatalf("request %q %q", id, name)
	}
	sendInvokeSkillAck(t, stream, "pane-k7", proc, &pibridgepb.InvokeSkillAck{RequestId: id, Ok: true})
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestInvokeSkill: %v", o.err)
		}
		if !o.res.OK || o.res.Reason != "" {
			t.Fatalf("result %+v", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestInvokeSkill hung")
	}
}

func TestRequestInvokeSkillUnknownSkill(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k8", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	done := make(chan InvokeSkillResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestInvokeSkill(ctx, proc, 1, "demo-skill")
		if err != nil {
			t.Errorf("RequestInvokeSkill: %v", err)
			return
		}
		done <- res
	}()
	id, _ := recvInvokeSkillRequest(t, stream)
	sendInvokeSkillAck(t, stream, "pane-k8", proc, &pibridgepb.InvokeSkillAck{RequestId: id, Reason: "unknown-skill"})
	select {
	case res := <-done:
		if res.OK || res.Reason != "unknown-skill" {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestInvokeSkill hung")
	}
}

func TestRequestInvokeSkillReasonAllowlist(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k9", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	done := make(chan InvokeSkillResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestInvokeSkill(ctx, proc, 1, "demo-skill")
		if err != nil {
			t.Errorf("RequestInvokeSkill: %v", err)
			return
		}
		done <- res
	}()
	id, _ := recvInvokeSkillRequest(t, stream)
	sendInvokeSkillAck(t, stream, "pane-k9", proc, &pibridgepb.InvokeSkillAck{RequestId: id, Reason: "<script>"})
	select {
	case res := <-done:
		if res.OK || res.Reason != "" {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestInvokeSkill hung")
	}
}

func TestRequestInvokeSkillNegotiation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	_, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k10", CapabilityLifecycle)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := s.RequestInvokeSkill(ctx, proc, 1, "demo-skill"); err == nil {
		t.Fatal("expected negotiation error")
	}
}

// An oversized name never reaches the peer.
func TestRequestInvokeSkillRejectsOversizedName(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k11", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := s.RequestInvokeSkill(ctx, proc, 1, strings.Repeat("x", maxSkillNameBytes+1)); err == nil {
		t.Fatal("expected invalid-name error")
	}
	// No request was queued for the peer.
	expectNoPeerRequest(t, stream)
}

// A click must never land in a runtime that replaced the one that
// served the list: the stale origin is refused before dispatch.
func TestRequestInvokeSkillRejectsStaleOrigin(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-k12", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := s.RequestInvokeSkill(ctx, proc, 2, "demo-skill"); !errors.Is(err, ErrSkillOriginStale) {
		t.Fatalf("err %v, want stale origin", err)
	}
	// The skill never reached the peer.
	expectNoPeerRequest(t, stream)
}

// The runtime can move on between the list and the click. The origin
// the list carried is then stale, so the click is refused before the
// replacement peer sees it.
func TestRequestInvokeSkillRejectsReplacedRuntime(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	_, proc, token, cancel := openLeaseStream(t, s, sock, "pane-k13", CapabilityLifecycle, CapabilitySkills)
	defer cancel()

	// The session moves on: a new runtime takes the lease at
	// generation 2 after the list was served by generation 1.
	next, cancelNext := openStream(t, sock, "pane-k13", proc, token)
	defer cancelNext()
	if err := next.Send(testHello("pane-k13", proc, 2, CapabilityLifecycle, CapabilitySkills)); err != nil {
		t.Fatalf("hello gen 2: %v", err)
	}
	recvAccepted(t, next)

	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	// The click still carries the origin of the generation-1 list.
	if _, err := s.RequestInvokeSkill(ctx, proc, 1, "demo-skill"); !errors.Is(err, ErrSkillOriginStale) {
		t.Fatalf("err %v, want stale origin", err)
	}
	// The replacement peer never received the skill.
	expectNoInvokeSkillRequest(t, next)
}
