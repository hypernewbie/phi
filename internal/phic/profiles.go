package phic

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// desktopProfile is the desktop controller's non-secret profiles.json row.
// The client reads it, in rail order, and never writes desktop preferences.
type desktopProfile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Origin   string `json:"origin"`
	LastUsed string `json:"lastUsed"`
}

type serverState struct {
	profile   desktopProfile
	api       *apiClient
	identity  serverIdentity
	selection *SelectResult
}

func (s *serverState) remember(sel SelectResult) {
	copy := sel
	s.selection = &copy
}

type serverIdentity struct {
	Hostname   string   `json:"hostname"`
	Theme      string   `json:"theme_color"`
	Workspaces []string `json:"workspaces"`
}

func desktopProfilePaths(configDir string) []string {
	return []string{filepath.Join(configDir, "phi-client", "profiles.json"), filepath.Join(configDir, "phi-desktop-electron", "profiles.json")}
}

func readDesktopProfiles(file string) ([]desktopProfile, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 1<<20+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 1<<20 {
		return nil, fmt.Errorf("phic: desktop profiles file exceeds 1 MiB")
	}
	var store struct {
		Profiles []json.RawMessage `json:"profiles"`
	}
	if err = json.Unmarshal(data, &store); err != nil || store.Profiles == nil {
		return nil, fmt.Errorf("phic: invalid desktop profiles file %s", QuotedID(file))
	}
	var profiles []desktopProfile
	seenID := map[string]bool{}
	seenOrigin := map[string]bool{}
	for _, row := range store.Profiles {
		var p desktopProfile
		if json.Unmarshal(row, &p) != nil || p.ID == "" || p.Origin == "" || seenID[p.ID] {
			continue
		}
		api, err := newAPIClient(p.Origin)
		if err != nil {
			continue
		}
		p.Origin = api.base.String()
		if seenOrigin[p.Origin] {
			continue
		}
		if p.Name == "" {
			p.Name = p.Origin
		}
		seenID[p.ID] = true
		seenOrigin[p.Origin] = true
		profiles = append(profiles, p)
	}
	return profiles, nil
}

func loadServerProfiles(cfg config) ([]desktopProfile, int, error) {
	var profiles []desktopProfile
	// --server is an isolated override unless a profiles file is also explicit.
	if cfg.Profiles != "" || !cfg.ServerExplicit {
		paths := []string{cfg.Profiles}
		if cfg.Profiles == "" {
			dir, err := os.UserConfigDir()
			if err != nil {
				return nil, 0, err
			}
			paths = desktopProfilePaths(dir)
		}
		for _, file := range paths {
			p, err := readDesktopProfiles(file)
			if errors.Is(err, os.ErrNotExist) && cfg.Profiles == "" {
				continue
			}
			if err != nil {
				// Desktop keeps an atomic-write backup. Recover read-only: never rename
				// or overwrite either of its files from the native client.
				p, err = readDesktopProfiles(file + ".bak")
				if err != nil {
					return nil, 0, fmt.Errorf("phic: cannot read desktop profiles %s: %w", QuotedID(file), err)
				}
			}
			profiles = p
			break
		}
	}
	selected := 0
	if cfg.ServerExplicit || len(profiles) == 0 {
		api, err := newAPIClient(cfg.Server)
		if err != nil {
			return nil, 0, err
		}
		origin := api.base.String()
		for i, p := range profiles {
			if p.Origin == origin {
				return profiles, i, nil
			}
		}
		profiles = append(profiles, desktopProfile{ID: origin, Name: api.base.Host, Origin: origin})
		selected = len(profiles) - 1
	} else {
		// This mirrors the desktop's most-recently-used startup selection without
		// modifying lastUsed (the desktop owns the file).
		for i, p := range profiles {
			if strings.Compare(p.LastUsed, profiles[selected].LastUsed) > 0 {
				selected = i
			}
		}
	}
	return profiles, selected, nil
}
