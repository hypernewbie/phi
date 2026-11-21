package server

import (
	"errors"
	"net/url"
	"sync"

	"github.com/hypernewbie/phi/internal/config"
)

// The board and topic feed share one authority for this RAM instance. A valid
// role, target, or follower identity change requires a restart, not a new ledger.
type syncTopicConfig struct {
	mu          sync.Mutex
	initialized bool
	blocked     bool
	coordinator string
	peerID      string
}

var errSyncTopicConfig = errors.New("sync configuration unavailable")

func (app *Server) loadSyncConfig() (config.Config, error) {
	if app.configStore() == nil {
		return config.Config{}, errSyncTopicConfig
	}
	cfg, err := app.configStore().LoadWithError()
	if err != nil {
		return config.Config{}, errSyncTopicConfig
	}
	peerID := ""
	if cfg.SyncCoordinator != "" {
		u, err := url.Parse(cfg.SyncCoordinator)
		if err != nil || u.Host == "" || u.Opaque != "" || u.User != nil ||
			(u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
			(cfg.SyncTopicsPeerID != "" && !validPeerID(cfg.SyncTopicsPeerID)) ||
			(cfg.SyncTopicsPeerSecret != "" && !validPeerSecret(cfg.SyncTopicsPeerSecret)) {
			return config.Config{}, errSyncTopicConfig
		}
		peerID = cfg.SyncTopicsPeerID
	}
	state := &app.syncTopicConfig
	state.mu.Lock()
	if !state.initialized {
		state.coordinator, state.peerID = cfg.SyncCoordinator, peerID
		state.initialized = true
	}
	changed := !state.blocked && (cfg.SyncCoordinator != state.coordinator || peerID != state.peerID)
	if changed {
		state.blocked = true
	}
	blocked := state.blocked
	state.mu.Unlock()
	if changed {
		app.stopSyncTopicAuthority()
	}
	if blocked {
		return config.Config{}, errSyncTopicConfig
	}
	return cfg, nil
}

// stopSyncTopicAuthority closes feeds before native retirement callbacks run.
// It never sends cleanup to a former target or cancels remote reservations.
// Call outside board/bridge locks and registry.mu. Registry ops may be held.
func (app *Server) stopSyncTopicAuthority() {
	if client := app.syncTopicPeer; client != nil {
		client.mu.Lock()
		client.blocked, client.active, client.ready = true, false, false
		conn := client.ws
		client.mu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}
	}
	if registry := app.peerRegistry(); registry != nil {
		registry.mu.Lock()
		var conns []*syncTopicPeerConn
		for _, cohort := range registry.byPeer {
			cohort.ready = false
			if cohort.conn != nil {
				conns = append(conns, cohort.conn)
			}
		}
		registry.mu.Unlock()
		for _, conn := range conns {
			conn.close()
		}
	}
	if app.bridge != nil {
		app.bridge.RetireSyncboardTopicBindings("peer-config-changed")
	}
}
