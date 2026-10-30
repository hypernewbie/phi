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

// dialReloadPane provisions a managed pane and opens an accepted idle
// stream with lifecycle+reload capabilities and idle reload readiness.
// It returns the stream, cancel, process ID, and the canonical stamps
// for requests.
func dialReloadPane(t *testing.T, b *Bridge, pane string) (pibridgepb.Integration_ConnectClient, context.CancelFunc, string, string) {
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
			Capabilities: []string{"pi.lifecycle.v1", "pi.context.v1", "pi.reload.v1"},
			CurrentState: &pibridgepb.StateSnapshot{
				State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess", LeafId: "leaf",
				Model: &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
				ReloadReadiness: &pibridgepb.ReloadReadiness{
					RunId: uptrMain(0), ContextRevision: uptrMain(0), Idle: true,
				},
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

func uptrMain(u uint64) *uint64 { return &u }

type reloadCanned struct {
	id              string
	session, leaf   string
	model           *pibridgepb.ModelSnapshot
	run, contextRev uint64
	hasCounters     bool
}

// answerReloadOnce receives one Reload request, answers it with the
// canned outcome, and reports what the server fenced on the wire.
func answerReloadOnce(t *testing.T, stream pibridgepb.Integration_ConnectClient, outcome pibridgepb.ReloadDispatchOutcome, reason string) reloadCanned {
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
			t.Fatalf("recv reload request: %v", r.err)
		}
		req := r.msg.GetReloadRequest()
		if req == nil {
			t.Fatalf("not a reload request: %v", r.msg.GetPayload())
		}
		got := reloadCanned{id: req.GetRequestId(), session: req.GetExpectedSessionId(), leaf: req.GetExpectedLeafId(), model: req.GetExpectedModel()}
		if req.ExpectedRunId != nil && req.ExpectedContextRevision != nil {
			got.run, got.contextRev = *req.ExpectedRunId, *req.ExpectedContextRevision
			got.hasCounters = true
		}
		if err := stream.Send(&pibridgepb.PiToPhi{
			PaneId: r.msg.GetPaneId(), ProcessId: r.msg.GetProcessId(), RuntimeGeneration: r.msg.GetRuntimeGeneration(),
			Payload: &pibridgepb.PiToPhi_ReloadAck{ReloadAck: &pibridgepb.ReloadAck{
				RequestId: got.id, Outcome: outcome, Reason: reason,
			}},
		}); err != nil {
			t.Fatalf("send reload ack: %v", err)
		}
		return got
	case <-ctx.Done():
		t.Fatalf("timed out waiting for reload request")
		return reloadCanned{}
	}
}

func serveReload(t *testing.T, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/reload", strings.NewReader(body))
	req.Host = "example.com"
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handlePiBridgeReload(rec, req)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control %q, want no-store", rec.Header().Get("Cache-Control"))
	}
	return rec
}

func decodeReloadBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func reloadBody(pane, proc, gen, rev, run, contextRev string) string {
	return fmt.Sprintf(`{"pane":%q,"process_id":%q,"generation":%q,"telemetry_revision":%q,"run_id":%q,"context_revision":%q}`,
		pane, proc, gen, rev, run, contextRev)
}

func TestBridgeReloadTelemetryViews(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	env, _, managed := b.Provision("pane-1", true)
	if !managed {
		t.Fatal("provision not managed")
	}
	proc := env[piBridgeEnvProcess]
	floor, _ := b.server.PublicationRevision(proc)
	ready := &pibridge.ReloadReadiness{
		RunID: 0, HasRunID: true, ContextRevision: 0, HasContextRevision: true,
		Idle: true, ReloadPending: true, HighWater: 3, HasHighWater: true,
	}
	b.onState("pane-1", proc, 1, floor+1, false, true, "p/m",
		"", []string{"pi.lifecycle.v1", "pi.reload.v1"}, nil, nil, ready)

	st := b.PaneSnapshot("pane-1")
	if st.ProcessID != proc {
		t.Fatalf("process_id %q, want %q", st.ProcessID, proc)
	}
	// Explicit zero counters are present, never unknown.
	if st.RunID != "0" || st.ContextRevision != "0" {
		t.Fatalf("run/context %q/%q, want explicit zero", st.RunID, st.ContextRevision)
	}
	if st.ReloadIdle == nil || !*st.ReloadIdle || st.ReloadQueued == nil || *st.ReloadQueued {
		t.Fatalf("reload idle/queued %+v, want true/false", st)
	}
	if st.ReloadPending == nil || !*st.ReloadPending {
		t.Fatalf("reload pending %+v, want true", st.ReloadPending)
	}
	if st.ReloadHighWater != "3" {
		t.Fatalf("high-water %q, want 3", st.ReloadHighWater)
	}
	// Absent readiness omits the whole group; the process nonce stays.
	b.onState("pane-1", proc, 1, floor+2, false, true, "p/m",
		"", []string{"pi.lifecycle.v1"}, nil, nil, nil)
	st = b.PaneSnapshot("pane-1")
	if st.ProcessID != proc {
		t.Fatalf("process_id %q, want %q", st.ProcessID, proc)
	}
	if st.RunID != "" || st.ContextRevision != "" || st.ReloadIdle != nil || st.ReloadHighWater != "" {
		t.Fatalf("absent reload telemetry leaked: %+v", st)
	}
}

func TestBridgeRequestPaneReload(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()

	var nilBridge *Bridge
	if _, err := nilBridge.RequestPaneReload(ctx, "pane-1", "proc", 1, 1, 0, 0); err == nil {
		t.Fatal("nil bridge succeeded")
	}
	if _, err := b.RequestPaneReload(ctx, "unknown", "proc", 1, 1, 0, 0); err == nil {
		t.Fatal("unknown pane succeeded")
	} else if r, ok := err.(*pibridge.ReloadRefusal); !ok || r.Reason != "stale" {
		t.Fatalf("unknown pane err %v, want stale refusal", err)
	}
	b.Provision("pane-off", false)
	if _, err := b.RequestPaneReload(ctx, "pane-off", "proc", 1, 1, 0, 0); err == nil {
		t.Fatal("unmanaged pane succeeded")
	}
	// A managed pane with no live peer fails without dispatch.
	b.Provision("pane-np", true)
	if _, err := b.RequestPaneReload(ctx, "pane-np", "noprocess", 1, 1, 0, 0); err == nil {
		t.Fatal("peerless pane succeeded")
	}

	stream, cancel, proc, rev := dialReloadPane(t, b, "pane-1")
	defer cancel()
	if _, err := b.RequestPaneReload(ctx, "pane-1", "other-process", 1, 1, 0, 0); err == nil {
		t.Fatal("process mismatch succeeded")
	} else if r, ok := err.(*pibridge.ReloadRefusal); !ok || r.Reason != "stale" {
		t.Fatalf("mismatch err %v, want stale refusal", err)
	}
	revNum, _ := strconv.ParseUint(rev, 10, 64)
	type outcome struct {
		res pibridge.ReloadResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		res, err := b.RequestPaneReload(ctx, "pane-1", proc, 1, revNum, 0, 0)
		done <- outcome{res: res, err: err}
	}()
	got := answerReloadOnce(t, stream, pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED, "")
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatalf("RequestPaneReload: %v", o.err)
		}
		if o.res.RequestID != "1" || o.res.Outcome != pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED {
			t.Fatalf("result %+v", o.res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestPaneReload hung")
	}
	if got.id != "1" || got.session != "sess" || got.leaf != "leaf" || got.model == nil {
		t.Fatalf("wire fence %+v", got)
	}
	if !got.hasCounters || got.run != 0 || got.contextRev != 0 {
		t.Fatalf("wire counters %+v, want explicit 0/0", got)
	}
}

func TestHandlePiBridgeReloadStatuses(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	// Unknown panes name a target that moved on: stale, with no ID.
	rec := serveReload(t, reloadBody("unknown", "proc", "1", "1", "0", "0"), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("unknown pane code %d, want 409", rec.Code)
	}
	if body := decodeReloadBody(t, rec); body["outcome"] != "rejected-before-start" || body["reason"] != "stale" || body["request_id"] != "" {
		t.Fatalf("unknown pane body %v", body)
	}

	// A managed pane with no live peer is unavailable before
	// dispatch, with the safe reason and no ID.
	b.Provision("pane-np", true)
	rec = serveReload(t, reloadBody("pane-np", "noprocess", "1", "1", "0", "0"), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("peerless pane code %d, want 409 stale process", rec.Code)
	}

	round := func(t *testing.T, pane string, outcome pibridgepb.ReloadDispatchOutcome, reason string) (*httptest.ResponseRecorder, reloadCanned) {
		t.Helper()
		stream, cancel, proc, revStr := dialReloadPane(t, b, pane)
		t.Cleanup(cancel)
		req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/reload",
			strings.NewReader(reloadBody(pane, proc, "1", revStr, "0", "0")))
		req.Host = "example.com"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			handlePiBridgeReload(rec, req)
			close(done)
		}()
		got := answerReloadOnce(t, stream, outcome, reason)
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

	// Dispatched work is 202 with the opaque server-allocated ID
	// and no reason: entry evidence, never completion.
	rec, got := round(t, "pane-ok", pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED, "")
	if rec.Code != http.StatusAccepted {
		t.Fatalf("dispatched code %d, want 202: %s", rec.Code, rec.Body.String())
	}
	if body := decodeReloadBody(t, rec); body["outcome"] != "dispatched" || body["request_id"] != got.id || got.id == "" || body["reason"] != "" {
		t.Fatalf("dispatched body %v wire %+v", body, got)
	}
	if got.session != "sess" || got.leaf != "leaf" || got.model == nil || got.model.GetProvider() != "p" {
		t.Fatalf("wire fence %+v, want lease-derived identity", got)
	}
	// Host refusals are 409 with the safe reason and the ID.
	rec, got = round(t, "pane-ref", pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED, "busy")
	if rec.Code != http.StatusConflict {
		t.Fatalf("host-refused code %d, want 409", rec.Code)
	}
	if body := decodeReloadBody(t, rec); body["outcome"] != "rejected-before-start" || body["reason"] != "busy" || body["request_id"] != got.id {
		t.Fatalf("host-refused body %v", body)
	}
	// A hostile host reason coerces to empty, never an error.
	rec, _ = round(t, "pane-hostile", pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED, "injected\ntext")
	if rec.Code != http.StatusConflict {
		t.Fatalf("hostile code %d, want 409", rec.Code)
	}
	if body := decodeReloadBody(t, rec); body["reason"] != "" {
		t.Fatalf("hostile body %v, want empty reason", body)
	}

	// A stale run stamp refuses before dispatch with no ID.
	stream, cancel, proc, revStr := dialReloadPane(t, b, "pane-stale")
	defer cancel()
	_ = stream
	rec = serveReload(t, reloadBody("pane-stale", proc, "1", revStr, "9", "0"), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale code %d, want 409", rec.Code)
	}
	if body := decodeReloadBody(t, rec); body["outcome"] != "rejected-before-start" || body["reason"] != "stale" || body["request_id"] != "" {
		t.Fatalf("stale body %v", body)
	}
}

func TestHandlePiBridgeReloadUnknownAfterDispatch(t *testing.T) {
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
	stream, cancel, proc, revStr := dialReloadPane(t, b, "pane-abort")
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/reload",
		strings.NewReader(reloadBody("pane-abort", proc, "1", revStr, "0", "0")))
	req.Host = "example.com"
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handlePiBridgeReload(rec, req)
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
		id = r.msg.GetReloadRequest().GetRequestId()
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
	if body := decodeReloadBody(t, rec); body["outcome"] != "unknown" || body["request_id"] != id {
		t.Fatalf("abort body %v, want unknown for %s", body, id)
	}

	// Peer loss after dispatch stays unknown, not unavailable.
	stream2, cancel2, proc2, revStr2 := dialReloadPane(t, b, "pane-loss")
	defer cancel2()
	req2 := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/reload",
		strings.NewReader(reloadBody("pane-loss", proc2, "1", revStr2, "0", "0")))
	req2.Host = "example.com"
	req2.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	done2 := make(chan struct{})
	go func() {
		handlePiBridgeReload(rec2, req2)
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
		id2 = r.msg.GetReloadRequest().GetRequestId()
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
	if body := decodeReloadBody(t, rec2); body["outcome"] != "unknown" || body["request_id"] != id2 {
		t.Fatalf("loss body %v, want unknown for %s", body, id2)
	}
}

func TestHandlePiBridgeReloadValidation(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	if req := httptest.NewRequest(http.MethodGet, "/api/pi-bridge/reload", nil); true {
		rec := httptest.NewRecorder()
		handlePiBridgeReload(rec, req)
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("GET code %d, want 405 no-store", rec.Code)
		}
	}
	base := reloadBody("p", "proc", "1", "1", "0", "0")
	bodies := []struct {
		name string
		body string
	}{
		{"empty", ``},
		{"bad-json", `{`},
		{"unknown-field", strings.Replace(base, `"run_id"`, `"request_id":"9","run_id"`, 1)},
		{"trailing", base + ` {}`},
		{"trailing-close-object", base + `}`},
		{"trailing-close-array", base + `]`},
		{"trailing-string", base + ` "x"`},
		{"trailing-null", base + ` null`},
		{"trailing-number", base + ` 7`},
		{"number-types", `{"pane":"p","process_id":"proc","generation":1,"telemetry_revision":1,"run_id":0,"context_revision":0}`},
		{"missing-pane", reloadBody("", "proc", "1", "1", "0", "0")},
		{"missing-process", reloadBody("p", "", "1", "1", "0", "0")},
		{"long-pane", reloadBody(strings.Repeat("p", 257), "proc", "1", "1", "0", "0")},
		{"long-process", reloadBody("p", strings.Repeat("p", 257), "1", "1", "0", "0")},
		{"zero-gen", reloadBody("p", "proc", "0", "1", "0", "0")},
		{"leading-zero", reloadBody("p", "proc", "01", "1", "0", "0")},
		{"negative", reloadBody("p", "proc", "-1", "1", "0", "0")},
		{"spaces", reloadBody("p", "proc", " 1", "1", "0", "0")},
		{"overflow", reloadBody("p", "proc", "18446744073709551616", "1", "0", "0")},
		{"empty-rev", reloadBody("p", "proc", "1", "", "0", "0")},
		{"plus", reloadBody("p", "proc", "+1", "1", "0", "0")},
		{"empty-run", reloadBody("p", "proc", "1", "1", "", "0")},
		{"run-leading-zero", reloadBody("p", "proc", "1", "1", "00", "0")},
		{"run-negative", reloadBody("p", "proc", "1", "1", "-1", "0")},
		{"run-overflow", reloadBody("p", "proc", "1", "1", "18446744073709551616", "0")},
		{"empty-context", reloadBody("p", "proc", "1", "1", "0", "")},
		{"context-plus", reloadBody("p", "proc", "1", "1", "0", "+0")},
		{"oversize", reloadBody(strings.Repeat("p", 5000), "proc", "1", "1", "0", "0")},
	}
	for _, tc := range bodies {
		rec := serveReload(t, tc.body, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s code %d, want 400: %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	// Wrong or missing content types are malformed.
	for _, ct := range []string{"", "text/plain", "application/jsonx"} {
		req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/reload", strings.NewReader(`{}`))
		req.Host = "example.com"
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		rec := httptest.NewRecorder()
		handlePiBridgeReload(rec, req)
		if rec.Code != http.StatusBadRequest || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("content-type %q code %d, want 400 no-store", ct, rec.Code)
		}
	}
	// A charset suffix still parses as JSON; the unknown pane then
	// refuses stale past decoding.
	rec := serveReload(t, reloadBody("unknown", "proc", "1", "1", "0", "0"), map[string]string{"Content-Type": "application/json; charset=utf-8"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("charset code %d, want 409 past decoding", rec.Code)
	}
	// MaxUint64 parses; the broker then fences it as stale.
	rec = serveReload(t, reloadBody("p", "proc", "18446744073709551615", "18446744073709551615", "18446744073709551615", "18446744073709551615"), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("maxuint code %d, want 409 past decoding", rec.Code)
	}
	// Bounded trailing whitespace passes decoding; the 4KiB limit
	// is exact, including bare whitespace past the object.
	valid := reloadBody("unknown", "proc", "1", "1", "0", "0")
	rec = serveReload(t, valid+"  \n\t", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("trailing-space code %d, want 409 past decoding", rec.Code)
	}
	rec = serveReload(t, valid+strings.Repeat(" ", piBridgeReloadMaxBody-len(valid)), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("exact-boundary code %d, want 409 past decoding", rec.Code)
	}
	rec = serveReload(t, valid+strings.Repeat(" ", piBridgeReloadMaxBody-len(valid)+1), nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("over-boundary code %d, want 400", rec.Code)
	}
}

func TestHandlePiBridgeReloadRejectsBeforeInvocation(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	stream, cancel, proc, revStr := dialReloadPane(t, b, "pane-1")
	defer cancel()
	good := reloadBody("pane-1", proc, "1", revStr, "0", "0")
	// Malformed bodies never reach the broker: each is rejected
	// before any ID is allocated or any host work starts.
	for name, body := range map[string]string{
		"trailing-close": good + "}",
		"trailing-value": good + " {}",
		"oversize-space": good + strings.Repeat(" ", 5000),
		"unknown-field":  strings.Replace(good, `"run_id"`, `"request_id":"9","run_id"`, 1),
	} {
		rec := serveReload(t, body, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s code %d, want 400", name, rec.Code)
		}
	}
	// The next valid dispatch carries the first ID: nothing above
	// invoked the host or consumed the sequence.
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/reload", strings.NewReader(good))
	req.Host = "example.com"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handlePiBridgeReload(rec, req)
		close(done)
	}()
	got := answerReloadOnce(t, stream, pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED, "")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler hung")
	}
	if rec.Code != http.StatusAccepted || got.id != "1" {
		t.Fatalf("code %d id %q, want 202 \"1\"", rec.Code, got.id)
	}
}

func TestHandlePiBridgeReloadOrigin(t *testing.T) {
	b := startPiBridge(testBridgeHub())
	if b == nil {
		t.Fatal("bridge did not start")
	}
	defer b.Stop()
	prev := piBridge
	piBridge = b
	t.Cleanup(func() { piBridge = prev })

	good := reloadBody("unknown", "proc", "1", "1", "0", "0")
	// Same-origin navigation passes; the unknown pane then refuses
	// stale past the gate.
	rec := serveReload(t, good, map[string]string{"Origin": "http://example.com"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("same-origin code %d, want 409", rec.Code)
	}
	rec = serveReload(t, good, map[string]string{"Sec-Fetch-Site": "same-origin"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("fetch-site code %d, want 409", rec.Code)
	}
	// Cross-origin, opaque, and malformed origins are forbidden.
	for name, headers := range map[string]map[string]string{
		"cross-origin": {"Origin": "http://evil.example"},
		"scheme":       {"Origin": "https://example.com"},
		"null":         {"Origin": "null"},
		"fetch-site":   {"Sec-Fetch-Site": "cross-site"},
	} {
		rec := serveReload(t, good, headers)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s code %d, want 403", name, rec.Code)
		}
	}
	// TLS requests require the https origin.
	tlsReq := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/reload", strings.NewReader(good))
	tlsReq.Host = "example.com"
	tlsReq.TLS = &tls.ConnectionState{}
	tlsReq.Header.Set("Content-Type", "application/json")
	tlsReq.Header.Set("Origin", "http://example.com")
	tlsRec := httptest.NewRecorder()
	handlePiBridgeReload(tlsRec, tlsReq)
	if tlsRec.Code != http.StatusForbidden {
		t.Fatalf("tls downgrade code %d, want 403", tlsRec.Code)
	}
}
