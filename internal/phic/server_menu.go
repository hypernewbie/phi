package phic

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
)

var errNoServer = errors.New("no saved server")

type serverChoice struct {
	Index    int
	Sessions bool
}

func (c *client) serverPicker(ctx context.Context) (serverChoice, error) {
	if err := c.reloadServerProfiles(); err != nil {
		return serverChoice{}, err
	}
	c.observeServers(ctx)
	focus := max(0, c.serverIndex)
	for {
		focusedID := ""
		labels := make([]string, 0, len(c.servers)+1)
		glyphs := serverGlyphs(c.servers)
		for i, s := range c.servers {
			marker := glyphs[i]
			active := ""
			if i == c.serverIndex {
				active = " · current"
			}
			labels = append(labels, fmt.Sprintf("%s %s%s  ·  %s", marker, s.label(), active, menuLabel(s.profile.Origin)))
		}
		labels = append(labels, "+ Add Phi server")
		index, err := c.chooseView(ctx, "Servers", labels, func(i int, line string, selected bool) string {
			if i < len(c.servers) {
				return c.servers[i].railText(line, selected)
			}
			return themeText("", line, selected) // desktop + stays neutral, not active-server themed
		}, menuOptions{cursor: &focus, actions: []string{"a", "r", "x", "[", "]", "m", "right"}, help: "a Add · r Rename · x Remove · [ ] Move · m More · Esc Back"})
		var shortcut viewCommand
		if errors.As(err, &shortcut) && shortcut == 'b' {
			continue
		}
		var action menuAction
		if err != nil && !errors.As(err, &action) {
			return serverChoice{}, err
		}
		if err == nil && index < len(c.servers) {
			return serverChoice{Index: index}, nil
		}
		if err == nil || action.key == "a" {
			index, err = c.connectServer(ctx)
			if err == nil {
				return serverChoice{Index: index}, nil
			}
		} else if index >= 0 && index < len(c.servers) {
			focus = index
			focusedID = c.servers[index].profile.ID
			var choice *serverChoice
			choice, err = c.manageServer(ctx, index, action.key)
			if choice != nil && err == nil {
				return *choice, nil
			}
		}
		if errors.Is(err, errNoServer) {
			return serverChoice{}, err
		}
		if err != nil && !errors.Is(err, errDetach) {
			if errors.As(err, &shortcut) {
				return serverChoice{}, err
			}
			if e := c.viewError(ctx, err); e != nil {
				return serverChoice{}, e
			}
		}
		if err := c.reloadServerProfiles(); err != nil {
			return serverChoice{}, err
		}
		focus = min(focus, len(c.servers))
		if focusedID != "" {
			for i, s := range c.servers {
				if s.profile.ID == focusedID {
					focus = i
					break
				}
			}
		}
	}
}

func (c *client) manageServer(ctx context.Context, index int, key string) (*serverChoice, error) {
	contextMenu := key == "m" || key == "right"
	for {
		choice, err := c.manageServerAction(ctx, index, key)
		if contextMenu && errors.Is(err, errFormCancel) {
			key = "m"
			continue
		}
		if errors.Is(err, errFormCancel) {
			err = errDetach
		}
		return choice, err
	}
}

var errFormCancel = errors.New("cancel form")

func (c *client) manageServerAction(ctx context.Context, index int, key string) (*serverChoice, error) {
	s := c.servers[index]
	if key == "m" || key == "right" {
		items := []string{"▣ Open sessions", "↻ Reload server", "⟳ Reload all servers", "📋 Copy server URL", "📋 Copy all server URLs", "✎ Rename", "× Remove server"}
		i, err := c.chooseView(ctx, "Server · "+menuLabel(s.profile.Name), items, func(i int, line string, focused bool) string {
			if i == 6 {
				return dangerText(line, focused)
			}
			return themeText(s.identity.Theme, line, focused)
		}, menuOptions{chrome: func(text string) string { return themeText(s.identity.Theme, text, false) }, description: []string{s.label(), menuLabel(s.profile.Origin), s.statusLabel()}, section: func(i int) string {
			if i < 3 {
				return "Server"
			}
			if i < 5 {
				return "Clipboard"
			}
			return "Profile"
		}})
		if err != nil {
			return nil, err
		}
		key = []string{"sessions", "reload", "reload-all", "copy", "copy-all", "r", "x"}[i]
	}
	switch key {
	case "sessions":
		return &serverChoice{Index: index, Sessions: true}, nil
	case "reload":
		c.refreshIdentity(ctx, s)
		return nil, nil // Desktop reloads that retained view without selecting it.
	case "reload-all":
		c.observeServers(ctx)
		return nil, nil
	case "copy":
		return nil, c.copyServerURLs(ctx, s.profile.Origin)
	case "copy-all":
		var urls []string
		for _, server := range c.servers {
			urls = append(urls, server.profile.Origin)
		}
		return nil, c.copyServerURLs(ctx, strings.Join(urls, "\n")+func() string {
			if len(urls) > 0 {
				return "\n"
			}
			return ""
		}())
	case "r":
		name, err := c.textPromptWith(ctx, "Rename profile", "Choose a name for this server", s.profile.Name, 120, func(value string) error { return validateServerName(jsTrim(value)) }, formOptions{selectAll: true, chrome: func(text string) string { return themeText(s.identity.Theme, text, false) }})
		if errors.Is(err, errDetach) {
			return nil, errFormCancel
		}
		if err != nil {
			return nil, err
		}
		return nil, c.store.rename(s.profile.ID, jsTrim(name))
	case "x":
		if s.profile.ID == "" {
			return nil, fmt.Errorf("phic: this is an unsaved connection")
		}
		i, err := c.chooseView(ctx, "Remove profile", []string{"← Keep server", "× Remove server"}, func(i int, line string, focused bool) string {
			if i == 1 {
				return dangerText(line, focused)
			}
			return themeText(s.identity.Theme, line, focused)
		}, menuOptions{chrome: func(text string) string { return themeText(s.identity.Theme, text, false) }, description: []string{"Remove " + s.label() + " from Phi?"}})
		if errors.Is(err, errDetach) || (err == nil && i == 0) {
			return nil, errFormCancel
		}
		if err != nil {
			return nil, err
		}
		active := s == c.activeServer()
		if err := c.store.remove(s.profile.ID); err != nil {
			return nil, err
		}
		if err := c.reloadServerProfiles(); err != nil {
			return nil, err
		}
		if active {
			if len(c.servers) == 0 {
				c.currentServer = nil
				c.api = nil
				return nil, errNoServer
			}
			mostRecent := 0
			for i, next := range c.servers {
				if next.profile.LastUsed > c.servers[mostRecent].profile.LastUsed {
					mostRecent = i
				}
			}
			return &serverChoice{Index: mostRecent}, nil
		}
		return nil, nil
	case "[":
		if index == 0 {
			return nil, nil
		}
		return nil, c.store.reorder(s.profile.ID, c.servers[index-1].profile.ID)
	case "]":
		if index+1 >= len(c.servers) {
			return nil, nil
		}
		before := ""
		if index+2 < len(c.servers) {
			before = c.servers[index+2].profile.ID
		}
		return nil, c.store.reorder(s.profile.ID, before)
	}
	return nil, nil
}

// OSC 52 is an explicit Copy action, never backend-history replay. Terminals
// may deny it; always show the URLs for manual selection as well.
func (c *client) copyServerURLs(ctx context.Context, text string) error {
	if os.Getenv("TERM") != "dumb" {
		if err := writeAll(c.tty, []byte("\x1b]52;c;"+base64.StdEncoding.EncodeToString([]byte(text))+"\a")); err != nil {
			return err
		}
	}
	_, err := c.choose(ctx, "Server URLs · clipboard requested where supported", append(strings.Split(text, "\n"), "Return"))
	return err
}
