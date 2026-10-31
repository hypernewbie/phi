package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// piBridgeReloadTimeout bounds one Reload caller wait. A timeout is
// an unknown outcome, never cancellation of native work and never
// permission to replay.
const piBridgeReloadTimeout = 30 * time.Second

// piBridgeReloadMaxBody bounds the Reload request body.
const piBridgeReloadMaxBody = 4096

// handlePiBridgeReload runs Pi's fixed native /reload command under
// the existing API auth gate. The body carries only the pane, the
// process nonce, and the browser's expected generation, publication,
// run, and context stamps; every host identity is derived
// server-side under the admission fence. Route-local
// same-origin/Fetch-Metadata checks apply even when access auth is
// disabled, because reload replaces the live extension runtime.
//
// Outcomes use exactly three safe words, never raw errors: dispatched
// (202, native callback entered, not completion),
// rejected-before-start (409, or 503 when unavailable before
// dispatch), and unknown (504, dispatched but unresolved).
// Malformed, forbidden, and wrong-method requests are 400, 403, and
// 405. Nothing here is cached.
func handlePiBridgeReload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !compactSameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var body struct {
		Pane              string `json:"pane"`
		ProcessID         string `json:"process_id"`
		Generation        string `json:"generation"`
		TelemetryRevision string `json:"telemetry_revision"`
		RunID             string `json:"run_id"`
		ContextRevision   string `json:"context_revision"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, piBridgeReloadMaxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// The document must end after the single object: trailing
	// delimiters, extra values, and over-limit bodies (including
	// bare whitespace past 4KiB) all fail here. Only a clean EOF
	// — possibly after bounded trailing whitespace — passes.
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Pane == "" || len(body.Pane) > 256 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.ProcessID == "" || len(body.ProcessID) > 256 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	generation, ok := parsePositiveStamp(body.Generation)
	if !ok {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	pubRev, ok := parsePositiveStamp(body.TelemetryRevision)
	if !ok {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	runID, ok := parseReloadCounter(body.RunID)
	if !ok {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	contextRev, ok := parseReloadCounter(body.ContextRevision)
	if !ok {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeReloadTimeout)
	defer cancel()
	res, err := piBridge.RequestPaneReload(ctx, body.Pane, body.ProcessID, generation, pubRev, runID, contextRev)
	writeReloadResult(w, res, err)
}

// parseReloadCounter parses one canonical uint64 counter: digits
// only, no leading zeroes, no sign or whitespace. Zero is explicit
// and valid; absence is a separate unknown, never an implicit zero.
func parseReloadCounter(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil || strconv.FormatUint(n, 10) != s {
		return 0, false
	}
	return n, true
}

// writeReloadResult maps one Reload attempt to its status and fixed
// safe JSON body. request_id appears only when an ID was allocated.
// The outcome vocabulary has exactly three words: dispatched,
// rejected-before-start, and unknown. Refusals (before or at the
// host, never invoked) and unavailable-before-dispatch share
// rejected-before-start, distinguished by status; both carry one
// allowlisted reason. A dispatch receipt is entry evidence, never
// completion.
func writeReloadResult(w http.ResponseWriter, res pibridge.ReloadResult, err error) {
	w.Header().Set("Content-Type", "application/json")
	body := map[string]string{}
	status := http.StatusOK
	if err == nil {
		switch res.Outcome {
		case pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED:
			status = http.StatusAccepted
			body["outcome"] = "dispatched"
		case pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_REFUSED:
			status = http.StatusConflict
			body["outcome"] = "rejected-before-start"
			body["reason"] = res.Reason
		default:
			// Host-reported uncertainty after dispatch.
			status = http.StatusGatewayTimeout
			body["outcome"] = "unknown"
		}
		body["request_id"] = res.RequestID
	} else {
		var refusal *pibridge.ReloadRefusal
		var unknown *pibridge.ReloadUnknown
		var unavailable *pibridge.ReloadUnavailable
		switch {
		case errors.As(err, &refusal):
			status = http.StatusConflict
			body["outcome"] = "rejected-before-start"
			body["reason"] = refusal.Reason
		case errors.As(err, &unknown):
			// Dispatched; no trustworthy receipt reached the
			// caller. Peer loss after dispatch stays unknown,
			// never unavailable.
			status = http.StatusGatewayTimeout
			body["outcome"] = "unknown"
			body["request_id"] = unknown.RequestID
		case errors.As(err, &unavailable):
			status = http.StatusServiceUnavailable
			body["outcome"] = "rejected-before-start"
			body["reason"] = unavailable.Reason()
		default:
			// Disabled bridge or an unexpected pre-dispatch
			// failure. Rejected before start, never
			// unknown-after-dispatch, never raw errors.
			status = http.StatusServiceUnavailable
			body["outcome"] = "rejected-before-start"
			body["reason"] = "unavailable"
		}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
