package pibridge

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

const (
	SyncboardReasonUnavailable     = "unavailable"
	SyncboardReasonInvalidRequest  = "invalid-request"
	SyncboardReasonInvalidConfig   = "invalid-config"
	SyncboardReasonNotReady        = "not-ready"
	SyncboardReasonBusy            = "busy"
	SyncboardReasonTimeout         = "timeout"
	SyncboardReasonCancelled       = "cancelled"
	SyncboardReasonTooLarge        = "too-large"
	SyncboardReasonInvalidResponse = "invalid-response"
	SyncboardReasonHTTPError       = "http-error"
	SyncboardReasonTransportError  = "transport-error"
)

// SyncboardHandler performs one fixed Syncboard operation for an authenticated
// peer. It receives no caller-selected URL or HTTP method. Configure it before
// serving the Server.
type SyncboardHandler func(context.Context, string, *pibridgepb.SyncboardRequest) *pibridgepb.SyncboardResponse

// syncboardRequestID accepts positive canonical decimal uint64 IDs only.
func syncboardRequestID(id string) (uint64, bool) {
	if id == "" || id[0] == '0' || len(id) > 20 {
		return 0, false
	}
	value, err := strconv.ParseUint(id, 10, 64)
	return value, err == nil && value > 0 && strconv.FormatUint(value, 10) == id
}

// validateSyncboardRequest rejects operation/input mismatches before coordinator
// work. The returned copy contains the API's normalized key.
func validateSyncboardRequest(req *pibridgepb.SyncboardRequest) (*pibridgepb.SyncboardRequest, string) {
	if req == nil {
		return nil, SyncboardReasonInvalidRequest
	}
	normalized := &pibridgepb.SyncboardRequest{
		RequestId: req.GetRequestId(),
		Operation: req.GetOperation(),
		Key:       req.GetKey(),
		ValueJson: append([]byte(nil), req.GetValueJson()...),
	}
	switch req.GetOperation() {
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_LIST:
		if req.GetKey() != "" || len(req.GetValueJson()) != 0 {
			return nil, SyncboardReasonInvalidRequest
		}
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET,
		pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE:
		key := strings.TrimSpace(req.GetKey())
		if !validSyncboardKey(key) || len(req.GetValueJson()) != 0 {
			return nil, SyncboardReasonInvalidRequest
		}
		normalized.Key = key
	case pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_UPSERT:
		key := strings.TrimSpace(req.GetKey())
		if !validSyncboardKey(key) || len(req.GetValueJson()) == 0 || len(req.GetValueJson()) > MaxSyncboardValueBytes || !json.Valid(req.GetValueJson()) {
			return nil, SyncboardReasonInvalidRequest
		}
		normalized.Key = key
	default:
		return nil, SyncboardReasonInvalidRequest
	}
	return normalized, ""
}

func validSyncboardKey(key string) bool {
	if key == "" || len(key) > 256 {
		return false
	}
	for _, segment := range strings.Split(key, "/") {
		if segment != "" && strings.Trim(segment, ".") == "" {
			return false
		}
	}
	return true
}

func syncboardReasonAllowed(reason string) bool {
	switch reason {
	case SyncboardReasonUnavailable, SyncboardReasonInvalidRequest, SyncboardReasonInvalidConfig,
		SyncboardReasonNotReady, SyncboardReasonBusy, SyncboardReasonTimeout, SyncboardReasonCancelled,
		SyncboardReasonTooLarge, SyncboardReasonInvalidResponse, SyncboardReasonHTTPError,
		SyncboardReasonTransportError:
		return true
	default:
		return false
	}
}

// normalizeSyncboardResponse enforces the bounded wire outcome contract. A
// malformed handler result becomes a safe unknown result, never false success.
func normalizeSyncboardResponse(id string, req *pibridgepb.SyncboardRequest, res *pibridgepb.SyncboardResponse) *pibridgepb.SyncboardResponse {
	unknown := func(reason string) *pibridgepb.SyncboardResponse {
		if !syncboardReasonAllowed(reason) {
			reason = SyncboardReasonTransportError
		}
		return &pibridgepb.SyncboardResponse{
			RequestId: id,
			Outcome:   pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN,
			Reason:    reason,
		}
	}
	if res == nil {
		return unknown(SyncboardReasonTransportError)
	}
	switch res.GetOutcome() {
	case pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT:
		if res.GetHttpStatus() != 0 || len(res.GetBodyJson()) != 0 || !syncboardReasonAllowed(res.GetReason()) {
			return unknown(SyncboardReasonInvalidResponse)
		}
		return &pibridgepb.SyncboardResponse{RequestId: id, Outcome: res.GetOutcome(), Reason: res.GetReason()}
	case pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_UNKNOWN:
		if res.GetHttpStatus() != 0 || len(res.GetBodyJson()) != 0 || !syncboardReasonAllowed(res.GetReason()) {
			return unknown(SyncboardReasonInvalidResponse)
		}
		return &pibridgepb.SyncboardResponse{RequestId: id, Outcome: res.GetOutcome(), Reason: res.GetReason()}
	case pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_HTTP_RESPONSE:
		status := res.GetHttpStatus()
		if status < 100 || status > 599 || req == nil {
			return unknown(SyncboardReasonInvalidResponse)
		}
		if status == http.StatusNotFound && (req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_GET || req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE) {
			if res.GetReason() != "" || len(res.GetBodyJson()) != 0 {
				return unknown(SyncboardReasonInvalidResponse)
			}
			return &pibridgepb.SyncboardResponse{RequestId: id, Outcome: res.GetOutcome(), HttpStatus: status}
		}
		if status != http.StatusOK {
			if res.GetReason() != SyncboardReasonHTTPError || len(res.GetBodyJson()) != 0 {
				return unknown(SyncboardReasonInvalidResponse)
			}
			return &pibridgepb.SyncboardResponse{
				RequestId: id, Outcome: res.GetOutcome(), HttpStatus: status, Reason: SyncboardReasonHTTPError,
			}
		}
		if res.GetReason() != "" {
			return unknown(SyncboardReasonInvalidResponse)
		}
		if req.GetOperation() == pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_DELETE {
			if len(res.GetBodyJson()) != 0 {
				return unknown(SyncboardReasonInvalidResponse)
			}
			return &pibridgepb.SyncboardResponse{RequestId: id, Outcome: res.GetOutcome(), HttpStatus: status}
		}
		if len(res.GetBodyJson()) == 0 || len(res.GetBodyJson()) > MaxSyncboardResponseBytes || !json.Valid(res.GetBodyJson()) {
			return unknown(SyncboardReasonInvalidResponse)
		}
		return &pibridgepb.SyncboardResponse{
			RequestId: id, Outcome: res.GetOutcome(), HttpStatus: status, BodyJson: append([]byte(nil), res.GetBodyJson()...),
		}
	default:
		return unknown(SyncboardReasonInvalidResponse)
	}
}

// admitSyncboard fences duplicate/old IDs and caps live work per peer. The
// high-water mark advances even when capacity is full, so a refused ID cannot
// later become a second dispatch.
func (p *peer) admitSyncboard(id uint64) (admitted, duplicate, busy bool) {
	select {
	case <-p.done:
		return false, false, false
	default:
	}
	p.syncboardMu.Lock()
	defer p.syncboardMu.Unlock()
	if id <= p.syncboardHighWater {
		return false, true, false
	}
	p.syncboardHighWater = id
	if len(p.syncboardPending) >= maxSyncboardPending {
		return false, false, true
	}
	p.syncboardPending[id] = struct{}{}
	return true, false, false
}

func (p *peer) finishSyncboard(id uint64) {
	p.syncboardMu.Lock()
	delete(p.syncboardPending, id)
	p.syncboardMu.Unlock()
}

func (s *Server) receiveSyncboard(l *lease, p *peer, req *pibridgepb.SyncboardRequest) {
	id, ok := syncboardRequestID(req.GetRequestId())
	if !ok {
		return
	}
	admitted, duplicate, busy := p.admitSyncboard(id)
	if duplicate || (!admitted && !busy) {
		return
	}
	pane, process, generation := l.paneID, l.processID, p.generation
	if busy {
		p.sendSyncboardNonfatal(syncboardEnvelope(pane, process, generation, &pibridgepb.SyncboardResponse{
			RequestId: req.GetRequestId(), Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT, Reason: SyncboardReasonBusy,
		}))
		return
	}
	respond := func(reason string) {
		defer p.finishSyncboard(id)
		p.sendSyncboardNonfatal(syncboardEnvelope(pane, process, generation, &pibridgepb.SyncboardResponse{
			RequestId: req.GetRequestId(), Outcome: pibridgepb.SyncboardOutcome_SYNCBOARD_OUTCOME_NOT_SENT, Reason: reason,
		}))
	}
	validated, reason := validateSyncboardRequest(req)
	if reason != "" {
		respond(reason)
		return
	}
	l.mu.Lock()
	current := l.peer == p && l.maxGen == generation && l.state != leaseRevoked
	capable := current && containsCapability(l.caps, CapabilitySyncboard)
	l.mu.Unlock()
	if !current {
		p.finishSyncboard(id)
		return
	}
	if s.syncboardHandler == nil || !capable {
		respond(SyncboardReasonUnavailable)
		return
	}
	handler := s.syncboardHandler
	go func() {
		defer p.finishSyncboard(id)
		if p.ctx.Err() != nil || !s.syncboardPeerCurrent(l, p) {
			return
		}
		result := normalizeSyncboardResponse(req.GetRequestId(), validated, handler(p.ctx, process, validated))
		if p.ctx.Err() != nil || !s.syncboardPeerCurrent(l, p) {
			return
		}
		p.sendSyncboardNonfatal(syncboardEnvelope(pane, process, generation, result))
	}()
}

func (s *Server) syncboardPeerCurrent(l *lease, p *peer) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.peer == p && l.maxGen == p.generation && l.state != leaseRevoked
}

func containsCapability(caps []string, want string) bool {
	for _, cap := range caps {
		if cap == want {
			return true
		}
	}
	return false
}

func syncboardEnvelope(pane, process string, generation uint64, response *pibridgepb.SyncboardResponse) *pibridgepb.PhiToPi {
	return &pibridgepb.PhiToPi{
		PaneId: pane, ProcessId: process, RuntimeGeneration: generation,
		Payload: &pibridgepb.PhiToPi_SyncboardResponse{SyncboardResponse: response},
	}
}
