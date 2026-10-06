package phic

import (
	"os"
	"path/filepath"
	"strings"
)

// desktopProfile is the same non-secret row read and written by desktop.
// IDs, names, origins and rail order are preserved, including legacy aliases.
type desktopProfile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Origin   string `json:"origin"`
	LastUsed string `json:"lastUsed,omitempty"`
}

type serverState struct {
	profile   desktopProfile
	api       *apiClient
	identity  serverIdentity
	selection *SelectResult
	frontiers map[string]recordingCursor
}

func (s *serverState) remember(sel SelectResult) { copy := sel; s.selection = &copy }

type serverIdentity struct {
	Hostname   string   `json:"hostname"`
	Theme      string   `json:"theme_color"`
	Workspaces []string `json:"workspaces"`
}

func desktopProfilePaths(configDir string) []string {
	return []string{filepath.Join(configDir, "phi-client", "profiles.json"), filepath.Join(configDir, "phi-desktop-electron", "profiles.json"), filepath.Join(configDir, "Phi", "profiles.json")}
}

func readDesktopProfiles(file string) ([]desktopProfile, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	d, err := parseDesktopDocument(data)
	if err != nil {
		return nil, err
	}
	return d.profiles(), nil
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
	profiles := d.profiles()
	selected := 0
	if cfg.ServerExplicit {
		p, err := store.add(cfg.Server)
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
		origin, host, err := desktopEndpoint(cfg.Server)
		if err != nil {
			return nil, 0, err
		}
		// Offer localhost without requiring or saving it before the user chooses.
		profiles = append(profiles, desktopProfile{Name: host, Origin: origin})
	} else {
		for i, p := range profiles {
			if strings.Compare(p.LastUsed, profiles[selected].LastUsed) > 0 {
				selected = i
			}
		}
	}
	return profiles, selected, nil
}

func (c *client) persistActiveProfile() error {
	if c.store == nil {
		return nil
	}
	s := c.activeServer()
	if s.profile.ID == "" {
		p, err := c.store.add(s.profile.Origin)
		if err != nil {
			return err
		}
		s.profile = p
	}
	return c.store.setLastUsed(s.profile.ID)
}
