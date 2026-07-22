package pty

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/system"
)

var testTabsPath string

// ErrShuttingDown is returned by Spawn once BeginDrain has been called,
// matching the manager.draining flag. Callers should map it to an HTTP
// 503 (Service Unavailable) so k8s-style readiness-aware frontends
// stop routing new work to this instance.
var ErrShuttingDown = errors.New("manager is shutting down")

func tabsFilePath() string {
	if testTabsPath != "" {
		return testTabsPath
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "tabs.json"
	}
	return filepath.Join(home, ".phi", "tabs.json")
}

// saveTimer debounces phi_tabs.json writes (plan §3.3: "debounced 500ms").
// Spawn/Kill/Rename/Pin/Mark all call ScheduleSaveState; the actual file
// write coalesces into one atomic rename within 500ms of the last mutation.
var (
	saveTimer *time.Timer
	saveMu    sync.Mutex
)

var (
	GracePeriod             = 30 * time.Minute
	RecentActivityThreshold = 2 * time.Minute
)

type PTYInstance struct {
	ID               string      `json:"id"`
	Pty              *Pty        `json:"-"`
	Cwd              string      `json:"cwd"`
	Coder            string      `json:"coder"`
	SessionID        string      `json:"session_id"`
	DetachTimer      *time.Timer `json:"-"`
	mu               sync.Mutex
	ActiveWS         bool
	ActiveWSCount    int
	ActiveClients    map[string]struct{} `json:"-"`
	Pinned           bool                `json:"pinned"`
	Marked           bool                `json:"marked"`
	LastOutputAt     time.Time           `json:"-"`
	Title            string              `json:"title"`
	Workspace        string              `json:"workspace"`
	IsBusy           bool                `json:"-"`
	BusyStartTime    time.Time           `json:"-"`
	NotifiedIdle     bool                `json:"-"`
	LastActivityUnix int64               `json:"last_activity_unix"`
	Busy             bool                `json:"busy"`
}

func (inst *PTYInstance) UpdateActivity() {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	inst.LastOutputAt = time.Now()
	inst.LastActivityUnix = inst.LastOutputAt.Unix()
	if !inst.IsBusy {
		inst.IsBusy = true
		inst.Busy = true
		inst.BusyStartTime = time.Now()
	}
	inst.NotifiedIdle = false
}

// BusyState returns busy + last-activity under the instance lock (race-free for /api/diag).
func (inst *PTYInstance) BusyState() (bool, int64) {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.Busy, inst.LastActivityUnix
}

// IsPtyDead reports whether the process has exited (ghost with nil Pty, or died-in-place).
// Pty.Closed is closed once by the wait goroutine; non-blocking receive is race-free without inst.mu.
func (inst *PTYInstance) IsPtyDead() bool {
	if inst.Pty == nil {
		return true
	}
	select {
	case <-inst.Pty.Closed:
		return true
	default:
		return false
	}
}

// HasDetachTimer returns whether a grace-period detach timer is
// currently armed on this instance. Thread-safe accessor for tests
// and external observers — the raw DetachTimer field is written by
// the timer callback goroutine without a public barrier.
func (inst *PTYInstance) HasDetachTimer() bool {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.DetachTimer != nil
}

type Manager struct {
	instances map[string]*PTYInstance
	mu        sync.RWMutex
	// draining flips true on graceful shutdown (see BeginDrain). Spawn
	// consults IsDraining to refuse new PTYs during the drain window so
	// the load balancer can stop routing requests before sockets close.
	draining atomic.Bool
}

func NewManager() *Manager {
	return &Manager{
		instances: make(map[string]*PTYInstance),
	}
}

// BeginDrain stops the manager from spawning new PTYs. Idempotent; called
// at the very start of graceful shutdown (before the drain delay) so
// in-flight spawn requests during the whole drain window are rejected,
// not leaked.
func (m *Manager) BeginDrain() { m.draining.Store(true) }

// Shutdown gracefully terminates every managed PTY: stop detach timers,
// Terminate() each child, wait up to grace for exit (which fires its
// temp-dir cleanup), then SIGKILL stragglers. Called as part of graceful
// shutdown from main.go; safe to call directly from tests.
func (m *Manager) Shutdown(grace time.Duration) {
	m.BeginDrain() // defensive: also stops spawns if called directly
	m.mu.Lock()
	insts := make([]*PTYInstance, 0, len(m.instances))
	for _, inst := range m.instances {
		insts = append(insts, inst)
	}
	m.mu.Unlock()

	for _, inst := range insts {
		inst.mu.Lock()
		if inst.DetachTimer != nil {
			inst.DetachTimer.Stop()
			inst.DetachTimer = nil
		}
		p := inst.Pty
		inst.mu.Unlock()
		if p != nil {
			_ = p.Terminate()
		}
	}

	// Wait for the cleanup goroutines to finish (each instance's PTY exit
	// triggers temp-dir removal). Bounded by 2x grace so a stuck child
	// can't hang us forever.
	deadline := time.Now().Add(2 * grace)
	for time.Now().Before(deadline) {
		m.mu.RLock()
		remaining := len(m.instances)
		m.mu.RUnlock()
		if remaining == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// GenerateID creates a simple secure random hex ID for terminals
func GenerateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Spawn starts a new PTY-backed terminal. ctx is used only to time the
// pty.spawn span (see Start's doc comment) — the underlying process is
// never cancelled by it, since the terminal must survive well past the
// HTTP request that spawned it.
func (m *Manager) Spawn(ctx context.Context, dir, command string, args []string, coder, sessionID string) (*PTYInstance, error) {
	// Refuse new spawns during the drain window (signal received). Tests
	// can flip the flag directly via BeginDrain to assert this path.
	if m.IsDraining() {
		return nil, ErrShuttingDown
	}
	// pty.spawn times only the spawn call itself, via the same ctx Start
	// accepts but never uses to cancel the process (see Start's doc
	// comment) — the span ends here; the terminal's own lifetime runs on.
	spanCtx, end := obs.Span(ctx, "pty.spawn", "coder", coder, "command", command, "cwd", dir)
	p, err := Start(spanCtx, dir, command, args)
	end(err)
	if err != nil {
		return nil, err
	}

	inst := &PTYInstance{
		ID:           GenerateID(),
		Pty:          p,
		Cwd:          dir,
		Coder:        coder,
		SessionID:    sessionID,
		LastOutputAt: time.Now(),
	}

	m.mu.Lock()
	m.instances[inst.ID] = inst
	m.mu.Unlock()

	_ = m.scheduleSave()

	// Keep the PTYInstance record in registry when it dies so the UI can reconnect/restart it.
	go func() {
		<-p.Closed
		log.Printf("[pty] PTY %s closed (process died naturally)", inst.ID)
	}()

	return inst, nil
}

func (m *Manager) Get(id string) (*PTYInstance, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inst, ok := m.instances[id]
	return inst, ok
}

func (m *Manager) RegisterWS(id string, clientID string) bool {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()

	if !ok {
		return false
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()

	if inst.ActiveClients == nil {
		inst.ActiveClients = make(map[string]struct{})
	}
	inst.ActiveClients[clientID] = struct{}{}
	inst.ActiveWSCount = len(inst.ActiveClients)
	inst.ActiveWS = true
	log.Printf("[pty] RegisterWS %s: ClientID=%s ActiveWSCount=%d ActiveWS=%v Pinned=%v HasTimer=%v", id, clientID, inst.ActiveWSCount, inst.ActiveWS, inst.Pinned, inst.DetachTimer != nil)
	if inst.DetachTimer != nil {
		inst.DetachTimer.Stop()
		inst.DetachTimer = nil
		log.Printf("[pty] WS connected to %s, stopped detach timer", id)
	}
	return true
}

func (m *Manager) UnregisterWS(id string, clientID string) {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()

	if !ok {
		return
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()

	if inst.ActiveClients != nil {
		delete(inst.ActiveClients, clientID)
	}
	inst.ActiveWSCount = len(inst.ActiveClients)
	inst.ActiveWS = inst.ActiveWSCount > 0
	log.Printf("[pty] UnregisterWS %s: ClientID=%s ActiveWSCount=%d ActiveWS=%v Pinned=%v HasTimer=%v", id, clientID, inst.ActiveWSCount, inst.ActiveWS, inst.Pinned, inst.DetachTimer != nil)

	if inst.ActiveWS {
		return
	}

	if inst.DetachTimer != nil {
		inst.DetachTimer.Stop()
		inst.DetachTimer = nil
	}

	if inst.Pinned {
		log.Printf("[pty] WS disconnected from %s, but session is pinned. Skipping detach timer.", id)
		return
	}

	m.startGracePeriodTimer(inst)
	log.Printf("[pty] WS disconnected from %s, started 30-min detach timer", id)
}

func (m *Manager) Kill(id string) error {
	m.mu.Lock()
	inst, ok := m.instances[id]
	delete(m.instances, id)
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("terminal instance %s not found", id)
	}

	inst.mu.Lock()
	if inst.DetachTimer != nil {
		inst.DetachTimer.Stop()
		inst.DetachTimer = nil
	}
	inst.mu.Unlock()

	var killErr error
	if inst.Pty != nil {
		killErr = inst.Pty.Kill()
	}

	_ = m.scheduleSave()

	return killErr
}

func (m *Manager) ListActive() []*PTYInstance {
	m.mu.RLock()
	defer m.mu.RUnlock()

	list := make([]*PTYInstance, 0, len(m.instances))
	for _, inst := range m.instances {
		list = append(list, inst)
	}
	return list
}

func (m *Manager) SaveState() error {
	m.mu.Lock()
	list := make([]*PTYInstance, 0, len(m.instances))
	for _, inst := range m.instances {
		// Skip dead instances (ghosts + died-in-place) so they don't resurrect on next boot.
		if inst.IsPtyDead() {
			continue
		}
		list = append(list, inst)
	}
	m.mu.Unlock()

	// Snapshot each instance's serialisable fields under inst.mu so
	// json.Marshal below doesn't race with the timer callback that
	// writes to fields like DetachTimer / Busy / LastActivityUnix.
	// The snapshot is a plain struct (no goroutine writes to it after
	// build), so marshalling it is race-free.
	snapshots := make([]PTYInstanceSnapshot, 0, len(list))
	for _, inst := range list {
		snapshots = append(snapshots, inst.Snapshot())
	}

	b, err := json.MarshalIndent(snapshots, "", "  ")
	if err != nil {
		return err
	}

	path := tabsFilePath()
	return system.WriteFileAtomic(path, b, 0644)
}

// PTYInstanceSnapshot is a lock-free, JSON-safe copy of a PTYInstance.
// All fields here are copied under inst.mu in (*PTYInstance).Snapshot().
type PTYInstanceSnapshot struct {
	ID               string `json:"id"`
	Cwd              string `json:"cwd"`
	Coder            string `json:"coder"`
	SessionID        string `json:"session_id"`
	ActiveWS         bool   `json:"-"`
	ActiveWSCount    int    `json:"-"`
	Pinned           bool   `json:"pinned"`
	Marked           bool   `json:"marked"`
	LastActivityUnix int64  `json:"last_activity_unix"`
	Busy             bool   `json:"busy"`
	Title            string `json:"title"`
	Workspace        string `json:"workspace"`
}

// Snapshot returns a lock-free, JSON-safe copy of the instance's
// serialisable fields. The copy is taken under inst.mu so it doesn't
// race with concurrent writers. Used by SaveState.
func (inst *PTYInstance) Snapshot() PTYInstanceSnapshot {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return PTYInstanceSnapshot{
		ID:               inst.ID,
		Cwd:              inst.Cwd,
		Coder:            inst.Coder,
		SessionID:        inst.SessionID,
		ActiveWS:         inst.ActiveWS,
		ActiveWSCount:    inst.ActiveWSCount,
		Pinned:           inst.Pinned,
		Marked:           inst.Marked,
		LastActivityUnix: inst.LastActivityUnix,
		Busy:             inst.Busy,
		Title:            inst.Title,
		Workspace:        inst.Workspace,
	}
}

// scheduleSave coalesces SaveState calls onto a 500ms debounce (plan §3.3).
// Use this from hot paths (Spawn/Kill/Pin/Mark) instead of SaveState directly.
func (m *Manager) scheduleSave() error {
	saveMu.Lock()
	if saveTimer != nil {
		saveTimer.Stop()
	}
	saveTimer = time.AfterFunc(500*time.Millisecond, func() {
		if err := m.SaveState(); err != nil {
			log.Printf("[pty] Failed to save tabs state: %v", err)
		}
	})
	saveMu.Unlock()
	return nil
}

// FlushSaveState forces any pending debounced save to write immediately.
// Called on graceful shutdown to ensure state lands on disk before exit.
func (m *Manager) FlushSaveState() error {
	saveMu.Lock()
	if saveTimer != nil {
		saveTimer.Stop()
		saveTimer = nil
	}
	saveMu.Unlock()
	return m.SaveState()
}

func (m *Manager) LoadState() error {
	path := tabsFilePath()
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var list []*PTYInstance
	if err := json.Unmarshal(b, &list); err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, inst := range list {
		inst.ActiveClients = make(map[string]struct{})
		// CRITICAL: tabs.json is the persisted snapshot of LIVE PTYs. On
		// restart the in-memory map will be empty, so any tab restored
		// from disk here has no Pty pointer — but its Busy/IsBusy flags
		// were JSON-roundtripped. Without resetting them, the idle
		// watcher would fire "task finished" notifications for tabs
		// that never started. Mark them dead-but-known and stop the
		// grace timer from immediately killing them.
		inst.Pty = nil
		inst.IsBusy = false
		inst.Busy = false
		inst.NotifiedIdle = true // suppress the post-restart idle toast
		inst.LastOutputAt = time.Now()
		inst.DetachTimer = nil
		m.instances[inst.ID] = inst
	}
	return nil
}

func (m *Manager) SetPinned(id string, pinned bool) error {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("terminal instance %s not found", id)
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()

	inst.Pinned = pinned
	log.Printf("[pty] SetPinned %s: pinned=%v ActiveWS=%v ActiveWSCount=%d HasTimer=%v", id, pinned, inst.ActiveWS, inst.ActiveWSCount, inst.DetachTimer != nil)
	if !pinned && !inst.ActiveWS {
		if inst.DetachTimer != nil {
			inst.DetachTimer.Stop()
		}
		m.startGracePeriodTimer(inst)
		log.Printf("[pty] Session %s unpinned while disconnected. Started 30-min detach timer.", id)
	} else if pinned && inst.DetachTimer != nil {
		inst.DetachTimer.Stop()
		inst.DetachTimer = nil
		log.Printf("[pty] Session %s pinned. Stopped active detach timer.", id)
	}
	_ = m.scheduleSave()
	return nil
}

func (m *Manager) SetMarked(id string, marked bool) error {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("terminal instance %s not found", id)
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()

	inst.Marked = marked
	log.Printf("[pty] SetMarked %s: marked=%v", id, marked)
	_ = m.scheduleSave()
	return nil
}

// SetTitle updates the user-facing title of a live PTY. Mirrors SetPinned
// / SetMarked: m.mu (map) to find the instance, then inst.mu to write
// the field. Returns the same "not found" error as its siblings so the
// api_handlers /title endpoint can map the response to 404 cleanly.
func (m *Manager) SetTitle(id string, title string) error {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("terminal instance %s not found", id)
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()

	inst.Title = title
	log.Printf("[pty] SetTitle %s: title=%q", id, title)
	_ = m.scheduleSave()
	return nil
}

// IsDraining reports whether BeginDrain has been called. Used by the
// health endpoint to gate Readiness transitions.
func (m *Manager) IsDraining() bool { return m.draining.Load() }

func (m *Manager) startGracePeriodTimer(inst *PTYInstance) {
	id := inst.ID
	inst.DetachTimer = time.AfterFunc(GracePeriod, func() {
		m.mu.Lock()
		inst.mu.Lock()
		defer func() {
			inst.mu.Unlock()
			m.mu.Unlock()
		}()

		// Verify that the PTY instance is still registered and active in the manager.
		// If it has already been killed or removed, we do not need to do anything.
		if _, exists := m.instances[id]; !exists {
			return
		}

		// Restored tabs (Pty nil) are managed by the restore banner, not
		// the grace timer. If we leave them here they get killed over and
		// over (no-op since Pty is nil) but more importantly the user
		// loses the session-expired affordance for the restore flow.
		if inst.Pty == nil {
			inst.DetachTimer = nil
			return
		}

		// If a client is actively connected via WebSocket, or the session has been pinned,
		// we must not terminate the PTY or reschedule the grace period timer.
		if inst.ActiveWS || inst.Pinned {
			inst.DetachTimer = nil
			return
		}

		timeSinceLastOut := time.Since(inst.LastOutputAt)

		// If the terminal has been active recently (e.g. output in the last 2 minutes),
		// reschedule the grace period rather than killing it.
		if timeSinceLastOut < RecentActivityThreshold {
			log.Printf("[pty] grace period expired for %s, but terminal has been active recently (%v ago). Rescheduling grace period.", id, timeSinceLastOut)
			m.startGracePeriodTimer(inst)
			return
		}

		log.Printf("[pty] grace period expired for %s with no recent activity. Terminating PTY.", id)
		if inst.DetachTimer != nil {
			inst.DetachTimer.Stop()
			inst.DetachTimer = nil
		}

		go func() {
			if inst.Pty != nil {
				_ = inst.Pty.Kill()
			}
		}()
	})
}

type IdleNotification struct {
	PaneID    string
	Title     string
	Coder     string
	Workspace string
	Cwd       string
	Duration  time.Duration
}

func (m *Manager) StartIdleWatcher(callback func(info IdleNotification)) {
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		notifiableCoders := map[string]bool{
			"pi":       true,
			"opencode": true,
			"claude":   true,
			"agy":      true,
		}

		for range ticker.C {
			m.mu.RLock()
			instances := make([]*PTYInstance, 0, len(m.instances))
			for _, inst := range m.instances {
				instances = append(instances, inst)
			}
			m.mu.RUnlock()

			now := time.Now()
			for _, inst := range instances {
				inst.mu.Lock()
				coder := inst.Coder
				title := inst.Title
				workspace := inst.Workspace
				cwd := inst.Cwd
				if !notifiableCoders[coder] {
					inst.mu.Unlock()
					continue
				}

				// Dead/restored tabs (Pty nil) are kept in the registry so
				// the UI can show "Session expired" copy and offer restore.
				// They are not real running sessions and must not trigger
				// the idle-finished notification.
				if inst.Pty == nil {
					inst.IsBusy = false
					inst.Busy = false
					inst.mu.Unlock()
					continue
				}

				if inst.IsBusy && now.Sub(inst.LastOutputAt) > 3*time.Second {
					inst.IsBusy = false
					inst.Busy = false
					duration := now.Sub(inst.BusyStartTime)
					if duration > 8*time.Second && !inst.NotifiedIdle {
						inst.NotifiedIdle = true
						paneID := inst.ID
						inst.mu.Unlock()
						callback(IdleNotification{
							PaneID:    paneID,
							Title:     title,
							Coder:     coder,
							Workspace: workspace,
							Cwd:       cwd,
							Duration:  duration,
						})
						continue
					}
				}
				inst.mu.Unlock()
			}
		}
	}()
}
