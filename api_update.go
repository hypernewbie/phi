package main

import (
	"encoding/json"
	"net/http"

	"github.com/hypernewbie/phi/pkg/update"
)

var (
	updateChecker *update.Checker
	updateApplier *update.Applier
)

// handleUpdateStatus returns the current cached update check result.
// GET /api/update/status
func handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if updateChecker == nil {
		http.Error(w, "Update checker not initialized", http.StatusServiceUnavailable)
		return
	}

	status := updateChecker.Status()
	// Force a fresh check on first hit if we've never checked before.
	if status.LastChecked == "" {
		if result := updateChecker.RunCheck(false); result.Err == nil && result.Latest != "" {
			status = updateChecker.Status()
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

// handleUpdateCheck triggers a fresh check (subject to min interval).
// POST /api/update/check
func handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if updateChecker == nil {
		http.Error(w, "Update checker not initialized", http.StatusServiceUnavailable)
		return
	}

	result := updateChecker.RunCheck(false)
	status := updateChecker.Status()
	if result.Err != nil {
		// Don't surface the raw error to the client; it's noise. Keep
		// the cached state and include a hint in Error so the UI can
		// show "couldn't reach github" without crashing.
		status.Error = "GitHub unreachable; showing cached status"
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

// handleUpdateApply kicks off a T2 staged swap. POST /api/update/apply
// with body {"version":"v0.8.2"}. Returns immediately with the initial
// progress snapshot; client polls /api/update/progress to track.
func handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if updateApplier == nil {
		http.Error(w, "Update applier not initialized", http.StatusServiceUnavailable)
		return
	}
	if !updateApplier.Eligible() {
		http.Error(w, "Self-update is not available for this install method", http.StatusForbidden)
		return
	}

	var req struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Version == "" {
		http.Error(w, "version is required", http.StatusBadRequest)
		return
	}

	// Run in a goroutine so the HTTP response returns immediately.
	// The client polls /api/update/progress for status.
	go updateApplier.Apply(req.Version)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(updateApplier.Progress())
}

// handleUpdateProgress returns the current apply pipeline status.
// GET /api/update/progress
func handleUpdateProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if updateApplier == nil {
		http.Error(w, "Update applier not initialized", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(updateApplier.Progress())
}