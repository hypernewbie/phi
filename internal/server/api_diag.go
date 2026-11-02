package server

import (
	"encoding/json"
	"net/http"
	"runtime"
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

	// Additive M4 fields — a little more of the runtime state we already
	// debug against, nothing more (no pprof, no /metrics).
	GoVersion  string `json:"go_version"`
	GOMAXPROCS int    `json:"gomaxprocs"`
	NumCPU     int    `json:"num_cpu"`
	NumGC      uint32 `json:"num_gc"`

	// Additive memory counters. A leak hunt needs growth per subsystem, not
	// one total: MemAllocMB alone cannot tell a terminal buffer apart from
	// retained sockets or a runaway goroutine stack.
	MemSysMB       float64 `json:"mem_sys_mb"`
	MemHeapInuseMB float64 `json:"mem_heap_inuse_mb"`
	MemStackMB     float64 `json:"mem_stack_mb"`
	HeapObjects    uint64  `json:"heap_objects"`
	// Terminal memory: the ring buffers are the panes' retained scrollback.
	RingBytesTotal    int `json:"ring_bytes_total"`
	RingCapacityTotal int `json:"ring_capacity_total"`
	WSClientsTotal    int `json:"ws_clients_total"`
}

// handleDiag returns a snapshot of server state for the diag panel.
// GET /api/diag. Intentionally unauthenticated — this is a local
// tool, not a public API. Pair with risk R6 (v0.9 auth) for hardening.
func (app *Server) handleDiag(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resp := DiagResponse{
		Version:       app.version,
		InstallMethod: app.installMethodCached(),
		UptimeSeconds: time.Since(app.serverStartedAt).Seconds(),
		Goroutines:    runtime.NumGoroutine(),
		StartedAt:     app.serverStartedAt,
		Panes:         []PaneDiag{}, // always serialize as [], never null
		GoVersion:     runtime.Version(),
		GOMAXPROCS:    runtime.GOMAXPROCS(0),
		NumCPU:        runtime.NumCPU(),
	}

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	resp.MemAllocMB = float64(m.Alloc) / (1024 * 1024)
	resp.MemSysMB = float64(m.Sys) / (1024 * 1024)
	resp.MemHeapInuseMB = float64(m.HeapInuse) / (1024 * 1024)
	resp.MemStackMB = float64(m.StackInuse) / (1024 * 1024)
	resp.HeapObjects = m.HeapObjects
	resp.NumGC = m.NumGC

	if app.pty != nil {
		insts := app.pty.ListActive()
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
			if app.hub != nil {
				pd.ClientCount, pd.RingBytes, pd.RingCapacity = app.hub.PaneStats(inst.ID)
			}
			resp.WSClientsTotal += pd.ClientCount
			resp.RingBytesTotal += pd.RingBytes
			resp.RingCapacityTotal += pd.RingCapacity
			resp.Panes = append(resp.Panes, pd)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// installMethodCached is the install method as of the last successful
// detection. Avoids re-running the path/sum check on every /api/diag hit.

func (app *Server) installMethodCached() string {
	app.installMethodOnce.Do(func() {
		app.cachedInstallMethod = update.DetectInstallMethod(app.buildSource)
	})
	return app.cachedInstallMethod
}
