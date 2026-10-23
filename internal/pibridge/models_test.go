package pibridge

import (
	"context"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func recvModelsRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) string {
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
		req := r.msg.GetModelsRequest()
		if req == nil {
			t.Fatalf("not a models request: %v", r.msg.GetPayload())
		}
		return req.GetRequestId()
	case <-streamCtx.Done():
		t.Fatalf("timed out waiting for models request")
		return ""
	}
}

func recvSetModelRequest(t *testing.T, stream pibridgepb.Integration_ConnectClient) (id, provider, model string) {
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
		req := r.msg.GetSetModelRequest()
		if req == nil {
			t.Fatalf("not a set-model request: %v", r.msg.GetPayload())
		}
		return req.GetRequestId(), req.GetProvider(), req.GetModel()
	case <-streamCtx.Done():
		t.Fatalf("timed out waiting for set-model request")
		return "", "", ""
	}
}

func sendModelsResponse(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, res *pibridgepb.ModelsResponse) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_ModelsResponse{ModelsResponse: res},
	}); err != nil {
		t.Fatalf("send response: %v", err)
	}
}

func sendSetModelAck(t *testing.T, stream pibridgepb.Integration_ConnectClient, pane, proc string, res *pibridgepb.SetModelAck) {
	t.Helper()
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_SetModelAck{SetModelAck: res},
	}); err != nil {
		t.Fatalf("send ack: %v", err)
	}
}

func TestRequestModelsRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-m1", CapabilityLifecycle, CapabilityModels)
	defer cancel()

	type outcome struct {
		res ModelsResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestModels(ctx, proc)
		done <- outcome{res: res, err: err}
	}()
	id := recvModelsRequest(t, stream)
	if id == "" {
		t.Fatal("empty request id")
	}
	sendModelsResponse(t, stream, "pane-m1", proc, &pibridgepb.ModelsResponse{
		RequestId: id,
		Models: []*pibridgepb.ModelRef{
			{Provider: "a", Model: "x"},
			{Provider: "b", Model: "y"},
			{Provider: "", Model: "dropped"},
		},
		Truncated: true,
	})
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestModels: %v", o.err)
		}
		if o.res.Unavailable || !o.res.Truncated || len(o.res.Models) != 2 {
			t.Fatalf("result %+v", o.res)
		}
		if o.res.Models[0] != (ModelRef{Provider: "a", Model: "x"}) {
			t.Fatalf("first %+v", o.res.Models[0])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestModels hung")
	}
}

func TestRequestModelsUnavailable(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-m2", CapabilityLifecycle, CapabilityModels)
	defer cancel()

	done := make(chan ModelsResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestModels(ctx, proc)
		if err != nil {
			t.Errorf("RequestModels: %v", err)
			return
		}
		done <- res
	}()
	id := recvModelsRequest(t, stream)
	sendModelsResponse(t, stream, "pane-m2", proc, &pibridgepb.ModelsResponse{RequestId: id, Unavailable: true})
	select {
	case res := <-done:
		if !res.Unavailable || len(res.Models) != 0 {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestModels hung")
	}
}

func TestRequestModelsNegotiation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	_, proc, _, cancel := openLeaseStream(t, s, sock, "pane-m3", CapabilityLifecycle)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := s.RequestModels(ctx, proc); err == nil {
		t.Fatal("expected negotiation error")
	}
}

func TestRequestSetModelRoundTrip(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-s1", CapabilityLifecycle, CapabilityModels)
	defer cancel()

	type outcome struct {
		res SetModelResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestSetModel(ctx, proc, "a", "x")
		done <- outcome{res: res, err: err}
	}()
	id, provider, model := recvSetModelRequest(t, stream)
	if id == "" || provider != "a" || model != "x" {
		t.Fatalf("request %q %q %q", id, provider, model)
	}
	sendSetModelAck(t, stream, "pane-s1", proc, &pibridgepb.SetModelAck{RequestId: id, Ok: true})
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestSetModel: %v", o.err)
		}
		if !o.res.OK || o.res.Reason != "" {
			t.Fatalf("result %+v", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestSetModel hung")
	}
}

func TestRequestSetModelRefused(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-s2", CapabilityLifecycle, CapabilityModels)
	defer cancel()

	done := make(chan SetModelResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestSetModel(ctx, proc, "a", "x")
		if err != nil {
			t.Errorf("RequestSetModel: %v", err)
			return
		}
		done <- res
	}()
	id, _, _ := recvSetModelRequest(t, stream)
	sendSetModelAck(t, stream, "pane-s2", proc, &pibridgepb.SetModelAck{RequestId: id, Reason: "no-auth"})
	select {
	case res := <-done:
		if res.OK || res.Reason != "no-auth" {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestSetModel hung")
	}
}

func TestRequestSetModelReasonAllowlist(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-s3", CapabilityLifecycle, CapabilityModels)
	defer cancel()

	done := make(chan SetModelResult, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		res, err := s.RequestSetModel(ctx, proc, "a", "x")
		if err != nil {
			t.Errorf("RequestSetModel: %v", err)
			return
		}
		done <- res
	}()
	id, _, _ := recvSetModelRequest(t, stream)
	sendSetModelAck(t, stream, "pane-s3", proc, &pibridgepb.SetModelAck{RequestId: id, Reason: "<script>"})
	select {
	case res := <-done:
		if res.OK || res.Reason != "" {
			t.Fatalf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestSetModel hung")
	}
}

func TestRequestSetModelNegotiation(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	_, proc, _, cancel := openLeaseStream(t, s, sock, "pane-s4", CapabilityLifecycle)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := s.RequestSetModel(ctx, proc, "a", "x"); err == nil {
		t.Fatal("expected negotiation error")
	}
}

func TestRequestModelsPendingCap(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-m4", CapabilityLifecycle, CapabilityModels)
	defer cancel()

	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	type outcome struct {
		res ModelsResult
		err error
	}
	results := make(chan outcome, maxModelsPending+1)
	for i := 0; i < maxModelsPending; i++ {
		go func() {
			res, err := s.RequestModels(ctx, proc)
			results <- outcome{res: res, err: err}
		}()
	}
	ids := map[string]bool{}
	for i := 0; i < maxModelsPending; i++ {
		ids[recvModelsRequest(t, stream)] = true
	}
	if len(ids) != maxModelsPending {
		t.Fatalf("ids %v, want %d unique", ids, maxModelsPending)
	}
	// The cap counts requests awaiting replies: one more fails fast.
	if _, err := s.RequestModels(ctx, proc); err == nil || !strings.Contains(err.Error(), "too many pending") {
		t.Fatalf("err %v, want too-many-pending", err)
	}
	// Answering one frees room for the next caller.
	var first string
	for id := range ids {
		first = id
		break
	}
	sendModelsResponse(t, stream, "pane-m4", proc, &pibridgepb.ModelsResponse{RequestId: first, Models: []*pibridgepb.ModelRef{{Provider: "a", Model: "x"}}})
	select {
	case o := <-results:
		if o.err != nil || len(o.res.Models) != 1 {
			t.Fatalf("outcome %+v", o)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first waiter hung")
	}
	go func() {
		res, err := s.RequestModels(ctx, proc)
		results <- outcome{res: res, err: err}
	}()
	next := recvModelsRequest(t, stream)
	if ids[next] {
		t.Fatalf("id %s reused", next)
	}
}

func TestRequestModelsReplacementFailsStaleWaiter(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, token, cancel := openLeaseStream(t, s, sock, "pane-m5", CapabilityLifecycle, CapabilityModels)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := s.RequestModels(ctx, proc)
		errCh <- err
	}()
	recvModelsRequest(t, stream)

	// A generation-2 reconnect replaces the stream; the gen-1 waiter
	// must fail rather than accept a late gen-1 answer.
	stream2, cancel2 := openStream(t, sock, "pane-m5", proc, token)
	defer cancel2()
	hello2 := testHello("pane-m5", proc, 2, CapabilityLifecycle, CapabilityModels)
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
