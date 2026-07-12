package main

import (
	"encoding/json"
	"net/http"

	"github.com/hypernewbie/phi/pkg/fleet"
)

// startFleetPoller reads peers from config and starts the poller.
func startFleetPoller() {
	cfg := loadConfig()
	peers := make([]fleet.PeerCfg, 0, len(cfg.Peers))
	for _, p := range cfg.Peers {
		if p.URL != "" {
			peers = append(peers, fleet.PeerCfg{Name: p.Name, URL: p.URL})
		}
	}
	fleetPoller.Start(peers)
}

// handleGetPeersStatus returns cached fleet status for all configured peers.
func handleGetPeersStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	statuses := fleetPoller.Status()
	if statuses == nil {
		statuses = []fleet.PeerStatus{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(statuses)
}

// handleConfigPeers handles GET/POST for the peers config array.
func handleConfigPeers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := loadConfig()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cfg.Peers)

	case http.MethodPost:
		var peers []PeerConfig
		if err := json.NewDecoder(r.Body).Decode(&peers); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		cfg := loadConfig()
		cfg.Peers = peers
		saveConfig(cfg)

		// Restart fleet poller with updated peers
		startFleetPoller()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(peers)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
