package fleet

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

const (
	pollInterval    = 15 * time.Second
	pollTimeout     = 3 * time.Second
	staleAfterMisses = 2
)

// PeerTab is the shape each phi peer returns in GET /api/terminals.
type PeerTab struct {
	ID               string `json:"id"`
	Coder            string `json:"coder"`
	Title            string `json:"title"`
	LastActivityUnix int64  `json:"last_activity_unix"`
	Busy             bool   `json:"busy"`
}

// PeerStatus holds the latest known state for a single peer.
type PeerStatus struct {
	Name        string    `json:"name"`
	URL         string    `json:"url"`
	Reachable   bool      `json:"reachable"`
	Stale       bool      `json:"stale"`
	TabCount    int       `json:"tab_count"`
	BusyCount   int       `json:"busy_count"`
	Tabs        []PeerTab `json:"tabs"`
	LastChecked time.Time `json:"last_checked"`
	ErrorMsg    string    `json:"error,omitempty"`
}

type peerState struct {
	status     PeerStatus
	misses     int
	httpClient *http.Client
}

// Poller polls all configured peers on a fixed cadence.
type Poller struct {
	mu     sync.RWMutex
	states map[string]*peerState
	cancel context.CancelFunc
}

func NewPoller() *Poller {
	return &Poller{
		states: make(map[string]*peerState),
	}
}

// Start kicks off polling goroutines for the given peer configs.
// Calling Start again replaces the peer list (stops old, starts new).
type PeerCfg struct {
	Name string
	URL  string
}

func (p *Poller) Start(peers []PeerCfg) {
	p.mu.Lock()
	if p.cancel != nil {
		p.cancel()
	}

	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.states = make(map[string]*peerState, len(peers))
	for _, peer := range peers {
		ps := &peerState{
			status: PeerStatus{
				Name: peer.Name,
				URL:  peer.URL,
			},
			httpClient: &http.Client{Timeout: pollTimeout},
		}
		p.states[peer.URL] = ps
	}
	p.mu.Unlock()

	for _, peer := range peers {
		go p.pollLoop(ctx, peer)
	}
}

func (p *Poller) pollLoop(ctx context.Context, peer PeerCfg) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	// Poll immediately on start
	p.poll(peer)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.poll(peer)
		}
	}
}

func (p *Poller) poll(peer PeerCfg) {
	p.mu.RLock()
	ps, ok := p.states[peer.URL]
	p.mu.RUnlock()
	if !ok {
		return
	}

	tabs, err := fetchTabs(ps.httpClient, peer.URL)

	p.mu.Lock()
	defer p.mu.Unlock()

	ps, ok = p.states[peer.URL]
	if !ok {
		return
	}

	now := time.Now()
	ps.status.LastChecked = now

	if err != nil {
		ps.misses++
		ps.status.Reachable = false
		ps.status.ErrorMsg = err.Error()
		if ps.misses >= staleAfterMisses {
			ps.status.Stale = true
		}
		return
	}

	// Successful fetch
	ps.misses = 0
	ps.status.Reachable = true
	ps.status.Stale = false
	ps.status.ErrorMsg = ""
	ps.status.Tabs = tabs
	ps.status.TabCount = len(tabs)

	busyCount := 0
	for _, t := range tabs {
		if t.Busy {
			busyCount++
		}
	}
	ps.status.BusyCount = busyCount
}

func fetchTabs(client *http.Client, baseURL string) ([]PeerTab, error) {
	resp, err := client.Get(baseURL + "/api/terminals")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var tabs []PeerTab
	if err := json.NewDecoder(resp.Body).Decode(&tabs); err != nil {
		return nil, err
	}
	return tabs, nil
}

// Status returns the latest status for all known peers.
func (p *Poller) Status() []PeerStatus {
	p.mu.RLock()
	defer p.mu.RUnlock()

	out := make([]PeerStatus, 0, len(p.states))
	for _, ps := range p.states {
		out = append(out, ps.status)
	}
	return out
}
