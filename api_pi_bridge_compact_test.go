package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"github.com/hypernewbie/phi/pkg/pty"
)

// dialCompactPane provisions a managed pane and opens an accepted idle
// stream with lifecycle+compact capabilities and idle readiness. It
// returns the stream, cancel, and the canonical stamps for requests.
func dialCompactPane(t *testing.T, b *Bridge, pane string) (pibridgepb.Integration_ConnectClient, context.CancelFunc, string, string) {
	t.Helper()
	env, _, managed := b.Provision(pane, true)
	if !managed {
		t.Fatal("provision not managed")
	}
	b.Complete(&pty.PTYInstance{ID: pane})
	proc := env[piBridgeEnvProcess]
	stream, cancel := dialBridge(t, b, pane, proc, env[piBridgeEnvToken])
	hello := &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
			ProtocolVersion: 1, SessionId: "sess", RuntimeId: "rt",
			Capabilities: []string{"pi.lifecycle.v1", "pi.context.v1", "pi.compact.v1"},
			CurrentState: &pibridgepb.StateSnapshot{
				State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess", LeafId: "leaf",
				Model:            &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
				CompactReadiness: &pibridgepb.CompactReadiness{Idle: true},
			},
		}},
	}
	if err := stream.Send(hello); err != nil {
		cancel()
		t.Fatalf("hello: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		cancel()
		t.Fatalf("accepted: %v", err)
	}
	rev, ok := b.server.PublicationRevision(proc)
	if !ok {
		cancel()
		t.Fatal("no publication revision")
	}
	return stream, cancel, proc, strconv.FormatUint(rev, 10)
}

type compactCanned struct {
	id            string
	session, leaf string
	model         *pibridgepb.ModelSnapshot
}

// answerCompactOnce receives one Compact request, answers it with the
// canned outcome, and reports what the server fenced on the wire.
func answerCompactOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient, outcome pibridgepb.CompactOutcome, reason string) compactCanned {
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("recv compact request: %v", r.err)
		}
		req := r.msg.GetCompactRequest()
		if req == nil {
			t.Fatalf("not a compact request: %v", r.msg.GetPayload())
		}
		got := compactCanned{id: req.GetRequestId(), session: req.GetExpectedSessionId(), leaf: req.GetExpectedLeafId(), model: req.GetExpectedModel()}
		if err := stream.Send(&pibridgepb.PiToPhi{
			PaneId: r.msg.GetPaneId(), ProcessId: r.msg.GetProcessId(), RuntimeGeneration: r.msg.GetRuntimeGeneration(),
			Payload: &pibridgepb.PiToPhi_CompactResult{CompactResult: &pibridgepb.CompactResult{
				RequestId: got.id, Outcome: outcome, Reason: reason,
			}},
		}); err != nil {
			t.Fatalf("send compact result: %v", err)
		}
		return got
	case <-ctx.Done():
		t.Fatalf("timed out waiting for compact request")
		return compactCanned{}
	}
}

func serveCompact(t *testing.T, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact", strings.NewReader(body))
	req.Host = "example.com"
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handlePiBridgeCompact(rec, req)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store", rec.Header().Get("Cache-Control"))
	}
	return rec
}

func decodeCompactBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func TestBridgeCompactTelemetryViews(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	env, _, _ := b.Provision("pane-1", true)
	proc := env[piBridgeEnvProcess]
	floor, _ := b.server.PublicationRevision(proc)
	usage := &pibridge.ContextUsage{Tokens: 1500.5, Window: 128000, Percent: 12.5, HasTokens: true, HasWindow: true, HasPercent: true}
	ready := &pibridge.Readiness{Idle: true}
	b.onState("pane-1", proc, 1, floor+1, false, true, "p/m",
		"", []string{"pi.lifecycle.v1", "pi.context.v1", "pi.compact.v1"}, usage, ready, nil)

	st := b.PaneSnapshot("pane-1")
	if st.ContextTokens == nil || *st.ContextTokens != 1500.5 || st.ContextWindow == nil || *st.ContextWindow != 128000 || st.ContextPercent == nil || *st.ContextPercent != 12.5 {
		t.Fatalf("HTTP context %+v", st)
	}
	if st.CompactIdle == nil || !*st.CompactIdle || st.CompactQueued == nil || *st.CompactQueued || st.CompactActive == nil || *st.CompactActive || st.CompactPending == nil || *st.CompactPending {
		t.Fatalf("HTTP readiness %+v", st)
	}
	frame := encodeBridgeState("pane-1", bridgeStateView{
		pubRev:    floor + 1,
		hasGen:    true,
		gen:       1,
		model:     "p/m",
		usage:     usage,
		readiness: ready,
	})
	if frame == nil {
		t.Fatal("no WS frame")
	}
	if frame.ContextTokens == nil || frame.GetContextTokens() != 1500.5 || frame.ContextWindow == nil || frame.GetContextWindow() != 128000 || frame.ContextPercent == nil || frame.GetContextPercent() != 12.5 {
		t.Fatalf("WS context %+v", frame)
	}
	if frame.CompactIdle == nil || !frame.GetCompactIdle() || frame.CompactQueued == nil || frame.GetCompactQueued() || frame.CompactActive == nil || frame.GetCompactActive() || frame.CompactPending == nil || frame.GetCompactPending() {
		t.Fatalf("WS readiness %+v", frame)
	}
	// Mutating views must not touch retained state.
	*st.ContextTokens = -1
	st2 := b.PaneSnapshot("pane-1")
	if *st2.ContextTokens != 1500.5 {
		t.Fatal("snapshot shares mutable telemetry with the bridge")
	}

	// Unknown telemetry omits every field, and explicit zero stays
	// present, never unknown.
	env2, _, _ := b.Provision("pane-2", true)
	proc2 := env2[piBridgeEnvProcess]
	floor2, _ := b.server.PublicationRevision(proc2)
	b.onState("pane-2", proc2, 1, floor2+1, false, true, "p/m", "", []string{"pi.lifecycle.v1"}, nil, nil, nil)
	stU := b.PaneSnapshot("pane-2")
	if stU.ContextTokens != nil || stU.ContextWindow != nil || stU.ContextPercent != nil || stU.CompactIdle != nil {
		t.Fatalf("unknown telemetry leaked %+v", stU)
	}
	raw, _ := json.Marshal(stU)
	if strings.Contains(string(raw), "context_tokens") || strings.Contains(string(raw), "compact_idle") {
		t.Fatalf("unknown telemetry serialized: %s", raw)
	}
	b.onState("pane-2", proc2, 1, floor2+2, false, true, "p/m", "", []string{"pi.lifecycle.v1", "pi.context.v1"},
		&pibridge.ContextUsage{Tokens: 0, HasTokens: true}, nil, nil)
	stZ := b.PaneSnapshot("pane-2")
	if stZ.ContextTokens == nil || *stZ.ContextTokens != 0 || stZ.ContextWindow != nil || stZ.CompactIdle != nil {
		t.Fatalf("zero telemetry %+v, want present zero tokens only", stZ)
	}

	// A delayed older publication cannot refresh stale telemetry.
	b.onState("pane-1", proc, 1, floor+1, false, true, "old/m", "",
		[]string{"pi.lifecycle.v1"}, &pibridge.ContextUsage{Tokens: 1, HasTokens: true}, &pibridge.Readiness{}, nil)
	stOld := b.PaneSnapshot("pane-1")
	if *stOld.ContextTokens != 1500.5 || stOld.Model != "p/m" || !*stOld.CompactIdle {
		t.Fatalf("stale publication refreshed %+v", stOld)
	}
	// A new generation clears old context with the old state.
	b.onState("pane-1", proc, 2, floor+2, false, false, "", "", []string{"pi.lifecycle.v1"}, nil, nil, nil)
	stGen := b.PaneSnapshot("pane-1")
	if stGen.ContextTokens != nil || stGen.CompactIdle != nil || stGen.Model != "" {
		t.Fatalf("new generation kept %+v", stGen)
	}
}

func TestBridgeRequestPaneCompact(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()

	var nilBridge *Bridge
	if _, err := nilBridge.RequestPaneCompact(ctx, "pane-1", 1, 1); err == nil {
		t.Fatal("nil bridge succeeded")
	}
	if _, err := b.RequestPaneCompact(ctx, "unknown", 1, 1); err == nil {
		t.Fatal("unknown pane succeeded")
	}
	b.Provision("pane-off", false)
	if _, err := b.RequestPaneCompact(ctx, "pane-off", 1, 1); err == nil {
		t.Fatal("unmanaged pane succeeded")
	}
	// A managed pane with no live peer fails without dispatch.
	b.Provision("pane-np", true)
	if _, err := b.RequestPaneCompact(ctx, "pane-np", 1, 1); err == nil {
		t.Fatal("peerless pane succeeded")
	}

	stream, cancel, _, rev := dialCompactPane(t, b, "pane-1")
	defer cancel()
	gen := uint64(1)
	revNum, _ := strconv.ParseUint(rev, 10, 64)
	type outcome struct {
		res pibridge.CompactResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		res, err := b.RequestPaneCompact(ctx, "pane-1", gen, revNum)
		done <- outcome{res: res, err: err}
	}()
	got := answerCompactOnce(t, stream, pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED, "")
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestPaneCompact: %v", o.err)
		}
		if o.res.RequestID != "1" || o.res.Outcome != pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED {
			t.Fatalf("result %+v", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestPaneCompact hung")
	}
	if got.id != "1" || got.session != "sess" || got.leaf != "leaf" || got.model == nil {
		t.Fatalf("wire fence %+v", got)
	}
}

func TestHandlePiBridgeCompactStatuses(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	// Unknown panes are unavailable before dispatch, with the fixed
	// rejected-before-start vocabulary and no allocated ID.
	rec := serveCompact(t, `{"pane":"unknown","generation":"1","telemetry_revision":"1"}`, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unknown pane code %d, want 503", rec.Code)
	}
	if body := decodeCompactBody(t, rec); body["outcome"] != "rejected-before-start" || body["request_id"] != "" {
		t.Fatalf("unknown pane body %v", body)
	}

	round := func(t *testing.T, pane, gen, rev string, outcome pibridgepb.CompactOutcome, reason string) (*httptest.ResponseRecorder, compactCanned) {
		t.Helper()
		stream, cancel, _, revStr := dialCompactPane(t, b, pane)
		t.Cleanup(cancel)
		req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact",
			strings.NewReader(fmt.Sprintf(`{"pane":%q,"generation":%q,"telemetry_revision":%q}`, pane, gen, revStr)))
		req.Host = "example.com"
		req.Header.Set("Content-Type", "application/json")
		_ = rev
		rec := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			handlePiBridgeCompact(rec, req)
			close(done)
		}()
		got := answerCompactOnce(t, stream, outcome, reason)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("handler hung")
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("Cache-Control %q, want no-store", rec.Header().Get("Cache-Control"))
		}
		return rec, got
	}

	// Completed work is 200 with the opaque server-allocated ID.
	rec, got := round(t, "pane-ok", "1", "", pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("completed code %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if body := decodeCompactBody(t, rec); body["outcome"] != "completed" || body["request_id"] != got.id || got.id == "" {
		t.Fatalf("completed body %v wire %+v", body, got)
	}
	if got.session != "sess" || got.leaf != "leaf" || got.model == nil || got.model.GetProvider() != "p" {
		t.Fatalf("wire fence %+v, want lease-derived identity", got)
	}
	// Host refusals are 409 with the safe reason and the ID.
	rec, got = round(t, "pane-ref", "1", "", pibridgepb.CompactOutcome_COMPACT_OUTCOME_REFUSED, "busy")
	if rec.Code != http.StatusConflict {
		t.Fatalf("host-refused code %d, want 409", rec.Code)
	}
	if body := decodeCompactBody(t, rec); body["outcome"] != "rejected-before-start" || body["reason"] != "busy" || body["request_id"] != got.id {
		t.Fatalf("host-refused body %v", body)
	}
	// Callback failures are 502 failed, never success, with fixed
	// words. Cancellation carries the safe cancelled reason.
	for _, tc := range []struct {
		outcome pibridgepb.CompactOutcome
		reason  string
		name    string
	}{
		{pibridgepb.CompactOutcome_COMPACT_OUTCOME_FAILED, "error", "failed"},
		{pibridgepb.CompactOutcome_COMPACT_OUTCOME_CANCELLED, "cancelled", "cancelled"},
		// A missing host reason on cancellation still reports
		// the safe cancelled word.
		{pibridgepb.CompactOutcome_COMPACT_OUTCOME_CANCELLED, "", "cancelled-empty"},
	} {
		rec, _ := round(t, "pane-"+tc.name, "1", "", tc.outcome, tc.reason)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("%s code %d, want 502", tc.name, rec.Code)
		}
		wantReason := tc.reason
		if wantReason == "" {
			wantReason = "cancelled"
		}
		if body := decodeCompactBody(t, rec); body["outcome"] != "failed" || body["reason"] != wantReason || body["request_id"] == "" {
			t.Fatalf("%s body %v", tc.name, body)
		}
	}
	// Broker refusals before dispatch are 409 with no allocated ID.
	stream, cancel, _, revStr := dialCompactPane(t, b, "pane-stale")
	defer cancel()
	rec = serveCompact(t, fmt.Sprintf(`{"pane":"pane-stale","generation":"9","telemetry_revision":%q}`, revStr), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale code %d, want 409", rec.Code)
	}
	if body := decodeCompactBody(t, rec); body["outcome"] != "rejected-before-start" || body["reason"] != "stale" || body["request_id"] != "" {
		t.Fatalf("stale body %v", body)
	}
	// The refused call allocated nothing: the next dispatch is "1".
	_ = stream
}

func TestHandlePiBridgeCompactRefusalAllocatesNothing(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	stream, cancel, _, revStr := dialCompactPane(t, b, "pane-1")
	defer cancel()
	// Stale, then busy-by-revision: both refuse before dispatch.
	rec := serveCompact(t, fmt.Sprintf(`{"pane":"pane-1","generation":"2","telemetry_revision":%q}`, revStr), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale code %d, want 409", rec.Code)
	}
	rec = serveCompact(t, `{"pane":"pane-1","generation":"1","telemetry_revision":"999999"}`, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("rev code %d, want 409", rec.Code)
	}
	// The next dispatch carries the first ID: refusals before send
	// cannot invoke the host or consume the sequence.
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact",
		strings.NewReader(fmt.Sprintf(`{"pane":"pane-1","generation":"1","telemetry_revision":%q}`, revStr)))
	req.Host = "example.com"
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handlePiBridgeCompact(rec, req)
		close(done)
	}()
	got := answerCompactOnce(t, stream, pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED, "")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler hung")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("code %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if got.id != "1" {
		t.Fatalf("id %q after refusals, want \"1\"", got.id)
	}
	if body := decodeCompactBody(t, rec); body["request_id"] != "1" {
		t.Fatalf("body %v", body)
	}
}

func TestHandlePiBridgeCompactUnknownAfterDispatch(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	// A caller abort after dispatch is unknown with the ID, never a
	// silent success and never unavailable-before-start.
	stream, cancel, _, revStr := dialCompactPane(t, b, "pane-abort")
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact",
		strings.NewReader(fmt.Sprintf(`{"pane":"pane-abort","generation":"1","telemetry_revision":%q}`, revStr)))
	req.Host = "example.com"
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handlePiBridgeCompact(rec, req)
		close(done)
	}()
	// Wait for the dispatch to land, then abort the caller wait.
	type res struct {
		msg *pibridgepb.PhiToPi
		err error
	}
	ch := make(chan res, 1)
	go func() {
		m, e := stream.Recv()
		ch <- res{msg: m, err: e}
	}()
	var id string
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("recv: %v", r.err)
		}
		id = r.msg.GetCompactRequest().GetRequestId()
	case <-time.After(5 * time.Second):
		t.Fatal("no dispatch")
	}
	stop()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler hung after abort")
	}
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("abort code %d, want 504: %s", rec.Code, rec.Body.String())
	}
	if body := decodeCompactBody(t, rec); body["outcome"] != "unknown" || body["request_id"] != id {
		t.Fatalf("abort body %v, want unknown for %s", body, id)
	}

	// Peer loss after dispatch stays unknown, not unavailable.
	stream2, cancel2, _, revStr2 := dialCompactPane(t, b, "pane-loss")
	defer cancel2()
	req2 := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact",
		strings.NewReader(fmt.Sprintf(`{"pane":"pane-loss","generation":"1","telemetry_revision":%q}`, revStr2)))
	req2.Host = "example.com"
	req2.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	done2 := make(chan struct{})
	go func() {
		handlePiBridgeCompact(rec2, req2)
		close(done2)
	}()
	ch2 := make(chan res, 1)
	go func() {
		m, e := stream2.Recv()
		ch2 <- res{msg: m, err: e}
	}()
	var id2 string
	select {
	case r := <-ch2:
		if r.err != nil {
			t.Fatalf("recv: %v", r.err)
		}
		id2 = r.msg.GetCompactRequest().GetRequestId()
	case <-time.After(5 * time.Second):
		t.Fatal("no dispatch")
	}
	cancel2() // drop only the bridge stream, not the process
	select {
	case <-done2:
	case <-time.After(5 * time.Second):
		t.Fatal("handler hung after peer loss")
	}
	if rec2.Code != http.StatusGatewayTimeout {
		t.Fatalf("loss code %d, want 504: %s", rec2.Code, rec2.Body.String())
	}
	if body := decodeCompactBody(t, rec2); body["outcome"] != "unknown" || body["request_id"] != id2 {
		t.Fatalf("loss body %v, want unknown for %s", body, id2)
	}
}

func TestHandlePiBridgeCompactValidation(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	if req := httptest.NewRequest(http.MethodGet, "/api/pi-bridge/compact", nil); true {
		rec := httptest.NewRecorder()
		handlePiBridgeCompact(rec, req)
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("GET code %d, want 405 no-store", rec.Code)
		}
	}
	bodies := []struct {
		name string
		body string
	}{
		{"empty", ``},
		{"bad-json", `{`},
		{"unknown-field", `{"pane":"p","generation":"1","telemetry_revision":"1","request_id":"9"}`},
		{"trailing", `{"pane":"p","generation":"1","telemetry_revision":"1"} {}`},
		{"trailing-close-object", `{"pane":"p","generation":"1","telemetry_revision":"1"}}`},
		{"trailing-close-array", `{"pane":"p","generation":"1","telemetry_revision":"1"}]`},
		{"trailing-string", `{"pane":"p","generation":"1","telemetry_revision":"1"} "x"`},
		{"trailing-null", `{"pane":"p","generation":"1","telemetry_revision":"1"} null`},
		{"trailing-number", `{"pane":"p","generation":"1","telemetry_revision":"1"} 7`},
		{"number-types", `{"pane":"p","generation":1,"telemetry_revision":1}`},
		{"missing-pane", `{"generation":"1","telemetry_revision":"1"}`},
		{"long-pane", fmt.Sprintf(`{"pane":%q,"generation":"1","telemetry_revision":"1"}`, strings.Repeat("p", 257))},
		{"zero-gen", `{"pane":"p","generation":"0","telemetry_revision":"1"}`},
		{"leading-zero", `{"pane":"p","generation":"01","telemetry_revision":"1"}`},
		{"negative", `{"pane":"p","generation":"-1","telemetry_revision":"1"}`},
		{"spaces", `{"pane":"p","generation":" 1","telemetry_revision":"1"}`},
		{"overflow", `{"pane":"p","generation":"18446744073709551616","telemetry_revision":"1"}`},
		{"empty-rev", `{"pane":"p","generation":"1","telemetry_revision":""}`},
		{"plus", `{"pane":"p","generation":"+1","telemetry_revision":"1"}`},
		{"oversize", fmt.Sprintf(`{"pane":%q,"generation":"1","telemetry_revision":"1"}`, strings.Repeat("p", 5000))},
	}
	for _, tc := range bodies {
		rec := serveCompact(t, tc.body, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s code %d, want 400: %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	// Wrong or missing content types are malformed.
	for _, ct := range []string{"", "text/plain", "application/jsonx"} {
		req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact", strings.NewReader(`{}`))
		req.Host = "example.com"
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		rec := httptest.NewRecorder()
		handlePiBridgeCompact(rec, req)
		if rec.Code != http.StatusBadRequest || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("content-type %q code %d, want 400 no-store", ct, rec.Code)
		}
	}
	// A charset suffix still parses as JSON.
	rec := serveCompact(t, `{"pane":"unknown","generation":"1","telemetry_revision":"1"}`, map[string]string{"Content-Type": "application/json; charset=utf-8"})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("charset code %d, want 503 past decoding", rec.Code)
	}
	// MaxUint64 parses; the broker then fences it as stale.
	rec = serveCompact(t, `{"pane":"unknown","generation":"18446744073709551615","telemetry_revision":"18446744073709551615"}`, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("maxuint code %d, want 503 past decoding", rec.Code)
	}
	// Bounded trailing whitespace passes decoding; the 4KiB limit
	// is exact, including bare whitespace past the object.
	valid := `{"pane":"unknown","generation":"1","telemetry_revision":"1"}`
	rec = serveCompact(t, valid+"  \n\t", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("trailing-space code %d, want 503 past decoding", rec.Code)
	}
	rec = serveCompact(t, valid+strings.Repeat(" ", piBridgeCompactMaxBody-len(valid)), nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("exact-boundary code %d, want 503 past decoding", rec.Code)
	}
	rec = serveCompact(t, valid+strings.Repeat(" ", piBridgeCompactMaxBody-len(valid)+1), nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("over-boundary code %d, want 400", rec.Code)
	}
}

func TestHandlePiBridgeCompactRejectsBeforeInvocation(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	stream, cancel, _, revStr := dialCompactPane(t, b, "pane-1")
	defer cancel()
	good := fmt.Sprintf(`{"pane":"pane-1","generation":"1","telemetry_revision":%q}`, revStr)
	// Malformed bodies never reach the broker: each is rejected
	// before any ID is allocated or any host work starts.
	for name, body := range map[string]string{
		"trailing-close": good + "}",
		"trailing-value": good + " {}",
		"oversize-space": good + strings.Repeat(" ", 5000),
		"unknown-field":  strings.Replace(good, `"telemetry_revision"`, `"request_id":"9","telemetry_revision"`, 1),
	} {
		rec := serveCompact(t, body, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s code %d, want 400", name, rec.Code)
		}
	}
	// The next valid dispatch carries the first ID: nothing above
	// invoked the host or consumed the sequence.
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact", strings.NewReader(good))
	req.Host = "example.com"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handlePiBridgeCompact(rec, req)
		close(done)
	}()
	got := answerCompactOnce(t, stream, pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED, "")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler hung")
	}
	if rec.Code != http.StatusOK || got.id != "1" {
		t.Fatalf("code %d id %q, want 200 \"1\"", rec.Code, got.id)
	}
}

func TestHandlePiBridgeCompactOrigin(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	// Unknown panes prove the origin check passed (503) or failed
	// (403) without needing a live peer.
	cases := []struct {
		name    string
		headers map[string]string
		want    int
	}{
		{"no-headers", nil, http.StatusServiceUnavailable},
		{"same-origin", map[string]string{"Origin": "http://example.com"}, http.StatusServiceUnavailable},
		{"same-origin-port", map[string]string{"Origin": "http://example.com:8080"}, http.StatusForbidden},
		{"cross-origin", map[string]string{"Origin": "http://evil.test"}, http.StatusForbidden},
		{"null-origin", map[string]string{"Origin": "null"}, http.StatusForbidden},
		{"malformed-origin", map[string]string{"Origin": "http://[::1"}, http.StatusForbidden},
		{"scheme-mismatch", map[string]string{"Origin": "https://example.com"}, http.StatusForbidden},
		{"origin-path", map[string]string{"Origin": "http://example.com/x"}, http.StatusForbidden},
		{"fetch-same-origin", map[string]string{"Sec-Fetch-Site": "same-origin"}, http.StatusServiceUnavailable},
		{"fetch-none", map[string]string{"Sec-Fetch-Site": "none"}, http.StatusServiceUnavailable},
		{"fetch-cross-site", map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		{"fetch-same-site", map[string]string{"Sec-Fetch-Site": "same-site"}, http.StatusForbidden},
		{"fetch-garbage", map[string]string{"Sec-Fetch-Site": "bogus"}, http.StatusForbidden},
	}
	for _, tc := range cases {
		rec := serveCompact(t, `{"pane":"unknown","generation":"1","telemetry_revision":"1"}`, tc.headers)
		if rec.Code != tc.want {
			t.Fatalf("%s code %d, want %d", tc.name, rec.Code, tc.want)
		}
	}
	// Port-aware hosts compare exactly.
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact", strings.NewReader(`{"pane":"unknown","generation":"1","telemetry_revision":"1"}`))
	req.Host = "example.com:8080"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://example.com:8080")
	rec := httptest.NewRecorder()
	handlePiBridgeCompact(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("port host code %d, want 503", rec.Code)
	}
	// TLS requests compare against https, never forwarded headers.
	tlsReq := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact", strings.NewReader(`{"pane":"unknown","generation":"1","telemetry_revision":"1"}`))
	tlsReq.Host = "example.com"
	tlsReq.TLS = &tls.ConnectionState{}
	tlsReq.Header.Set("Content-Type", "application/json")
	tlsReq.Header.Set("Origin", "https://example.com")
	tlsReq.Header.Set("X-Forwarded-Proto", "http")
	tlsRec := httptest.NewRecorder()
	handlePiBridgeCompact(tlsRec, tlsReq)
	if tlsRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("tls code %d, want 503", tlsRec.Code)
	}
	plainReq := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/compact", strings.NewReader(`{"pane":"unknown","generation":"1","telemetry_revision":"1"}`))
	plainReq.Host = "example.com"
	plainReq.Header.Set("Content-Type", "application/json")
	plainReq.Header.Set("Origin", "https://example.com")
	plainRec := httptest.NewRecorder()
	handlePiBridgeCompact(plainRec, plainReq)
	if plainRec.Code != http.StatusForbidden {
		t.Fatalf("plain https-origin code %d, want 403", plainRec.Code)
	}
}
