package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// piBridgeCompactTimeout bounds one Compact caller wait. A timeout is
// an unknown outcome, never cancellation of native provider work and
// never permission to replay.
const piBridgeCompactTimeout = 120 * time.Second

// piBridgeCompactMaxBody bounds the Compact request body.
const piBridgeCompactMaxBody = 4096

// handlePiBridgeCompact runs one native Pi compaction under the
// existing API auth gate. The body carries only the pane and the
// browser's expected generation/publication stamps; every host
// identity is derived server-side under the admission fence. Route-local
// same-origin/Fetch-Metadata checks apply even when access auth is
// disabled, because compaction can incur provider charges.
//
// Outcomes use exactly four safe words, never raw errors or
// summaries: completed (200), rejected-before-start (409, or 503
// when unavailable before dispatch), failed (502, including
// cancellation with its safe reason), and unknown (504, dispatched
// but unresolved). Malformed, forbidden, and wrong-method
// requests are 400, 403, and 405. Nothing here is cached.
func handlePiBridgeCompact(w http.ResponseWriter, r *http.Request) {
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
		Generation        string `json:"generation"`
		TelemetryRevision string `json:"telemetry_revision"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, piBridgeCompactMaxBody))
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
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeCompactTimeout)
	defer cancel()
	res, err := piBridge.RequestPaneCompact(ctx, body.Pane, generation, pubRev)
	writeCompactResult(w, res, err)
}

// parsePositiveStamp parses one canonical positive uint64 stamp: digits
// only, no leading zeroes, no sign or whitespace, at least 1.
func parsePositiveStamp(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil || n == 0 || strconv.FormatUint(n, 10) != s {
		return 0, false
	}
	return n, true
}

// compactSameOrigin applies the route-local browser check: requests
// carrying an Origin or Fetch-Metadata Site header must prove
// same-origin navigation. Absent headers mean a nonbrowser client,
// which the existing auth policy already gates. The comparison uses
// the actual scheme and Host, never forwarded headers. No CORS.
func compactSameOrigin(r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" {
			return false
		}
		if u.Scheme != compactScheme(r) || !strings.EqualFold(u.Host, r.Host) {
			return false
		}
		// A URL with userinfo, path, query, or fragment is not a
		// serialized origin; neither is the opaque "null" origin.
		if u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
			return false
		}
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		switch site {
		case "same-origin", "none":
		default:
			return false
		}
	}
	return true
}

// compactScheme reports the actual request scheme from the
// connection, never from forwarded headers.
func compactScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

// writeCompactResult maps one Compact attempt to its status and fixed
// safe JSON body. request_id appears only when an ID was allocated.
// The outcome vocabulary has exactly four words: completed,
// rejected-before-start, failed, and unknown. Refusals (before or at
// the host, never invoked) and unavailable-before-dispatch share
// rejected-before-start, distinguished by status; cancellation is a
// failure carrying the safe cancelled reason.
func writeCompactResult(w http.ResponseWriter, res pibridge.CompactResult, err error) {
	w.Header().Set("Content-Type", "application/json")
	body := map[string]string{}
	status := http.StatusOK
	if err == nil {
		switch res.Outcome {
		case pibridgepb.CompactOutcome_COMPACT_OUTCOME_COMPLETED:
			body["outcome"] = "completed"
		case pibridgepb.CompactOutcome_COMPACT_OUTCOME_REFUSED:
			status = http.StatusConflict
			body["outcome"] = "rejected-before-start"
			body["reason"] = res.Reason
		case pibridgepb.CompactOutcome_COMPACT_OUTCOME_FAILED:
			status = http.StatusBadGateway
			body["outcome"] = "failed"
			body["reason"] = res.Reason
		case pibridgepb.CompactOutcome_COMPACT_OUTCOME_CANCELLED:
			status = http.StatusBadGateway
			body["outcome"] = "failed"
			body["reason"] = res.Reason
			if body["reason"] == "" {
				body["reason"] = "cancelled"
			}
		default:
			// Host-reported uncertainty after dispatch.
			status = http.StatusGatewayTimeout
			body["outcome"] = "unknown"
		}
		body["request_id"] = res.RequestID
	} else {
		var refusal *pibridge.CompactRefusal
		var unknown *pibridge.CompactUnknown
		switch {
		case errors.As(err, &refusal):
			status = http.StatusConflict
			body["outcome"] = "rejected-before-start"
			body["reason"] = refusal.Reason
		case errors.As(err, &unknown):
			// Dispatched; the wait ended first. Peer loss after
			// dispatch stays unknown, never unavailable.
			status = http.StatusGatewayTimeout
			body["outcome"] = "unknown"
			body["request_id"] = unknown.RequestID
		default:
			// Unavailable before dispatch: unknown pane,
			// unmanaged bridge, no peer, no capability, or a
			// bounded send-queue miss. Rejected before start,
			// never unknown-after-dispatch, never raw errors.
			status = http.StatusServiceUnavailable
			body["outcome"] = "rejected-before-start"
		}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
