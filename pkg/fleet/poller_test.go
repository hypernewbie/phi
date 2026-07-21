package fleet

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func makeTabServer(t *testing.T, tabs []PeerTab, statusCode int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/terminals" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(statusCode)
		if statusCode == http.StatusOK {
			_ = json.NewEncoder(w).Encode(tabs)
		}
	}))
}

func TestPoller_HealthyPeer(t *testing.T) {
	tabs := []PeerTab{
		{ID: "t1", Coder: "opencode", Title: "session-1", Busy: true, LastActivityUnix: time.Now().Unix()},
		{ID: "t2", Coder: "bash", Title: "bash-1", Busy: false},
	}
	srv := makeTabServer(t, tabs, http.StatusOK)
	defer srv.Close()

	p := NewPoller()
	p.Start([]PeerCfg{{Name: "test", URL: srv.URL}})
	time.Sleep(100 * time.Millisecond)

	statuses := p.Status()
	if len(statuses) != 1 {
		t.Fatalf("expected 1 status, got %d", len(statuses))
	}
	s := statuses[0]
	if !s.Reachable {
		t.Errorf("expected reachable, got unreachable (err: %s)", s.ErrorMsg)
	}
	if s.TabCount != 2 {
		t.Errorf("expected 2 tabs, got %d", s.TabCount)
	}
	if s.BusyCount != 1 {
		t.Errorf("expected 1 busy tab, got %d", s.BusyCount)
	}
	if s.Stale {
		t.Errorf("expected not stale")
	}
}

func TestPoller_UnreachablePeer(t *testing.T) {
	p := NewPoller()
	p.Start([]PeerCfg{{Name: "dead", URL: "http://127.0.0.1:1"}})
	time.Sleep(200 * time.Millisecond)

	statuses := p.Status()
	if len(statuses) != 1 {
		t.Fatalf("expected 1 status, got %d", len(statuses))
	}
	s := statuses[0]
	if s.Reachable {
		t.Errorf("expected unreachable peer to be marked unreachable")
	}
	if s.ErrorMsg == "" {
		t.Errorf("expected error message for unreachable peer")
	}
}

func TestPoller_StaleAfterMisses(t *testing.T) {
	// Override constants for testing
	origInterval := pollInterval
	origMisses := staleAfterMisses
	_ = origMisses

	p := NewPoller()

	// Use a server that returns 500
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p.Start([]PeerCfg{{Name: "error-peer", URL: srv.URL}})
	time.Sleep(100 * time.Millisecond)

	// Manually drive two polls
	cfg := PeerCfg{Name: "error-peer", URL: srv.URL}
	p.poll(cfg)
	p.poll(cfg)

	statuses := p.Status()
	if len(statuses) == 0 {
		t.Fatal("no status entries")
	}
	s := statuses[0]
	if s.Reachable {
		t.Errorf("should not be reachable on 500")
	}
	if !s.Stale {
		t.Errorf("expected stale after %d misses", staleAfterMisses)
	}
	_ = origInterval
}

func TestPoller_RecoveryClears(t *testing.T) {
	tabs := []PeerTab{{ID: "t1", Coder: "bash", Title: "test"}}
	srv := makeTabServer(t, tabs, http.StatusOK)
	defer srv.Close()

	p := NewPoller()
	cfg := PeerCfg{Name: "recovering", URL: srv.URL}
	p.states[srv.URL] = &peerState{
		status:     PeerStatus{Name: cfg.Name, URL: cfg.URL, Stale: true, Reachable: false},
		misses:     staleAfterMisses + 1,
		httpClient: &http.Client{Timeout: pollTimeout},
	}
	p.poll(cfg)

	statuses := p.Status()
	if len(statuses) == 0 {
		t.Fatal("no status entries")
	}
	s := statuses[0]
	if !s.Reachable {
		t.Errorf("expected reachable after recovery")
	}
	if s.Stale {
		t.Errorf("expected not stale after recovery")
	}
}

func TestPoller_GarbageJSONPeer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("not-json{{{{"))
	}))
	defer srv.Close()

	p := NewPoller()
	cfg := PeerCfg{Name: "garbled", URL: srv.URL}
	p.Start([]PeerCfg{cfg})
	time.Sleep(100 * time.Millisecond)

	statuses := p.Status()
	if len(statuses) == 0 {
		t.Fatal("no status")
	}
	s := statuses[0]
	if s.Reachable {
		t.Errorf("garbage JSON should result in unreachable")
	}
}

func TestPoller_SlowPeer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Second)
		_ = json.NewEncoder(w).Encode([]PeerTab{})
	}))
	defer srv.Close()

	p := NewPoller()
	cfg := PeerCfg{Name: "slow", URL: srv.URL}
	p.Start([]PeerCfg{cfg})
	time.Sleep(500 * time.Millisecond)

	statuses := p.Status()
	if len(statuses) == 0 {
		t.Fatal("no status")
	}
	s := statuses[0]
	if s.Reachable {
		t.Errorf("slow peer should time out and be unreachable (err: %s)", s.ErrorMsg)
	}
}

func TestPoller_OldPeerMissingFields(t *testing.T) {
	// Older phi peers may lack last_activity_unix/busy — should degrade gracefully
	raw := `[{"id":"t1","coder":"bash","title":"old-session"}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raw))
	}))
	defer srv.Close()

	p := NewPoller()
	cfg := PeerCfg{Name: "oldphi", URL: srv.URL}
	p.Start([]PeerCfg{cfg})
	time.Sleep(100 * time.Millisecond)

	statuses := p.Status()
	if len(statuses) == 0 {
		t.Fatal("no status")
	}
	s := statuses[0]
	if !s.Reachable {
		t.Errorf("old peer with fewer fields should still parse (err: %s)", s.ErrorMsg)
	}
	if s.TabCount != 1 {
		t.Errorf("expected 1 tab, got %d", s.TabCount)
	}
	if s.BusyCount != 0 {
		t.Errorf("expected 0 busy (field missing = false), got %d", s.BusyCount)
	}
}

func TestPoller_NoPeers(t *testing.T) {
	p := NewPoller()
	p.Start([]PeerCfg{})

	statuses := p.Status()
	if len(statuses) != 0 {
		t.Errorf("expected 0 statuses for no peers, got %d", len(statuses))
	}
}

func TestPoller_BusyMath(t *testing.T) {
	tabs := []PeerTab{
		{ID: "t1", Busy: true},
		{ID: "t2", Busy: true},
		{ID: "t3", Busy: false},
		{ID: "t4", Busy: false},
	}
	srv := makeTabServer(t, tabs, http.StatusOK)
	defer srv.Close()

	p := NewPoller()
	cfg := PeerCfg{Name: "busy-test", URL: srv.URL}
	p.Start([]PeerCfg{cfg})
	time.Sleep(100 * time.Millisecond)

	statuses := p.Status()
	if len(statuses) == 0 {
		t.Fatal("no status")
	}
	s := statuses[0]
	if s.TabCount != 4 {
		t.Errorf("expected 4 tabs, got %d", s.TabCount)
	}
	if s.BusyCount != 2 {
		t.Errorf("expected 2 busy, got %d", s.BusyCount)
	}
}

// TestPoller_VersionAndIdleMin exercises the new fields promised in
// plan §3.4: the poller pulls /api/version in parallel and computes
// idle_min from the most recent LastActivityUnix across tabs.
func TestPoller_VersionAndIdleMin(t *testing.T) {
	tabs := []PeerTab{
		{ID: "t1", Busy: true, LastActivityUnix: time.Now().Add(-2 * time.Minute).Unix()},
		{ID: "t2", Busy: false, LastActivityUnix: time.Now().Add(-30 * time.Second).Unix()},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/terminals", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(tabs)
	})
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"version": "0.8.0"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := NewPoller()
	p.Start([]PeerCfg{{Name: "ver", URL: srv.URL}})
	time.Sleep(150 * time.Millisecond)

	statuses := p.Status()
	if len(statuses) == 0 {
		t.Fatal("no status")
	}
	s := statuses[0]
	if s.Version != "0.8.0" {
		t.Errorf("expected version 0.8.0, got %q", s.Version)
	}
	// Most recent activity was t2 at -30s, so idle_min should be 0 (rounded down).
	if s.IdleMin < 0 || s.IdleMin > 1 {
		t.Errorf("expected idle_min ~0, got %d", s.IdleMin)
	}
}

// TestPoller_VersionUnknownOldPeer makes sure a peer that lacks
// /api/version (returns 404) still gets tabs reported with version="".
func TestPoller_VersionUnknownOldPeer(t *testing.T) {
	tabs := []PeerTab{{ID: "t1", Coder: "bash"}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/terminals", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(tabs)
	})
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := NewPoller()
	p.Start([]PeerCfg{{Name: "oldphi", URL: srv.URL}})
	time.Sleep(150 * time.Millisecond)

	statuses := p.Status()
	if len(statuses) == 0 {
		t.Fatal("no status")
	}
	s := statuses[0]
	if !s.Reachable {
		t.Errorf("old peer should still be reachable, got err: %s", s.ErrorMsg)
	}
	if s.TabCount != 1 {
		t.Errorf("expected 1 tab, got %d", s.TabCount)
	}
	if s.Version != "" {
		t.Errorf("expected empty version on old peer, got %q", s.Version)
	}
}
