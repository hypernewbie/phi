package server

import (
	"encoding/json"
	"net/http"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/fleet"
)

// startFleetPoller reads peers from config and starts the poller.
// startFleetPoller begins polling the configured peers.
func (app *Server) startFleetPoller() {
	cfg := app.loadConfig()
	peers := make([]fleet.PeerCfg, 0, len(cfg.Peers))
	for _, p := range cfg.Peers {
		if p.URL != "" {
			peers = append(peers, fleet.PeerCfg{Name: p.Name, URL: p.URL})
		}
	}
	app.fleet.Start(peers)
}

// handleGetPeersStatus returns cached fleet status for all configured peers.
func (app *Server) handleGetPeersStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	statuses := app.fleet.Status()
	if statuses == nil {
		statuses = []fleet.PeerStatus{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(statuses)
}

// handleConfigPeers handles GET/POST for the peers config array.
func (app *Server) handleConfigPeers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := app.loadConfig()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cfg.Peers)

	case http.MethodPost:
		var peers []config.PeerConfig
		if err := json.NewDecoder(r.Body).Decode(&peers); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		cfg := app.loadConfig()
		cfg.Peers = peers
		app.saveConfig(cfg)

		// Restart fleet poller with updated peers
		app.startFleetPoller()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(peers)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
