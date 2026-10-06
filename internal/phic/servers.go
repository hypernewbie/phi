package phic

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

func (c *client) refreshIdentity(ctx context.Context, s *serverState) {
	if s == nil || s.api == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	var identity serverIdentity
	if s.api.getJSON(ctx, "/api/config", &identity) == nil {
		s.identity = identity
	}
}

func (c *client) serverPicker(ctx context.Context) (int, error) {
	// Observe identities without sending login proofs to unselected servers.
	// Separate jars prevent same-host, different-port cookie collisions.
	observe, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	var wg sync.WaitGroup
	slots := make(chan struct{}, 4)
	for _, s := range c.servers {
		wg.Add(1)
		go func(s *serverState) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			case <-observe.Done():
				return
			}
			c.refreshIdentity(observe, s)
		}(s)
	}
	wg.Wait()
	labels := make([]string, len(c.servers))
	for i, s := range c.servers {
		marker := " "
		if i == c.serverIndex {
			marker = "*"
		}
		labels[i] = fmt.Sprintf("%s %s  ·  %s", marker, s.label(), menuLabel(s.profile.Origin))
	}
	labels = append(labels, "+ Connect to another server…")
	for {
		i, err := c.chooseStyled(ctx, "Servers", labels, func(i int, line string, focused bool) string {
			if i == len(c.servers) {
				return themeText(c.activeServer().identity.Theme, line, focused)
			}
			return themeText(c.servers[i].identity.Theme, line, focused)
		})
		var shortcut viewCommand
		if errors.As(err, &shortcut) && shortcut == 'b' {
			continue
		}
		if err != nil || i < len(c.servers) {
			return i, err
		}
		i, err = c.connectServer(ctx)
		if errors.Is(err, errDetach) || (errors.As(err, &shortcut) && shortcut == 'b') {
			continue
		}
		return i, err
	}
}

// switchServer is transactional. The old pane remains selected if login,
// directory selection, or spawn fails. The origin owns its API jar and pane.
func (c *client) switchServer(ctx context.Context, index int, current SelectResult) (SelectResult, bool, error) {
	if index < 0 || index >= len(c.servers) {
		return current, false, fmt.Errorf("phic: server number is not in the desktop profile list")
	}
	if c.servers[index].api == nil {
		return current, false, fmt.Errorf("phic: desktop profile has an invalid server origin")
	}
	if index == c.serverIndex {
		return current, false, nil
	}
	oldIndex, oldAPI, oldCfg := c.serverIndex, c.api, c.cfg
	old := c.activeServer()
	old.remember(current)
	c.serverIndex = index
	c.api = c.servers[index].api
	committed := false
	defer func() {
		if !committed {
			c.serverIndex, c.api, c.cfg = oldIndex, oldAPI, oldCfg
		}
	}()
	if err := c.authenticate(ctx); err != nil {
		return current, false, err
	}
	c.refreshIdentity(ctx, c.activeServer())
	var sel SelectResult
	var err error
	if previous := c.activeServer().selection; previous != nil {
		panes, e := c.api.ListTerminals(ctx, "")
		if e != nil {
			return current, false, e
		}
		for _, p := range panes {
			if p.ID == previous.PaneID {
				copy := p
				sel = SelectResult{PaneID: p.ID, Existing: &copy}
				break
			}
		}
	}
	if sel.PaneID == "" {
		c.cfg.Pane = ""
		c.cfg.NewPane = false
		c.cfg.Coder = ""
		c.cfg.Dir = "" // Never carry another server's directory into this selection.
		sel, err = c.Select(ctx)
		if err != nil {
			return current, false, err
		}
	}
	if err := c.persistActiveProfile(); err != nil {
		return current, false, err
	}
	next, fresh, err := c.materialize(ctx, sel)
	if err != nil {
		return current, false, err
	}
	c.cfg = oldCfg
	c.cfg.Pane = ""
	c.cfg.NewPane = false
	c.cfg.Dir = next.Existing.Dir
	c.activeServer().remember(next)
	committed = true
	return next, fresh, nil
}

func (c *client) isLocal() bool {
	host := c.api.base.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func serverAbsolutePath(s string) bool {
	return strings.HasPrefix(s, "/") || (len(s) >= 3 && ((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z')) && s[1] == ':' && (s[2] == '\\' || s[2] == '/'))
}

func (c *client) directory(ctx context.Context, want string) (string, error) {
	if want != "" && serverAbsolutePath(want) {
		// Loopback may be a container/proxy with a different filesystem.
		// Canonicalize locally existing paths, but let Phi validate an absolute
		// server path instead of requiring it to exist on the client.
		if c.isLocal() {
			if resolved, err := resolveDir(want); err == nil {
				return resolved, nil
			}
		}
		return want, nil
	}
	if want != "" && c.isLocal() {
		return resolveDir(want)
	}
	state := c.activeServer()
	if state == nil {
		return "", fmt.Errorf("phic: remote selection needs an absolute server directory")
	}
	c.refreshIdentity(ctx, state)
	var dirs, labels []string
	seen := map[string]bool{}
	for _, dir := range state.identity.Workspaces {
		if !serverAbsolutePath(dir) || seen[dir] {
			continue
		}
		seen[dir] = true
		dirs = append(dirs, dir)
		labels = append(labels, menuLabel(dir))
	}
	if len(dirs) == 0 {
		panes, err := c.api.ListTerminals(ctx, "")
		if err != nil {
			return "", err
		}
		for _, p := range panes {
			if serverAbsolutePath(p.Dir) && !seen[p.Dir] {
				seen[p.Dir] = true
				dirs = append(dirs, p.Dir)
				labels = append(labels, menuLabel(p.Dir))
			}
		}
	}
	if len(dirs) == 0 {
		return "", fmt.Errorf("phic: no server projects; supply an absolute server directory")
	}
	if len(dirs) == 1 {
		return dirs[0], nil
	}
	i, err := c.choose(ctx, "Projects", labels)
	if err != nil {
		return "", err
	}
	return dirs[i], nil
}
