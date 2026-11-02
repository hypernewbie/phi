package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/hypernewbie/phi/pkg/coders"
)

func (app *Server) getCachedOpenCodeStatus(ctx context.Context, c coders.Coder) (bool, error) {
	app.ocServiceCacheMu.Lock()
	if app.ocServiceCacheValid && time.Since(app.ocServiceCacheTime) < 2*time.Second {
		running := app.ocServiceCacheRunning
		app.ocServiceCacheMu.Unlock()
		return running, nil
	}
	app.ocServiceCacheMu.Unlock()

	running, err := coders.OpenCodeService(ctx, c, "status")
	if err == nil {
		app.ocServiceCacheMu.Lock()
		app.ocServiceCacheRunning = running
		app.ocServiceCacheTime = time.Now()
		app.ocServiceCacheValid = true
		app.ocServiceCacheMu.Unlock()
	}
	return running, err
}

func (app *Server) invalidateOpenCodeServiceCache() {
	app.ocServiceCacheMu.Lock()
	app.ocServiceCacheValid = false
	app.ocServiceCacheMu.Unlock()
}

func (app *Server) countActiveOpenCodeTabs() int {
	if app.pty == nil {
		return 0
	}
	count := 0
	for _, inst := range app.pty.ListActive() {
		if inst.Coder == "opencode" && !inst.IsPtyDead() {
			count++
		}
	}
	return count
}

func (app *Server) handleOpenCodeService(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	app.ensureCoderManager()
	c, ok := app.coders.Get("opencode")
	if !ok || c.SessionSource != "opencode_v2" || c.OpenCodeMode == "legacy" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"supported": false,
			"running":   false,
			"tabs":      0,
		})
		return
	}

	running, err := app.getCachedOpenCodeStatus(r.Context(), c)
	tabs := app.countActiveOpenCodeTabs()

	w.Header().Set("Content-Type", "application/json")
	resp := map[string]interface{}{
		"supported": true,
		"running":   running,
		"tabs":      tabs,
	}
	cfg := app.loadConfig()
	if cfg.OpenCodeIdleStopMinutes > 0 {
		resp["idle_stop_minutes"] = cfg.OpenCodeIdleStopMinutes
		if app.pty != nil {
			lastAct := app.pty.LastOpenCodeActivity()
			rem := time.Duration(cfg.OpenCodeIdleStopMinutes)*time.Minute - time.Since(lastAct)
			if rem < 0 {
				rem = 0
			}
			resp["idle_stop_remaining_seconds"] = int(rem.Seconds())
		}
	}
	if err != nil {
		resp["error"] = err.Error()
	}
	_ = json.NewEncoder(w).Encode(resp)
}

func (app *Server) handleOpenCodeServiceStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	app.ensureCoderManager()
	c, ok := app.coders.Get("opencode")
	if !ok || c.SessionSource != "opencode_v2" || c.OpenCodeMode == "legacy" {
		http.Error(w, "OpenCode 2 is not enabled", http.StatusBadRequest)
		return
	}

	var req struct {
		Force bool `json:"force"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	tabs := app.countActiveOpenCodeTabs()
	if tabs > 0 && !req.Force {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   "open_tabs",
			"tabs":    tabs,
			"message": "OpenCode tabs are currently active",
		})
		return
	}

	_, err := coders.OpenCodeService(r.Context(), c, "stop")
	app.invalidateOpenCodeServiceCache()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"error": err.Error(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"supported": true,
		"running":   false,
		"stopped":   true,
	})
}
