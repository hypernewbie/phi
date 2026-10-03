package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/coders"
)

var (
	ocServiceCacheMu      sync.Mutex
	ocServiceCacheRunning bool
	ocServiceCacheTime    time.Time
	ocServiceCacheValid   bool
)

func getCachedOpenCodeStatus(ctx context.Context, c coders.Coder) (bool, error) {
	ocServiceCacheMu.Lock()
	if ocServiceCacheValid && time.Since(ocServiceCacheTime) < 2*time.Second {
		running := ocServiceCacheRunning
		ocServiceCacheMu.Unlock()
		return running, nil
	}
	ocServiceCacheMu.Unlock()

	running, err := coders.OpenCodeService(ctx, c, "status")
	if err == nil {
		ocServiceCacheMu.Lock()
		ocServiceCacheRunning = running
		ocServiceCacheTime = time.Now()
		ocServiceCacheValid = true
		ocServiceCacheMu.Unlock()
	}
	return running, err
}

func invalidateOpenCodeServiceCache() {
	ocServiceCacheMu.Lock()
	ocServiceCacheValid = false
	ocServiceCacheMu.Unlock()
}

func countActiveOpenCodeTabs() int {
	if ptyManager == nil {
		return 0
	}
	count := 0
	for _, inst := range ptyManager.ListActive() {
		if inst.Coder == "opencode" && !inst.IsPtyDead() {
			count++
		}
	}
	return count
}

func handleOpenCodeService(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ensureCoderManager()
	c, ok := coderManager.Get("opencode")
	if !ok || c.SessionSource != "opencode_v2" || c.OpenCodeMode == "legacy" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"supported": false,
			"running":   false,
			"tabs":      0,
		})
		return
	}

	running, err := getCachedOpenCodeStatus(r.Context(), c)
	tabs := countActiveOpenCodeTabs()

	w.Header().Set("Content-Type", "application/json")
	resp := map[string]interface{}{
		"supported": true,
		"running":   running,
		"tabs":      tabs,
	}
	cfg := loadConfig()
	if cfg.OpenCodeIdleStopMinutes > 0 {
		resp["idle_stop_minutes"] = cfg.OpenCodeIdleStopMinutes
		if ptyManager != nil {
			lastAct := ptyManager.LastOpenCodeActivity()
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

func handleOpenCodeServiceStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ensureCoderManager()
	c, ok := coderManager.Get("opencode")
	if !ok || c.SessionSource != "opencode_v2" || c.OpenCodeMode == "legacy" {
		http.Error(w, "OpenCode 2 is not enabled", http.StatusBadRequest)
		return
	}

	var req struct {
		Force bool `json:"force"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	tabs := countActiveOpenCodeTabs()
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
	invalidateOpenCodeServiceCache()
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
