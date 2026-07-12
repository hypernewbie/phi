package main

import (
	"encoding/json"
	"net/http"
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