package fleet

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

const (
	pollInterval     = 15 * time.Second
	pollTimeout      = 3 * time.Second
	staleAfterMisses = 2
)

// PeerTab is the shape each phi peer returns in GET /api/terminals.
// Fields are additive — older peers missing last_activity_unix/busy
// still parse cleanly (Busy=false, LastActivityUnix=0).
type PeerTab struct {
	ID               string `json:"id"`
	Coder            string `json:"coder"`
	Title            string `json:"title"`
	LastActivityUnix int64  `json:"last_activity_unix"`
	Busy             bool   `json:"busy"`
}

// PeerStatus holds the latest known state for a single peer.
// Shape is the cross-version contract for GET /api/peers/status (plan §3.4).
// All fields are additive; missing fields on older peers degrade cleanly.
type PeerStatus struct {
	Name        string    `json:"name"`
	URL         string    `json:"url"`
	Reachable   bool      `json:"reachable"`
	Stale       bool      `json:"stale"`
	TabCount    int       `json:"tab_count"`
	BusyCount   int       `json:"busy_count"`
	IdleMin     int       `json:"idle_min"` // minutes since most recent tab activity; -1 if unknown
	Version     string    `json:"version"`  // peer's stamped phi version, "" if unknown
	Tabs        []PeerTab `json:"tabs"`
	LastChecked time.Time `json:"last_checked"`
	ErrorMsg    string    `json:"error,omitempty"`
}

type peerState struct {
	status     PeerStatus
	misses     int
	httpClient *http.Client
}

// PeerCfg is the config shape the poller consumes (decoupled from the
// config package so tests don't have to import the world).
type PeerCfg struct {
	Name string
	URL  string
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

	// Poll immediately on start so the first response isn't 15s away.
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

	tabs, version, err := fetchTabsAndVersion(ps.httpClient, peer.URL)

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
	ps.status.Version = version
	ps.status.Tabs = tabs
	ps.status.TabCount = len(tabs)

	busyCount := 0
	var mostRecent int64 = -1
	for _, t := range tabs {
		if t.Busy {
			busyCount++
		}
		if t.LastActivityUnix > mostRecent {
			mostRecent = t.LastActivityUnix
		}
	}
	ps.status.BusyCount = busyCount
	if mostRecent > 0 {
		ps.status.IdleMin = int(time.Since(time.Unix(mostRecent, 0)).Minutes())
	} else {
		ps.status.IdleMin = -1
	}
}

// fetchTabsAndVersion pulls /api/terminals + /api/version in parallel so
// fleet status costs one HTTP round-trip's worth of latency, not two.
// Version is best-effort: older peers without /api/version still report
// tabs with version="". Either fetch's network/HTTP error causes the
// whole poll to fail (treated as unreachable).
func fetchTabsAndVersion(client *http.Client, baseURL string) ([]PeerTab, string, error) {
	type tabsResult struct {
		tabs []PeerTab
		err  error
	}
	type verResult struct {
		ver string
		err error
	}
	var tr tabsResult
	var vr verResult
	var wg sync.WaitGroup

	wg.Add(2)
	go func() {
		defer wg.Done()
		resp, err := client.Get(baseURL + "/api/terminals")
		if err != nil {
			tr.err = err
			return
		}
		defer resp.Body.Close()
		var t []PeerTab
		if err := json.NewDecoder(resp.Body).Decode(&t); err != nil {
			tr.err = err
			return
		}
		tr.tabs = t
	}()
	go func() {
		defer wg.Done()
		resp, err := client.Get(baseURL + "/api/version")
		if err != nil {
			vr.err = err
			return
		}
		defer resp.Body.Close()
		var v struct {
			Version string `json:"version"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
			vr.err = err
			return
		}
		vr.ver = v.Version
	}()
	wg.Wait()

	if tr.err != nil {
		return nil, "", tr.err
	}
	// Version is soft-fail: older peers still report tabs cleanly.
	return tr.tabs, vr.ver, nil
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