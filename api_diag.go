package main

import (
	"encoding/json"
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/update"
)

// PaneDiag is per-pane diagnostic info surfaced through /api/diag.
// Pairs with F4 (hub overflow) debugging — the diag panel shows
// live ring fill + client count so an operator can see when a
// slow client is hurting the connection.
type PaneDiag struct {
	ID           string `json:"id"`
	Coder        string `json:"coder"`
	Title        string `json:"title"`
	ClientCount  int    `json:"client_count"`
	RingBytes    int    `json:"ring_bytes"`
	RingCapacity int    `json:"ring_capacity"`
	Busy         bool   `json:"busy"`
	LastActivity int64  `json:"last_activity_unix"`
}

// DiagResponse is the full /api/diag payload.
type DiagResponse struct {
	Version       string     `json:"version"`
	InstallMethod string     `json:"install_method"`
	UptimeSeconds float64    `json:"uptime_seconds"`
	Goroutines    int        `json:"goroutines"`
	MemAllocMB    float64    `json:"mem_alloc_mb"`
	PTYs          int        `json:"pty_count"`
	Panes         []PaneDiag `json:"panes"`
	StartedAt     time.Time  `json:"started_at"`
}

var serverStartedAt = time.Now()

// handleDiag returns a snapshot of server state for the diag panel.
// GET /api/diag. Intentionally unauthenticated — this is a local
// tool, not a public API. Pair with risk R6 (v0.9 auth) for hardening.
func handleDiag(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resp := DiagResponse{
		Version:       Version,
		InstallMethod: installMethodCached(),
		UptimeSeconds: time.Since(serverStartedAt).Seconds(),
		Goroutines:    runtime.NumGoroutine(),
		StartedAt:     serverStartedAt,
		Panes:         []PaneDiag{}, // always serialize as [], never null
	}

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	resp.MemAllocMB = float64(m.Alloc) / (1024 * 1024)

	if ptyManager != nil {
		insts := ptyManager.ListActive()
		resp.PTYs = len(insts)
		for _, inst := range insts {
			busy, lastActivity := inst.BusyState()
			pd := PaneDiag{
				ID:           inst.ID,
				Coder:        inst.Coder,
				Title:        inst.Title,
				Busy:         busy,
				LastActivity: lastActivity,
			}
			if wsHub != nil {
				pd.ClientCount, pd.RingBytes, pd.RingCapacity = wsHub.PaneStats(inst.ID)
			}
			resp.Panes = append(resp.Panes, pd)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// installMethodCached is the install method as of the last successful
// detection. Avoids re-running the path/sum check on every /api/diag hit.
var (
	cachedInstallMethod string
	installMethodOnce   sync.Once
)

func installMethodCached() string {
	installMethodOnce.Do(func() {
		cachedInstallMethod = update.DetectInstallMethod(BuildSource)
	})
	return cachedInstallMethod
}
