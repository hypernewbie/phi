package phic

import (
	"context"
	"fmt"

	tea "charm.land/bubbletea/v2"
	"github.com/hypernewbie/phi/internal/termemu"
)

// RunTUI starts the Bubble Tea console surface. It is the client surface for
// normal interactive startup; explicit CLI operations that exit (help,
// version) are handled before this call.
func RunTUI(ctx context.Context, cfg config, version string) error {
	store, err := desktopStoreFor(cfg)
	if err != nil {
		return err
	}
	cfg.Profiles = store.path
	profiles, selected, err := loadServerProfiles(cfg)
	if err != nil {
		return err
	}
	var servers []*serverState
	for _, profile := range profiles {
		// Desktop retains legacy rows, even if their endpoint is unusable.
		// Show the same list; reject an invalid endpoint only when selected.
		api, _ := newAPIClient(profile.Origin)
		servers = append(servers, &serverState{profile: profile, api: api})
	}
	m := newTUIModel(version, cfg, store, servers, selected, termemu.NewGhostty)
	defer m.closeAll()

	program := tea.NewProgram(m, tea.WithContext(ctx))
	if _, err := program.Run(); err != nil {
		return fmt.Errorf("phic: %w", err)
	}
	return nil
}

// closeAll detaches every pane actor. Detach never sends DELETE and never
// pins a pane; quitting the client leaves server panes alive.
func (m *tuiModel) closeAll() {
	for _, tabs := range m.tabs {
		for _, tab := range tabs {
			if tab.actor != nil {
				tab.actor.close()
				tab.actor = nil
			}
		}
	}
	m.actors = map[paneKey]*paneActor{}
}
