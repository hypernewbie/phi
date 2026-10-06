package phic

import (
	"context"
	"fmt"
	"strings"
)

// Connecting is a shared desktop-store edit, not a run-local connection.
func (c *client) connectServer(ctx context.Context) (int, error) {
	address, err := c.textPrompt(ctx, "Add server", "Server URL", "", 2048, func(value string) error {
		_, _, err := desktopEndpoint(strings.TrimSpace(value))
		return err
	})
	if err != nil {
		return 0, err
	}
	profile, err := c.store.add(strings.TrimSpace(address))
	if err != nil {
		return 0, err
	}
	if err := c.reloadServerProfiles(); err != nil {
		return 0, err
	}
	for i, s := range c.servers {
		if s.profile.ID == profile.ID {
			return i, nil
		}
	}
	return 0, fmt.Errorf("phic: added server was removed by another client")
}

func (c *client) selectServer(ctx context.Context, index int) error {
	if index < 0 || index >= len(c.servers) {
		return fmt.Errorf("phic: unknown server shortcut")
	}
	c.serverIndex = index
	c.api = c.servers[index].api
	c.currentServer = c.servers[index]
	return nil
}
