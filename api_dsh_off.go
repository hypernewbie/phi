//go:build !dsh

package main

import (
	"encoding/json"
	"log"
	"net/http"
)

// This build does not link the DeepSeek Harness carrier. The stubs keep the
// mux registration, the restart hook, and the auth-generation hook identical
// in both variants, so no caller needs its own build tag.

// startDshPreview reports a configured-but-unavailable preview once at
// startup instead of failing silently.
func startDshPreview(cfg Config) {
	if cfg.DshPreviewEnabled {
		log.Printf("[dsh] dsh_preview_enabled is set, but this build excludes the preview; rebuild with -tags dsh")
	}
}

// stopDshPreview has no child to stop in this build.
func stopDshPreview() {}

// dshRevokeLiveWork has no carrier work to revoke in this build.
func dshRevokeLiveWork() {}

// handleDshStatus keeps the launcher contract intact: the preview is
// unavailable, and the reason names the build rather than the configuration.
func handleDshStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(dshStatusResponse{
		Enabled: false,
		State:   "disabled",
		Reason:  "unsupported-build",
	})
}

// handleDshMount has no route to carry requests to in this build.
func handleDshMount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	http.NotFound(w, r)
}
