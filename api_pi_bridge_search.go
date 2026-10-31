package main

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
)

const (
	piBridgeTranscriptSearchTimeout = 2 * time.Second
	piBridgeTranscriptSearchMaxBody = 4 * 1024
)

// handlePiBridgeTranscriptSearch serves one bounded page from the live Pi
// transcript. Request origins are checked by Bridge and Server before the
// page is dispatched; no process identity selects a route.
func handlePiBridgeTranscriptSearch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var body struct {
		Pane         string `json:"pane"`
		Query        string `json:"query"`
		Generation   string `json:"generation"`
		ProcessID    string `json:"process_id"`
		SessionID    string `json:"session_id"`
		AnchorLeafID string `json:"anchor_leaf_id"`
		StartIndex   uint32 `json:"start_index"`
		Initial      *bool  `json:"initial"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, piBridgeTranscriptSearchMaxBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Pane == "" || len(body.Pane) > 256 || !pibridge.IsTranscriptSearchQuery(body.Query) || body.Initial == nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	generation, err := strconv.ParseUint(body.Generation, 10, 64)
	if err != nil || generation == 0 || strconv.FormatUint(generation, 10) != body.Generation {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	req := pibridge.TranscriptSearchRequest{
		Query: body.Query, SessionID: body.SessionID,
		AnchorLeafID: body.AnchorLeafID, StartIndex: body.StartIndex, Initial: *body.Initial,
	}
	if req.Initial {
		if body.ProcessID != "" || req.SessionID != "" || req.AnchorLeafID != "" || req.StartIndex != 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
	} else if body.ProcessID == "" || len(body.ProcessID) > 256 || req.SessionID == "" || len(req.SessionID) > 256 ||
		req.AnchorLeafID == "" || len(req.AnchorLeafID) > 256 || req.StartIndex == 0 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeTranscriptSearchTimeout)
	defer cancel()
	res, err := piBridge.RequestPaneTranscriptSearch(ctx, body.Pane, body.ProcessID, generation, req)
	if err != nil || res.Unavailable {
		http.Error(w, "pi transcript search unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"session_id":     res.SessionID,
		"anchor_leaf_id": res.AnchorLeafID,
		"next_index":     res.NextIndex,
		"matches":        res.Matches,
		"complete":       res.Complete,
		"unavailable":    res.Unavailable,
		"process_id":     res.ProcessID,
		"generation":     strconv.FormatUint(res.Generation, 10),
	})
}
