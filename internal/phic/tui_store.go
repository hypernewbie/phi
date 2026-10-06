package phic

import (
	"encoding/json"

	tea "charm.land/bubbletea/v2"
)

// uiIntent is the client-only, non-secret UI state: project context, tab
// order, active tab, and panel layout. It lives in the shared desktop
// document under a versioned key so desktop's own fields and unknown keys are
// preserved, and it never contains output, cookies, passwords, prompts, or
// emulator memory.
type uiIntent struct {
	Version int                       `json:"version"`
	Servers map[string]uiServerIntent `json:"servers,omitempty"`
}

type uiServerIntent struct {
	Origin        string   `json:"origin,omitempty"`
	Project       string   `json:"project,omitempty"`
	Worktree      string   `json:"worktree,omitempty"`
	Tabs          []string `json:"tabs,omitempty"`
	Active        string   `json:"active,omitempty"`
	DiffOpen      bool     `json:"diff_open,omitempty"`
	SidebarHidden bool     `json:"sidebar_hidden,omitempty"`
	SidebarWidth  int      `json:"sidebar_width,omitempty"`
	ReaderWidth   int      `json:"reader_width,omitempty"`
}

const uiIntentKey = "phicUI"

func (s *desktopStore) readUI() (*uiIntent, error) {
	d, err := s.read()
	if err != nil {
		return nil, err
	}
	raw, ok := d.fields[uiIntentKey]
	if !ok || len(raw) == 0 {
		return &uiIntent{Version: 1, Servers: map[string]uiServerIntent{}}, nil
	}
	var ui uiIntent
	if err := json.Unmarshal(raw, &ui); err != nil {
		// A corrupt UI field is not a reason to reject the shared server
		// list; start clean and let the next save replace it.
		return &uiIntent{Version: 1, Servers: map[string]uiServerIntent{}}, nil
	}
	if ui.Version != 1 || ui.Servers == nil {
		return &uiIntent{Version: 1, Servers: map[string]uiServerIntent{}}, nil
	}
	return &ui, nil
}

func (s *desktopStore) saveUI(ui *uiIntent) error {
	if s == nil {
		return nil
	}
	defer s.lockMutation()()
	d, err := s.read()
	if err != nil {
		return err
	}
	ui.Version = 1
	if ui.Servers == nil {
		ui.Servers = map[string]uiServerIntent{}
	}
	raw, err := json.Marshal(ui)
	if err != nil {
		return err
	}
	d.fields[uiIntentKey] = raw
	return s.save(d)
}

func (m *tuiModel) loadIntent() {
	if m.uiIntent != nil || m.store == nil {
		return
	}
	ui, err := m.store.readUI()
	if err != nil {
		m.uiIntent = &uiIntent{Version: 1, Servers: map[string]uiServerIntent{}}
		return
	}
	m.uiIntent = ui
}

func (m *tuiModel) intentFor(index int) *uiServerIntent {
	m.loadIntent()
	if m.uiIntent == nil || index < 0 || index >= len(m.servers) {
		return nil
	}
	id := m.servers[index].profile.ID
	if id == "" {
		return nil
	}
	if intent, ok := m.uiIntent.Servers[id]; ok {
		if intent.Origin != "" && intent.Origin != m.originFor(index) {
			return nil
		}
		return &intent
	}
	return nil
}

// restoreIntent applies persisted tab order, active tab, and panel layout for
// the active server. A missing pane never aborts restoration.
func (m *tuiModel) restoreIntent() {
	intent := m.intentFor(m.active)
	if intent == nil {
		return
	}
	if intent.DiffOpen {
		m.diff.open = true
	}
	m.sidebarHidden = intent.SidebarHidden
	if intent.SidebarWidth > 0 {
		m.sidebarWidth = intent.SidebarWidth
	}
	if intent.ReaderWidth > 0 {
		m.readerWidth = intent.ReaderWidth
	}
	origin := m.currentOrigin()
	tabs := m.tabs[origin]
	if len(intent.Tabs) > 0 && len(tabs) > 1 {
		rank := map[string]int{}
		for i, id := range intent.Tabs {
			rank[id] = i
		}
		ordered := append([]*paneTab{}, tabs...)
		for i := 0; i < len(ordered); i++ {
			for j := i + 1; j < len(ordered); j++ {
				ri, iok := rank[ordered[i].key.ID]
				rj, jok := rank[ordered[j].key.ID]
				if !iok {
					ri = 1 << 30
				}
				if !jok {
					rj = 1 << 30
				}
				if rj < ri {
					ordered[i], ordered[j] = ordered[j], ordered[i]
				}
			}
		}
		m.tabs[origin] = ordered
	}
	if intent.Active != "" {
		for i, t := range m.tabs[origin] {
			if t.key.ID == intent.Active {
				m.activeTab[origin] = i
				break
			}
		}
	}
}

// persistIntent records the current UI intent without blocking the UI.
func (m *tuiModel) persistIntent() tea.Cmd {
	if m.store == nil {
		return nil
	}
	m.loadIntent()
	if m.uiIntent == nil {
		return nil
	}
	index := m.active
	if index < 0 || index >= len(m.servers) {
		return nil
	}
	id := m.servers[index].profile.ID
	if id == "" {
		return nil
	}
	intent := uiServerIntent{Origin: m.currentOrigin(), Project: m.project, Worktree: m.worktree, DiffOpen: m.diff.open, SidebarHidden: m.sidebarHidden, SidebarWidth: m.sidebarWidth, ReaderWidth: m.readerWidth}
	for _, t := range m.tabs[m.currentOrigin()] {
		if t.closing || t.exited {
			continue
		}
		intent.Tabs = append(intent.Tabs, t.key.ID)
		if key, ok := m.activeTabKey(); ok && key == t.key {
			intent.Active = t.key.ID
		}
	}
	m.uiIntent.Servers[id] = intent
	store := m.store
	// Commands run concurrently with Update. Never hand them the mutable map.
	ui := &uiIntent{Version: 1, Servers: map[string]uiServerIntent{}}
	for id, intent := range m.uiIntent.Servers {
		intent.Tabs = append([]string(nil), intent.Tabs...)
		ui.Servers[id] = intent
	}
	return func() tea.Msg {
		if err := store.saveUI(ui); err != nil {
			return storeDoneMsg{err: "save UI state: " + err.Error()}
		}
		return nil
	}
}

// forgetIntent removes client-only state for a removed server profile. A
// removed server never keeps stale tab intent that could resurrect a pane.
func (m *tuiModel) forgetIntent(profileID string) {
	m.loadIntent()
	if m.uiIntent == nil || profileID == "" {
		return
	}
	delete(m.uiIntent.Servers, profileID)
}
