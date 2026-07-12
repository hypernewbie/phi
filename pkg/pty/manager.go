package pty

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/system"
)

var testTabsPath string

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

var (
	GracePeriod             = 30 * time.Minute
	RecentActivityThreshold = 2 * time.Minute
)

type PTYInstance struct {
	ID            string        `json:"id"`
	Pty           *Pty          `json:"-"`
	Cwd           string        `json:"cwd"`
	Coder         string        `json:"coder"`
	SessionID     string        `json:"session_id"`
	DetachTimer   *time.Timer   `json:"-"`
	mu            sync.Mutex
	ActiveWS      bool
	ActiveWSCount int
	ActiveClients map[string]struct{} `json:"-"`
	Pinned        bool          `json:"pinned"`
	Marked        bool          `json:"marked"`
	LastOutputAt  time.Time     `json:"-"`
	Title         string        `json:"title"`
	Workspace     string        `json:"workspace"`
	IsBusy           bool          `json:"-"`
	BusyStartTime    time.Time     `json:"-"`
	NotifiedIdle     bool          `json:"-"`
	LastActivityUnix int64         `json:"last_activity_unix"`
	Busy             bool          `json:"busy"`
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

type Manager struct {
	instances map[string]*PTYInstance
	mu        sync.RWMutex
}

func NewManager() *Manager {
	return &Manager{
		instances: make(map[string]*PTYInstance),
	}
}

// GenerateID creates a simple secure random hex ID for terminals
func GenerateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (m *Manager) Spawn(dir, command string, args []string, coder, sessionID string) (*PTYInstance, error) {
	p, err := Start(dir, command, args)
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

	_ = m.SaveState()

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

	_ = m.SaveState()

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
		list = append(list, inst)
	}
	m.mu.Unlock()

	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}

	path := tabsFilePath()
	return system.WriteFileAtomic(path, b, 0644)
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
	_ = m.SaveState()
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
	_ = m.SaveState()
	return nil
}

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

