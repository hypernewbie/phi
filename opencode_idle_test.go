package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestShouldStop(t *testing.T) {
	base := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name         string
		now          time.Time
		lastActivity time.Time
		timeout      time.Duration
		latched      bool
		want         bool
	}{
		{
			name:         "disabled when timeout is zero",
			now:          base.Add(2 * time.Hour),
			lastActivity: base,
			timeout:      0,
			latched:      false,
			want:         false,
		},
		{
			name:         "disabled when timeout is negative",
			now:          base.Add(2 * time.Hour),
			lastActivity: base,
			timeout:      -10 * time.Minute,
			latched:      false,
			want:         false,
		},
		{
			name:         "blocked when latched",
			now:          base.Add(2 * time.Hour),
			lastActivity: base,
			timeout:      60 * time.Minute,
			latched:      true,
			want:         false,
		},
		{
			name:         "zero last activity returns false",
			now:          base.Add(2 * time.Hour),
			lastActivity: time.Time{},
			timeout:      60 * time.Minute,
			latched:      false,
			want:         false,
		},
		{
			name:         "before timeout returns false",
			now:          base.Add(59 * time.Minute),
			lastActivity: base,
			timeout:      60 * time.Minute,
			latched:      false,
			want:         false,
		},
		{
			name:         "exact timeout returns true",
			now:          base.Add(60 * time.Minute),
			lastActivity: base,
			timeout:      60 * time.Minute,
			latched:      false,
			want:         true,
		},
		{
			name:         "past timeout returns true",
			now:          base.Add(90 * time.Minute),
			lastActivity: base,
			timeout:      60 * time.Minute,
			latched:      false,
			want:         true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldStop(tc.now, tc.lastActivity, tc.timeout, tc.latched)
			if got != tc.want {
				t.Errorf("shouldStop() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestOpenCodeIdleWatcherCycle(t *testing.T) {
	base := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	currentTime := base
	lastActivity := base
	serviceRunning := true
	stopCalls := 0
	statusCalls := 0

	w := &openCodeIdleWatcher{
		stopCh: make(chan struct{}),
		nowFunc: func() time.Time {
			return currentTime
		},
		idleMinutesFunc: func() int {
			return 60
		},
		lastActivityFunc: func() time.Time {
			return lastActivity
		},
		activeTabsCount: func() int {
			return 0
		},
		statusFunc: func(ctx context.Context) (bool, bool, error) {
			statusCalls++
			return true, serviceRunning, nil
		},
		stopFunc: func(ctx context.Context) error {
			stopCalls++
			serviceRunning = false
			return nil
		},
	}

	// 1. At 30m idle: nothing should happen
	currentTime = base.Add(30 * time.Minute)
	w.checkOnce(context.Background())
	if stopCalls != 0 || statusCalls != 0 {
		t.Fatalf("expected no actions before timeout; stopCalls=%d statusCalls=%d", stopCalls, statusCalls)
	}

	// 2. At 60m idle: service should be stopped and latched
	currentTime = base.Add(60 * time.Minute)
	w.checkOnce(context.Background())
	if statusCalls != 1 || stopCalls != 1 {
		t.Fatalf("expected 1 status call and 1 stop call; got statusCalls=%d stopCalls=%d", statusCalls, stopCalls)
	}
	if !w.latched {
		t.Fatalf("expected watcher to be latched after stopping service")
	}

	// 3. At 65m with no new activity: latch prevents any further status or stop calls
	currentTime = base.Add(65 * time.Minute)
	w.checkOnce(context.Background())
	if statusCalls != 1 || stopCalls != 1 {
		t.Fatalf("latch failed: statusCalls=%d stopCalls=%d", statusCalls, stopCalls)
	}

	// 4. New activity occurs at 70m: should unlatch
	lastActivity = base.Add(70 * time.Minute)
	currentTime = base.Add(75 * time.Minute)
	serviceRunning = true // user launched a new session
	w.checkOnce(context.Background())
	if w.latched {
		t.Fatalf("expected watcher to be unlatched after new activity")
	}
	if stopCalls != 1 {
		t.Fatalf("expected no new stop calls yet; got %d", stopCalls)
	}

	// 5. At 130m (60m after new activity at 70m): should stop again!
	currentTime = base.Add(130 * time.Minute)
	w.checkOnce(context.Background())
	if stopCalls != 2 {
		t.Fatalf("expected second stop call; got %d", stopCalls)
	}
	if !w.latched {
		t.Fatalf("expected watcher to be latched after second stop")
	}
}

func TestOpenCodeIdleWatcherAlreadyStoppedLatches(t *testing.T) {
	base := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	statusCalls := 0
	stopCalls := 0

	w := &openCodeIdleWatcher{
		stopCh: make(chan struct{}),
		nowFunc: func() time.Time {
			return base.Add(2 * time.Hour)
		},
		idleMinutesFunc: func() int {
			return 60
		},
		lastActivityFunc: func() time.Time {
			return base
		},
		statusFunc: func(ctx context.Context) (bool, bool, error) {
			statusCalls++
			return true, false, nil // already stopped
		},
		stopFunc: func(ctx context.Context) error {
			stopCalls++
			return nil
		},
	}

	w.checkOnce(context.Background())
	if statusCalls != 1 || stopCalls != 0 {
		t.Fatalf("expected 1 status call and 0 stop calls; got statusCalls=%d stopCalls=%d", statusCalls, stopCalls)
	}
	if !w.latched {
		t.Fatalf("expected watcher to latch when service is already stopped")
	}

	// Next tick does nothing
	w.checkOnce(context.Background())
	if statusCalls != 1 {
		t.Fatalf("expected latch to prevent redundant status calls; got %d", statusCalls)
	}
}

func TestOpenCodeIdleWatcherFailureBackoff(t *testing.T) {
	base := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	stopCalls := 0

	w := &openCodeIdleWatcher{
		stopCh: make(chan struct{}),
		nowFunc: func() time.Time {
			return base.Add(2 * time.Hour)
		},
		idleMinutesFunc: func() int {
			return 60
		},
		lastActivityFunc: func() time.Time {
			return base
		},
		statusFunc: func(ctx context.Context) (bool, bool, error) {
			return true, true, nil
		},
		stopFunc: func(ctx context.Context) error {
			stopCalls++
			return errors.New("simulated stop error")
		},
	}

	// First 2 failures: retry continues
	w.checkOnce(context.Background())
	if stopCalls != 1 || w.latched {
		t.Fatalf("attempt 1: stopCalls=%d latched=%v", stopCalls, w.latched)
	}

	w.checkOnce(context.Background())
	if stopCalls != 2 || w.latched {
		t.Fatalf("attempt 2: stopCalls=%d latched=%v", stopCalls, w.latched)
	}

	// 3rd failure: should latch/back off
	w.checkOnce(context.Background())
	if stopCalls != 3 || !w.latched {
		t.Fatalf("attempt 3: stopCalls=%d latched=%v", stopCalls, w.latched)
	}

	// 4th tick: latch prevents further stop calls
	w.checkOnce(context.Background())
	if stopCalls != 3 {
		t.Fatalf("attempt 4: expected backoff to hold; stopCalls=%d", stopCalls)
	}
}

func TestOpenCodeIdleStopAPI(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "phi-idle-config-test")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	testConfigPath = filepath.Join(tmpDir, "config.json")
	defer func() { testConfigPath = "" }()

	// Save initial config
	cfg := loadConfig()
	cfg.OpenCodeIdleStopMinutes = 0
	saveConfig(cfg)

	// 1. Method Not Allowed
	req := httptest.NewRequest(http.MethodGet, "/api/config/opencode-idle-stop", nil)
	w := httptest.NewRecorder()
	handleOpenCodeIdleStop(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}

	// 2. Bad JSON
	req = httptest.NewRequest(http.MethodPost, "/api/config/opencode-idle-stop", bytes.NewBufferString("invalid json"))
	w = httptest.NewRecorder()
	handleOpenCodeIdleStop(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad json, got %d", w.Code)
	}

	// 3. Clamping test table
	clampTests := []struct {
		input int
		want  int
	}{
		{input: 0, want: 0},
		{input: -5, want: 0},
		{input: 2, want: 5},     // clamped to min 5
		{input: 60, want: 60},   // valid
		{input: 120, want: 120}, // valid
		{input: 5000, want: 1440}, // clamped to max 1440 (24h)
	}

	for _, ct := range clampTests {
		body, _ := json.Marshal(map[string]int{"minutes": ct.input})
		req = httptest.NewRequest(http.MethodPost, "/api/config/opencode-idle-stop", bytes.NewReader(body))
		w = httptest.NewRecorder()
		handleOpenCodeIdleStop(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("input %d: expected 200, got %d", ct.input, w.Code)
		}

		var resp map[string]int
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode resp: %v", err)
		}
		if resp["opencode_idle_stop_minutes"] != ct.want {
			t.Errorf("input %d: got %d, want %d", ct.input, resp["opencode_idle_stop_minutes"], ct.want)
		}

		saved := loadConfig()
		if saved.OpenCodeIdleStopMinutes != ct.want {
			t.Errorf("saved config input %d: got %d, want %d", ct.input, saved.OpenCodeIdleStopMinutes, ct.want)
		}
	}

	// 4. Verify /api/config includes opencode_idle_stop_minutes
	req = httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w = httptest.NewRecorder()
	handleConfig(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/config: expected 200, got %d", w.Code)
	}
	var confResp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&confResp); err != nil {
		t.Fatalf("decode config resp: %v", err)
	}
	if val, ok := confResp["opencode_idle_stop_minutes"]; !ok || val != float64(1440) {
		t.Fatalf("expected opencode_idle_stop_minutes in /api/config; got %v", confResp["opencode_idle_stop_minutes"])
	}
}
