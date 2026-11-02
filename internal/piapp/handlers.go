package piapp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
)

const piBridgeOnDemandTimeout = time.Second

// Model operations can wait behind native host work. This is local IPC time;
// the browser allows a longer network budget for mobile connections.
const piBridgeModelTimeout = 30 * time.Second

// handlePiBridgeHistory uses the existing API auth gate. Errors reveal no
// prompt text or bridge internals; successful snapshots must not be cached.
func (a *API) HandlePiBridgeHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	paneID := r.URL.Query().Get("pane")
	if paneID == "" {
		http.Error(w, "missing pane", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeOnDemandTimeout)
	defer cancel()
	res, err := a.bridgeOrNil().RequestPaneHistory(ctx, paneID)
	if err != nil {
		http.Error(w, "pi history unavailable", http.StatusServiceUnavailable)
		return
	}
	entries := res.Entries
	if entries == nil {
		entries = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"entries": entries, "unavailable": res.Unavailable})
}

// handlePiBridgeModels uses the existing API auth gate. Errors reveal
// no bridge internals; successful lists must not be cached. Model is
// mapped to id at this edge so the web UI renders bridge rows
// exactly like Pi RPC rows.
func (a *API) HandlePiBridgeModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	paneID := r.URL.Query().Get("pane")
	if paneID == "" {
		http.Error(w, "missing pane", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeModelTimeout)
	defer cancel()
	res, err := a.bridgeOrNil().RequestPaneModels(ctx, paneID)
	if err != nil {
		http.Error(w, "pi models unavailable", http.StatusServiceUnavailable)
		return
	}
	models := make([]map[string]string, 0, len(res.Models))
	for _, m := range res.Models {
		models = append(models, map[string]string{"provider": m.Provider, "id": m.Model})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"models": models, "truncated": res.Truncated, "unavailable": res.Unavailable})
}

// handlePiBridgeThinkingLevels returns the supported levels and the exact
// process generation that answered. The origin must be echoed for setters.
func (a *API) HandlePiBridgeThinkingLevels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	paneID := r.URL.Query().Get("pane")
	if paneID == "" || len(paneID) > 256 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeOnDemandTimeout)
	defer cancel()
	res, err := a.bridgeOrNil().RequestPaneThinkingLevels(ctx, paneID)
	if err != nil {
		http.Error(w, "pi thinking unavailable", http.StatusServiceUnavailable)
		return
	}
	levels := res.Levels
	if levels == nil {
		levels = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"levels": levels, "provider": res.Provider, "model": res.Model,
		"unavailable": res.Unavailable, "process_id": res.ProcessID,
		"generation": strconv.FormatUint(res.Generation, 10),
	})
}

func parseBridgeGeneration(value string) (uint64, bool) {
	if value == "" || len(value) > 20 {
		return 0, false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return 0, false
		}
	}
	generation, err := strconv.ParseUint(value, 10, 64)
	return generation, err == nil && generation != 0
}

// handlePiBridgeSetThinking requires the process/generation origin from the
// list response. Malformed or stale origins fail before mutation.
func (a *API) HandlePiBridgeSetThinking(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Pane       string `json:"pane"`
		Level      string `json:"level"`
		Provider   string `json:"provider"`
		Model      string `json:"model"`
		ProcessID  string `json:"process_id"`
		Generation string `json:"generation"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
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
	generation, validGeneration := parseBridgeGeneration(body.Generation)
	if body.Pane == "" || len(body.Pane) > 256 || body.ProcessID == "" || len(body.ProcessID) > 256 ||
		!pibridge.IsThinkingLevel(body.Level) || len(body.Level) > 16 ||
		body.Provider == "" || len(body.Provider) > 256 || body.Model == "" || len(body.Model) > 256 || !validGeneration {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeOnDemandTimeout)
	defer cancel()
	res, err := a.bridgeOrNil().RequestPaneSetThinking(ctx, body.Pane, body.ProcessID, generation, body.Level, body.Provider, body.Model)
	if err != nil {
		http.Error(w, "pi thinking unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": res.OK, "reason": res.Reason})
}

// handlePiBridgeSkills uses the existing API auth gate. Errors reveal
// no bridge internals; successful lists must not be cached.
func (a *API) HandlePiBridgeSkills(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	paneID := r.URL.Query().Get("pane")
	if paneID == "" || len(paneID) > 256 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeOnDemandTimeout)
	defer cancel()
	res, err := a.bridgeOrNil().RequestPaneSkills(ctx, paneID)
	if err != nil {
		http.Error(w, "pi skills unavailable", http.StatusServiceUnavailable)
		return
	}
	skills := make([]map[string]string, 0, len(res.Skills))
	for _, s := range res.Skills {
		skills = append(skills, map[string]string{"name": s.Name, "description": s.Description})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"skills": skills, "truncated": res.Truncated, "unavailable": res.Unavailable,
		"process_id": res.ProcessID, "generation": strconv.FormatUint(res.Generation, 10),
	})
}

// handlePiBridgeInvokeSkill sends one skill to the live Pi session. The
// ack means the request was dispatched, never that the agent accepted or
// completed it; the reason vocabulary is safe to surface. The origin of
// the list that produced the row must be echoed: a session that moved on
// refuses the request instead of receiving the skill.
func (a *API) HandlePiBridgeInvokeSkill(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Pane       string `json:"pane"`
		Name       string `json:"name"`
		ProcessID  string `json:"process_id"`
		Generation string `json:"generation"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
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
	generation, validGeneration := parseBridgeGeneration(body.Generation)
	if body.Pane == "" || len(body.Pane) > 256 || !pibridge.IsSkillName(body.Name) ||
		body.ProcessID == "" || len(body.ProcessID) > 256 || !validGeneration {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeOnDemandTimeout)
	defer cancel()
	res, err := a.bridgeOrNil().RequestPaneInvokeSkill(ctx, body.Pane, body.ProcessID, generation, body.Name)
	if err != nil {
		if errors.Is(err, pibridge.ErrSkillOriginStale) {
			// The runtime that produced the list is gone: the
			// request was never dispatched, so it is a refusal.
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "reason": "unavailable"})
			return
		}
		http.Error(w, "pi skill unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": res.OK, "reason": res.Reason})
}

// handlePiBridgeSetModel uses the existing API auth gate. The body
// names one catalog entry; failures are 503 without bridge
// internals, and the ack reason vocabulary is safe to surface.
func (a *API) HandlePiBridgeSetModel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Pane     string `json:"pane"`
		Provider string `json:"provider"`
		Model    string `json:"model"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Pane == "" || body.Provider == "" || body.Model == "" ||
		len(body.Pane) > 256 || len(body.Provider) > 256 || len(body.Model) > 256 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), piBridgeModelTimeout)
	defer cancel()
	res, err := a.bridgeOrNil().RequestPaneSetModel(ctx, body.Pane, body.Provider, body.Model)
	if err != nil {
		http.Error(w, "pi model switch unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": res.OK, "reason": res.Reason})
}
