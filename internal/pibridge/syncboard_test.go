package pibridge

import (
	"context"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func TestSyncboardRequestValidation(t *testing.T) {
	validList, reason := validateSyncboardRequest(&pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
	})
	if reason != "" || validList == nil {
		t.Fatalf("valid list rejected: %q", reason)
	}
	for _, operation := range []pibridgepb.SyncboardOperation{
		pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET,
		pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE,
	} {
		validKey, reason := validateSyncboardRequest(&pibridgepb.SyncboardRequest{
			Operation: operation,
			Key:       "  card/a  ",
		})
		if reason != "" || validKey.GetKey() != "card/a" {
			t.Fatalf("valid operation %s rejected: %+v, %q", operation, validKey, reason)
		}
	}
	for _, value := range []string{"null", "false", "0", `""`} {
		validUpsert, reason := validateSyncboardRequest(&pibridgepb.SyncboardRequest{
			Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT,
			Key:       "  card/a  ",
			ValueJson: []byte(value),
		})
		if reason != "" || validUpsert.GetKey() != "card/a" || string(validUpsert.GetValueJson()) != value {
			t.Fatalf("valid upsert %s = %+v, reason %q", value, validUpsert, reason)
		}
	}

	invalid := []*pibridgepb.SyncboardRequest{
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST, Key: "not-empty"},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT, Key: " ", ValueJson: []byte("null")},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT, Key: "a/../b", ValueJson: []byte("null")},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT, Key: "a", ValueJson: []byte("not-json")},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT, Key: "a"},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST, ValueJson: []byte("null")},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET, Key: "a", ValueJson: []byte("null")},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE},
		{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE, Key: "a", ValueJson: []byte("null")},
	}
	for _, req := range invalid {
		if _, reason := validateSyncboardRequest(req); reason != SyncboardReasonInvalidRequest {
			t.Errorf("request %+v reason = %q", req, reason)
		}
	}
	if _, reason := validateSyncboardRequest(&pibridgepb.SyncboardRequest{
		Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT,
		Key:       "a",
		ValueJson: []byte(`"` + strings.Repeat("x", MaxSyncboardValueBytes) + `"`),
	}); reason != SyncboardReasonInvalidRequest {
		t.Fatalf("oversized value reason = %q", reason)
	}
}

func TestSyncboardResponseOperationSemantics(t *testing.T) {
	cases := []struct {
		name     string
		request  *pibridgepb.SyncboardRequest
		response *pibridgepb.SyncboardResponse
		status   uint32
		body     string
		valid    bool
	}{
		{
			name:    "get not found",
			request: &pibridgepb.SyncboardRequest{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET},
			response: &pibridgepb.SyncboardResponse{
				Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE, HttpStatus: 404,
			},
			status: 404, valid: true,
		},
		{
			name:    "delete empty success",
			request: &pibridgepb.SyncboardRequest{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE},
			response: &pibridgepb.SyncboardResponse{
				Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE, HttpStatus: 200,
			},
			status: 200, valid: true,
		},
		{
			name:    "list cannot use not found result",
			request: &pibridgepb.SyncboardRequest{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST},
			response: &pibridgepb.SyncboardResponse{
				Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE, HttpStatus: 404,
			},
			valid: false,
		},
		{
			name:    "delete requires empty success body",
			request: &pibridgepb.SyncboardRequest{Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE},
			response: &pibridgepb.SyncboardResponse{
				Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE, HttpStatus: 200, BodyJson: []byte("[]"),
			},
			valid: false,
		},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got := normalizeSyncboardResponse("1", item.request, item.response)
			if item.valid {
				if got.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE || got.GetHttpStatus() != item.status || string(got.GetBodyJson()) != item.body {
					t.Fatalf("normalized response = %v", got)
				}
				return
			}
			if got.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN || got.GetReason() != SyncboardReasonInvalidResponse {
				t.Fatalf("malformed response = %v", got)
			}
		})
	}
}

func TestSyncboardRequestIDAndHighWater(t *testing.T) {
	for _, id := range []string{"", "0", "01", "+1", "1x", "18446744073709551616"} {
		if _, ok := syncboardRequestID(id); ok {
			t.Errorf("accepted noncanonical id %q", id)
		}
	}
	if got, ok := syncboardRequestID("18446744073709551615"); !ok || got != ^uint64(0) {
		t.Fatalf("max uint64 id = %d, %v", got, ok)
	}
	p := newPeer(1, "s", nil)
	if admitted, duplicate, busy := p.admitSyncboard(1); !admitted || duplicate || busy {
		t.Fatalf("first admission = %v %v %v", admitted, duplicate, busy)
	}
	for id := uint64(2); id <= maxSyncboardPending; id++ {
		if admitted, _, _ := p.admitSyncboard(id); !admitted {
			t.Fatalf("request %d not admitted", id)
		}
	}
	if admitted, duplicate, busy := p.admitSyncboard(5); admitted || duplicate || !busy {
		t.Fatalf("fifth admission = %v %v %v", admitted, duplicate, busy)
	}
	if admitted, duplicate, busy := p.admitSyncboard(4); admitted || !duplicate || busy {
		t.Fatalf("duplicate admission = %v %v %v", admitted, duplicate, busy)
	}
	p.finishSyncboard(1)
	if admitted, duplicate, busy := p.admitSyncboard(5); admitted || !duplicate || busy {
		t.Fatalf("old ID retried after completion = %v %v %v", admitted, duplicate, busy)
	}
}

func TestSyncboardHandlerCapabilityAndAsyncLifecycle(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	started := make(chan struct{}, maxSyncboardPending)
	release := make(chan struct{})
	var handled atomic.Int32
	s.SetSyncboardHandler(func(_ context.Context, _ string, _ *pibridgepb.SyncboardRequest) *pibridgepb.SyncboardResponse {
		handled.Add(1)
		started <- struct{}{}
		<-release
		return &pibridgepb.SyncboardResponse{
			Outcome:    pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE,
			HttpStatus: 200, BodyJson: []byte("[]"),
		}
	})
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-sb-live", CapabilityLifecycle, CapabilitySyncboard)
	defer cancel()
	state, ok := s.PaneState(proc)
	if !ok || !slices.Contains(state.Caps, CapabilitySyncboard) {
		t.Fatalf("Syncboard not negotiated: %+v", state.Caps)
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-sb-live", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_SyncboardRequest{SyncboardRequest: &pibridgepb.SyncboardRequest{
			RequestId: "1", Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not start")
	}
	// The stream reader remains available while the coordinator worker waits.
	for _, id := range []string{"1", "2", "3", "4"} {
		if id == "1" {
			// Repeated IDs must not dispatch a second mutation.
			if err := stream.Send(&pibridgepb.PiToPhi{
				PaneId: "pane-sb-live", ProcessId: proc, RuntimeGeneration: 1,
				Payload: &pibridgepb.PiToPhi_SyncboardRequest{SyncboardRequest: &pibridgepb.SyncboardRequest{
					RequestId: id, Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
				}},
			}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := stream.Send(&pibridgepb.PiToPhi{
			PaneId: "pane-sb-live", ProcessId: proc, RuntimeGeneration: 1,
			Payload: &pibridgepb.PiToPhi_SyncboardRequest{SyncboardRequest: &pibridgepb.SyncboardRequest{
				RequestId: id, Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	for range maxSyncboardPending - 1 {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("bounded Syncboard workers did not start")
		}
	}
	if got := handled.Load(); got != maxSyncboardPending {
		t.Fatalf("duplicate or excess handler calls = %d", got)
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-sb-live", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_SyncboardRequest{SyncboardRequest: &pibridgepb.SyncboardRequest{
			RequestId: "5", Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	busy := recvSyncboardResponse(t, stream)
	if busy.GetRequestId() != "5" || busy.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT || busy.GetReason() != SyncboardReasonBusy {
		t.Fatalf("fifth pending response = %v", busy)
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-sb-live", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_AgentStarted{AgentStarted: &pibridgepb.AgentStarted{EventSequence: 1, RunId: 1}},
	}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		state, _ = s.PaneState(proc)
		if state.JournalLast == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if state.JournalLast != 1 {
		t.Fatal("lifecycle edge stalled behind Syncboard worker")
	}
	close(release)
	responses := make(map[string]*pibridgepb.SyncboardResponse, maxSyncboardPending)
	for range maxSyncboardPending {
		response := recvSyncboardResponse(t, stream)
		responses[response.GetRequestId()] = response
	}
	for _, id := range []string{"1", "2", "3", "4"} {
		response := responses[id]
		if response == nil || response.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE {
			t.Fatalf("response %s = %v", id, response)
		}
	}
	if handled.Load() != maxSyncboardPending {
		t.Fatalf("handler calls = %d", handled.Load())
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-sb-live", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_SyncboardRequest{SyncboardRequest: &pibridgepb.SyncboardRequest{
			RequestId: "6", Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT, Key: "missing-value",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	invalid := recvSyncboardResponse(t, stream)
	if invalid.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT || invalid.GetReason() != SyncboardReasonInvalidRequest {
		t.Fatalf("invalid request response = %v", invalid)
	}
	if handled.Load() != maxSyncboardPending {
		t.Fatalf("invalid request reached handler: %d calls", handled.Load())
	}
}

func TestSyncboardWithoutHandlerDoesNotNegotiateOrDispatch(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	stream, proc, _, cancel := openLeaseStream(t, s, sock, "pane-sb-off", CapabilityLifecycle, CapabilitySyncboard)
	defer cancel()
	state, ok := s.PaneState(proc)
	if !ok || slices.Contains(state.Caps, CapabilitySyncboard) {
		t.Fatalf("unconfigured server accepted capability: %+v", state.Caps)
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-sb-off", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_SyncboardRequest{SyncboardRequest: &pibridgepb.SyncboardRequest{
			RequestId: "1", Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	response := recvSyncboardResponse(t, stream)
	if response.GetOutcome() != pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT || response.GetReason() != SyncboardReasonUnavailable {
		t.Fatalf("unconfigured response = %v", response)
	}
}

func recvSyncboardResponse(t *testing.T, stream pibridgepb.Integration_ConnectClient) *pibridgepb.SyncboardResponse {
	t.Helper()
	type result struct {
		msg *pibridgepb.PhiToPi
		err error
	}
	ch := make(chan result, 1)
	go func() {
		msg, err := stream.Recv()
		ch <- result{msg: msg, err: err}
	}()
	select {
	case got := <-ch:
		if got.err != nil {
			t.Fatalf("receive Syncboard response: %v", got.err)
		}
		if got.msg.GetSyncboardResponse() == nil {
			t.Fatalf("unexpected bridge message: %v", got.msg.GetPayload())
		}
		return got.msg.GetSyncboardResponse()
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Syncboard response")
		return nil
	}
}
