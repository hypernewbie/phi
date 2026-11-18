package phic

import (
	"fmt"
	"os"
	"strings"

	"github.com/hypernewbie/phi/internal/phiprofiles"
)

// desktopProfile is phiprofiles.Profile: the same non-secret row read and
// written by desktop, parsed by the one shared parser.
type desktopProfile = phiprofiles.Profile

type serverState struct {
	profile   desktopProfile
	api       *apiClient
	identity  serverIdentity
	health    string
	selection *SelectResult
	frontiers map[string]recordingCursor
}

func (s *serverState) remember(sel SelectResult) { copy := sel; s.selection = &copy }

type serverIdentity struct {
	Hostname   string   `json:"hostname"`
	Theme      string   `json:"theme_color"`
	Workspaces []string `json:"workspaces"`
	ActiveCwd  string   `json:"active_cwd"`
}

func (id serverIdentity) present() bool {
	return id.Theme != "" || id.Hostname != ""
}

func readDesktopProfiles(file string) ([]desktopProfile, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	d, err := phiprofiles.Parse(data)
	if err != nil {
		return nil, err
	}
	return d.Profiles(), nil
}

func loadServerProfiles(cfg config) ([]desktopProfile, int, error) {
	store, err := desktopStoreFor(cfg)
	if err != nil {
		return nil, 0, err
	}
	d, err := store.read()
	if err != nil {
		return nil, 0, err
	}
	profiles := d.Profiles()
	selected := 0
	if cfg.ServerExplicit {
		urls := parseServerURLs(cfg.Server)
		if len(urls) != 1 {
			return nil, 0, fmt.Errorf("Invalid server URL")
		}
		p, err := store.add(urls[0])
		if err != nil {
			return nil, 0, err
		}
		for i, old := range profiles {
			if old.ID == p.ID {
				return profiles, i, nil
			}
		}
		profiles = append(profiles, p)
		selected = len(profiles) - 1
	} else if len(profiles) == 0 {
		selected = -1 // Desktop's empty rail has Add, not an invented localhost profile.
	} else {
		for i, p := range profiles {
			if strings.Compare(p.LastUsed, profiles[selected].LastUsed) > 0 {
				selected = i
			}
		}
	}
	return profiles, selected, nil
}

// Reload the shared rail without replacing authentication or pane ownership.
// A removed active server may keep its attachment until the user switches;
// it is no longer a saved rail entry and is never implicitly re-added.
func (c *client) reloadServerProfiles() error {
	if c.store == nil {
		return nil
	}
	d, err := c.store.read()
	if err != nil {
		return err
	}
	current := c.activeServer()
	old := append([]*serverState{}, c.servers...)
	if current != nil {
		old = append(old, current)
	}
	var next []*serverState
	selected := -1
	for _, p := range d.Profiles() {
		api, _ := newAPIClient(p.Origin)
		var state *serverState
		for _, prev := range old {
			if prev.profile.ID == p.ID && ((prev.api != nil && api != nil && prev.api.base.String() == api.base.String()) || (prev.profile.Origin == p.Origin)) {
				state = prev
				break
			}
		}
		if state == nil {
			state = &serverState{api: api}
		}
		state.profile = p
		if state == current {
			selected = len(next)
		}
		next = append(next, state)
	}
	c.currentServer = current
	c.servers, c.serverIndex = next, selected
	c.keys.servers = len(next)
	return nil
}

func (c *client) persistActiveProfile() error {
	if c.store == nil {
		return nil
	}
	s := c.activeServer()
	if s == nil {
		return nil
	}
	if s.profile.ID == "" {
		p, err := c.store.add(s.profile.Origin)
		if err != nil {
			return err
		}
		s.profile = p
	}
	return c.store.setLastUsed(s.profile.ID)
}
