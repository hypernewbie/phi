package phic

import (
	"context"
	"fmt"
	"strings"
)

// Same form and partial-success bulk-add flow as picker.html → DesktopHost.
func joinAddErrors(errors []string) string {
	if len(errors) == 0 {
		return "Invalid server URL"
	}
	return strings.Join(errors, "; ")
}

// Connecting is a shared desktop-store edit, not a run-local connection.
func (c *client) connectServer(ctx context.Context) (int, error) {
	var added addServersResult
	_, err := c.textPromptWith(ctx, "Add Phi server", "Server URL", "", maxMetadataBytes, func(value string) error {
		if err := validateServerInput(value); err != nil {
			return err
		}
		added = c.store.addServerInput(value)
		if len(added.Profiles) == 0 {
			return fmt.Errorf("%s", joinAddErrors(added.Errors))
		}
		return nil
	}, formOptions{placeholder: "https://server.example.com", pasteSpaces: true, submit: func(value string) string {
		n := len(parseServerURLs(value))
		if n > 1 {
			return fmt.Sprintf("Add %d servers", n)
		}
		return "Add"
	}})
	if err != nil {
		return 0, err
	}
	profile := added.Profiles[len(added.Profiles)-1]
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
