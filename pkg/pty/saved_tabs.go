package pty

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"sort"
)

// SavedTab is durable tab intent, not a serialized operating-system process.
// Launch arguments stay on disk and never enter the public terminal DTO.
type SavedTab struct {
	PTYInstanceSnapshot
	ExtraArgs []string `json:"extra_args,omitempty"`
}

// Restore holds automatic snapshot writes until every saved slot has been
// attempted, so a crash half-way through cannot persist only the first tab.
func (m *Manager) BeginRestore() { m.restoring.Store(true) }
func (m *Manager) EndRestore()   { m.restoring.Store(false) }

func ReadSavedTabs() ([]SavedTab, error) {
	file, err := os.Open(tabsFilePath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (4<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 4<<20 {
		return nil, fmt.Errorf("saved tabs exceed size limit")
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}
	if len(entries) > 256 {
		return nil, fmt.Errorf("too many saved tabs")
	}
	tabs := make([]SavedTab, 0, len(entries))
	for index, entry := range entries {
		var tab SavedTab
		if err := json.Unmarshal(entry, &tab); err != nil {
			log.Printf("[tabs] skipping malformed saved tab %d: %v", index, err)
			continue
		}
		tabs = append(tabs, tab)
	}
	return tabs, nil
}

// Deterministic fallback order when a browser has no saved drag order.
func SortSavedTabs(tabs []SavedTab) {
	sort.SliceStable(tabs, func(i, j int) bool { return tabs[i].ID < tabs[j].ID })
}

func (inst *PTYInstance) BeginReadLoop() chan struct{} {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	if inst.readLoopDone != nil {
		return nil
	}
	inst.readLoopDone = make(chan struct{})
	return inst.readLoopDone
}

func (m *Manager) WaitForReadLoops(ctx context.Context) {
	m.mu.RLock()
	list := append([]*PTYInstance(nil), m.shutdownTabs...)
	m.mu.RUnlock()
	for _, inst := range list {
		inst.mu.Lock()
		done := inst.readLoopDone
		inst.mu.Unlock()
		if done == nil {
			continue
		}
		select {
		case <-done:
		case <-ctx.Done():
			return
		}
	}
}

func (m *Manager) BindSession(inst *PTYInstance, id string) {
	if id == "" {
		return
	}
	inst.mu.Lock()
	inst.SessionID = id
	inst.mu.Unlock()
	_ = m.scheduleSave()
}
