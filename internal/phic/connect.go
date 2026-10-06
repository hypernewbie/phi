package phic

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Connecting from the client is always available, even with no desktop
// profiles or an unreachable localhost. Adding a connection updates the
// exact desktop store, preserving unrelated desktop preferences.
func (c *client) connectServer(ctx context.Context) (int, error) {
	if err := writeAll(c.tty, []byte("\x1b[?2004h")); err != nil {
		return 0, err
	}
	defer func() { _ = writeAll(c.tty, []byte("\x1b[?2004l")) }()
	reader := menuReader{allowPaste: true, claimed: c.menuClaims()}
	address := ""
	if err := writeAll(c.tty, []byte("\r\n"+c.heading("Connect to server")+"\r\n  HTTP(S) origin · Enter Connect · Esc Back\r\n")); err != nil {
		return 0, err
	}
	for {
		cols, _, err := c.tty.Size()
		if err != nil {
			return 0, err
		}
		if err := writeAll(c.tty, []byte("\r\x1b[2K"+c.color(clipMenu("  Server URL › "+menuLabel(address), cols-1)))); err != nil {
			return 0, err
		}
		key, err := reader.read(ctx, c.tty, len(c.servers))
		if err != nil {
			return 0, err
		}
		switch key {
		case "back":
			return 0, errDetach
		case "erase":
			if address != "" {
				_, n := utf8.DecodeLastRuneInString(address)
				address = address[:len(address)-n]
			}
		case "enter":
			profile, err := c.store.add(strings.TrimSpace(address))
			if err != nil {
				if e := writeAll(c.tty, []byte("\r\n"+c.color(menuLabel(err.Error()))+"\r\n")); e != nil {
					return 0, e
				}
				continue
			}
			api, err := newAPIClient(profile.Origin)
			if err != nil {
				if e := writeAll(c.tty, []byte("\r\n"+c.color(menuLabel(err.Error()))+"\r\n")); e != nil {
					return 0, e
				}
				continue
			}
			for i, s := range c.servers {
				if s.api != nil && s.api.base.String() == api.base.String() {
					s.profile = profile
					return i, nil
				}
			}
			c.servers = append(c.servers, &serverState{profile: profile, api: api})
			return len(c.servers) - 1, nil
		case "up", "down", "home", "end", "pageup", "pagedown":
		default:
			if len(address)+len(key) <= 2048 {
				address += key
			}
		}
	}
}

func (c *client) selectServer(ctx context.Context, index int) error {
	if index < 0 || index >= len(c.servers) {
		return fmt.Errorf("phic: unknown server shortcut")
	}
	c.serverIndex = index
	c.api = c.servers[index].api
	return nil
}
