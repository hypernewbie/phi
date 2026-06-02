package pty

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"sync"
	"time"
)

type PTYInstance struct {
	ID           string        `json:"id"`
	Pty          *Pty          `json:"-"`
	Cwd          string        `json:"cwd"`
	Coder        string        `json:"coder"`
	SessionID    string        `json:"session_id"`
	DetachTimer  *time.Timer   `json:"-"`
	mu           sync.Mutex
	ActiveWS     bool
	Pinned       bool          `json:"pinned"`
	LastOutputAt time.Time     `json:"-"`
}

func (inst *PTYInstance) UpdateActivity() {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	inst.LastOutputAt = time.Now()
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

	// Clean up from registry if the PTY process dies on its own
	go func() {
		<-p.Closed
		m.mu.Lock()
		delete(m.instances, inst.ID)
		m.mu.Unlock()
		log.Printf("[pty] PTY %s closed and removed from registry", inst.ID)
	}()

	return inst, nil
}

func (m *Manager) Get(id string) (*PTYInstance, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inst, ok := m.instances[id]
	return inst, ok
}

func (m *Manager) RegisterWS(id string) bool {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()

	if !ok {
		return false
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()

	inst.ActiveWS = true
	if inst.DetachTimer != nil {
		inst.DetachTimer.Stop()
		inst.DetachTimer = nil
		log.Printf("[pty] WS connected to %s, stopped detach timer", id)
	}
	return true
}

func (m *Manager) UnregisterWS(id string) {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()

	if !ok {
		return
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()

	inst.ActiveWS = false
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

	return inst.Pty.Kill()
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
	return nil
}

func (m *Manager) startGracePeriodTimer(inst *PTYInstance) {
	id := inst.ID
	gracePeriod := 30 * time.Minute
	inst.DetachTimer = time.AfterFunc(gracePeriod, func() {
		inst.mu.Lock()
		timeSinceLastOut := time.Since(inst.LastOutputAt)
		inst.mu.Unlock()

		// If the terminal has been active recently (e.g. output in the last 2 minutes),
		// reschedule the 30-minute grace period rather than killing it.
		if timeSinceLastOut < 2 * time.Minute {
			log.Printf("[pty] 30-min grace period expired for %s, but terminal has been active recently (%v ago). Rescheduling grace period.", id, timeSinceLastOut)
			inst.mu.Lock()
			m.startGracePeriodTimer(inst)
			inst.mu.Unlock()
			return
		}

		log.Printf("[pty] 30 minute grace period expired for %s with no recent activity. Terminating PTY.", id)
		m.Kill(id)
	})
}
