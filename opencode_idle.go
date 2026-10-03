package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/coders"
)

// shouldStop calculates whether an idle stop should be triggered.
func shouldStop(now, lastActivity time.Time, timeout time.Duration, latched bool) bool {
	if timeout <= 0 {
		return false
	}
	if latched {
		return false
	}
	if lastActivity.IsZero() {
		return false
	}
	return !now.Before(lastActivity.Add(timeout))
}

type openCodeIdleWatcher struct {
	mu                  sync.Mutex
	stopCh              chan struct{}
	running             bool
	latched             bool
	lastActivityAtLatch time.Time
	failCount           int

	nowFunc          func() time.Time
	statusFunc       func(ctx context.Context) (supported bool, running bool, err error)
	stopFunc         func(ctx context.Context) error
	lastActivityFunc func() time.Time
	activeTabsCount  func() int
	idleMinutesFunc  func() int
	isShuttingDown   func() bool
}

func newOpenCodeIdleWatcher() *openCodeIdleWatcher {
	return &openCodeIdleWatcher{
		stopCh:  make(chan struct{}),
		nowFunc: time.Now,
		statusFunc: func(ctx context.Context) (bool, bool, error) {
			ensureCoderManager()
			c, ok := coderManager.Get("opencode")
			if !ok || c.SessionSource != "opencode_v2" || c.OpenCodeMode == "legacy" {
				return false, false, nil
			}
			running, err := getCachedOpenCodeStatus(ctx, c)
			return true, running, err
		},
		stopFunc: func(ctx context.Context) error {
			ensureCoderManager()
			c, ok := coderManager.Get("opencode")
			if !ok || c.SessionSource != "opencode_v2" || c.OpenCodeMode == "legacy" {
				return nil
			}
			ctxTimeout, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			_, err := coders.OpenCodeService(ctxTimeout, c, "stop")
			invalidateOpenCodeServiceCache()
			return err
		},
		lastActivityFunc: func() time.Time {
			if ptyManager == nil {
				return time.Time{}
			}
			return ptyManager.LastOpenCodeActivity()
		},
		activeTabsCount: func() int {
			if ptyManager == nil {
				return 0
			}
			return ptyManager.ActiveOpenCodeTabsCount()
		},
		idleMinutesFunc: func() int {
			return loadConfig().OpenCodeIdleStopMinutes
		},
		isShuttingDown: func() bool {
			return shuttingDown.Load() || (ptyManager != nil && ptyManager.IsDraining())
		},
	}
}

func (w *openCodeIdleWatcher) checkOnce(ctx context.Context) {
	if w.isShuttingDown != nil && w.isShuttingDown() {
		return
	}

	idleMinutes := 0
	if w.idleMinutesFunc != nil {
		idleMinutes = w.idleMinutesFunc()
	}
	if idleMinutes <= 0 {
		w.mu.Lock()
		w.latched = false
		w.failCount = 0
		w.mu.Unlock()
		return
	}

	now := time.Now()
	if w.nowFunc != nil {
		now = w.nowFunc()
	}

	var lastAct time.Time
	if w.lastActivityFunc != nil {
		lastAct = w.lastActivityFunc()
	}

	timeout := time.Duration(idleMinutes) * time.Minute

	w.mu.Lock()
	// If new activity occurred since we latched, unlatch.
	if w.latched && lastAct.After(w.lastActivityAtLatch) {
		w.latched = false
		w.failCount = 0
	}

	shouldStopService := shouldStop(now, lastAct, timeout, w.latched)
	w.mu.Unlock()

	if !shouldStopService {
		return
	}

	if w.statusFunc == nil {
		return
	}

	supported, running, err := w.statusFunc(ctx)
	if err != nil || !supported {
		return
	}

	if !running {
		// Already stopped. Latch so we don't query status every tick.
		w.mu.Lock()
		w.latched = true
		w.lastActivityAtLatch = lastAct
		w.mu.Unlock()
		return
	}

	// Service is running and idle timeout exceeded: stop it.
	tabs := 0
	if w.activeTabsCount != nil {
		tabs = w.activeTabsCount()
	}

	if w.stopFunc == nil {
		return
	}

	idleDuration := now.Sub(lastAct).Round(time.Minute)
	log.Printf("[opencode-idle] stopping OpenCode background service after %v idle (open tabs: %d)", idleDuration, tabs)

	stopErr := w.stopFunc(ctx)
	w.mu.Lock()
	defer w.mu.Unlock()
	if stopErr != nil {
		w.failCount++
		log.Printf("[opencode-idle] failed to stop service (attempt %d/3): %v", w.failCount, stopErr)
		if w.failCount >= 3 {
			log.Printf("[opencode-idle] backing off until next OpenCode activity")
			w.latched = true
			w.lastActivityAtLatch = lastAct
		}
		return
	}

	w.latched = true
	w.lastActivityAtLatch = lastAct
	w.failCount = 0
	log.Printf("[opencode-idle] OpenCode background service successfully stopped")
}

func (w *openCodeIdleWatcher) start(interval time.Duration) {
	w.mu.Lock()
	if w.running {
		w.mu.Unlock()
		return
	}
	w.running = true
	w.mu.Unlock()

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-w.stopCh:
				return
			case <-ticker.C:
				w.checkOnce(context.Background())
			}
		}
	}()
}

func (w *openCodeIdleWatcher) stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.running {
		return
	}
	w.running = false
	close(w.stopCh)
}

var defaultOpenCodeIdleWatcher *openCodeIdleWatcher
var openCodeIdleWatcherMu sync.Mutex

func startOpenCodeIdleWatcher() {
	openCodeIdleWatcherMu.Lock()
	defer openCodeIdleWatcherMu.Unlock()
	if defaultOpenCodeIdleWatcher != nil {
		return
	}
	defaultOpenCodeIdleWatcher = newOpenCodeIdleWatcher()
	defaultOpenCodeIdleWatcher.start(60 * time.Second)
}

func stopOpenCodeIdleWatcher() {
	openCodeIdleWatcherMu.Lock()
	defer openCodeIdleWatcherMu.Unlock()
	if defaultOpenCodeIdleWatcher != nil {
		defaultOpenCodeIdleWatcher.stop()
		defaultOpenCodeIdleWatcher = nil
	}
}
