package phic

import (
	"context"
	"errors"
	"fmt"
)

// The controller owns the terminal between attachments. Closing and joining
// both relay workers is the ownership barrier; menu/pager output never races
// with a backend reader. Phi retains output while the client is in a view.
func (c *client) attachSelected(ctx context.Context, sel SelectResult) error {
	current, fresh, err := c.materialize(ctx, sel)
	if err != nil {
		return err
	}
	for {
		if err := c.tty.EnterRaw(); err != nil {
			return err
		}
		if err := c.tty.PrepareRelay(); err != nil {
			return err
		}
		if state := c.activeServer(); state != nil {
			state.remember(current)
		}
		c.keys.servers = len(c.servers)
		relay := NewRelay(c.tty, c.api)
		relay.fresh = fresh
		relay.keys = &c.keys
		if state := c.activeServer(); state != nil {
			if cursor, ok := state.frontiers[current.PaneID]; ok {
				relay.previous = &cursor
			}
		}
		if _, err = relay.Connect(ctx, current.PaneID); err == nil {
			err = relay.Run(ctx)
		}
		relay.Close()
		c.tty.Unread(relay.viewInput)
		var command viewCommand
		if !errors.As(err, &command) {
			return err
		}
		if state := c.activeServer(); state != nil {
			if state.frontiers == nil {
				state.frontiers = make(map[string]recordingCursor)
			}
			state.frontiers[current.PaneID] = recordingCursor{epoch: relay.epoch, through: relay.written}
		}
		if err := c.tty.PrepareMenu(); err != nil {
			return err
		}
		c.refreshIdentity(ctx, c.activeServer())
		next, isFresh, viewErr := c.dispatchView(ctx, current, byte(command))
		fresh = false
		if ctx.Err() != nil {
			return nil
		}
		if viewErr == nil {
			current, fresh = next, isFresh
		} else if !errors.Is(viewErr, errDetach) {
			if err := c.viewError(ctx, viewErr); err != nil {
				return err
			}
		}
	}
}

func (c *client) dispatchView(ctx context.Context, current SelectResult, key byte) (SelectResult, bool, error) {
	for {
		if key >= '1' && key <= '9' {
			if c.keys.claimed == nil {
				c.keys.claimed = make(map[[2]int]bool)
			}
			c.keys.claimed[[2]int{int(key), 5}] = true
			return c.switchServer(ctx, int(key-'1'), current)
		}
		var next *SelectResult
		var err error
		if key == 'b' {
			var i int
			i, err = c.serverPicker(ctx)
			if err == nil {
				return c.switchServer(ctx, i, current)
			}
		} else {
			next, err = c.liveView(ctx, current, key)
		}
		var shortcut viewCommand
		if errors.As(err, &shortcut) && (byte(shortcut) == 'b' || (byte(shortcut) >= '1' && byte(shortcut) <= '9')) {
			key = byte(shortcut)
			continue
		}
		if err != nil || next == nil {
			return current, false, err
		}
		return c.materialize(ctx, *next)
	}
}

func (c *client) materialize(ctx context.Context, sel SelectResult) (SelectResult, bool, error) {
	if sel.NewSpawn == nil {
		if sel.PaneID == "" || sel.Existing == nil {
			return sel, false, fmt.Errorf("phic: incomplete pane selection")
		}
		return sel, false, nil
	}
	cols, rows, err := c.tty.Size()
	if err != nil {
		return sel, false, err
	}
	if cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 {
		return sel, false, fmt.Errorf("phic: unusable terminal size")
	}
	req := *sel.NewSpawn
	req.Cols, req.Rows = uint16(cols), uint16(rows)
	sp, err := c.api.Spawn(ctx, req)
	if err != nil {
		return sel, false, err
	}
	if sp.PaneID == "" {
		return sel, false, fmt.Errorf("phic: server returned an empty pane ID")
	}
	return SelectResult{PaneID: sp.PaneID, Existing: &TerminalView{ID: sp.PaneID, Dir: req.Dir, Coder: req.Coder, SessionID: sp.SessionID, OpenCodeMode: sp.OpenCodeMode}}, true, nil
}

func (c *client) liveView(ctx context.Context, current SelectResult, key byte) (*SelectResult, error) {
	dir := current.Existing.Dir
	switch key {
	case '?':
		err := writeAll(c.tty, []byte(c.color("Φ  Shortcuts\r\n\r\nCtrl-] b   Server bar\r\nCtrl-] 1..9 or enhanced Ctrl-1..9 switches server\r\nCtrl-] s   Sessions / new pane\r\nCtrl-] d   Diff\r\nCtrl-] w   Worktrees\r\nCtrl-] q   Detach (backend keeps running)\r\nCtrl-] ?   Help\r\nCtrl-] twice sends the prefix to the backend\r\n\r\nEnter or Esc/q to return: ")))
		if err == nil {
			_, err = c.acknowledgeView(ctx)
		}
		return nil, err
	case 'd':
		text, err := c.api.RawDiff(ctx, dir, true)
		if err != nil {
			return nil, err
		}
		pager, err := NewPager(c.diffText(dir, text))
		if err != nil {
			return nil, err
		}
		defer pager.Close()
		return nil, RunPager(ctx, c.tty, pager.Path())
	case 'w':
		items, err := c.api.Worktrees(ctx, dir)
		if err != nil {
			return nil, err
		}
		if len(items) == 0 {
			return nil, fmt.Errorf("phic: no worktrees")
		}
		labels := make([]string, len(items))
		for i, w := range items {
			labels[i] = fmt.Sprintf("%+q", w.Path)
		}
		i, err := c.choose(ctx, "Worktrees", labels)
		if err != nil {
			return nil, err
		}
		dir = items[i].Path
	case 's':
	default:
		return nil, fmt.Errorf("phic: unknown client view")
	}
	panes, err := c.api.ListTerminals(ctx, dir)
	if err != nil {
		return nil, err
	}
	coder := c.cfg.Coder
	c.cfg.Coder = ""
	defer func() { c.cfg.Coder = coder }()
	next, err := c.chooseStartup(ctx, dir, panes)
	return &next, err
}

func (c *client) viewError(ctx context.Context, err error) error {
	if e := writeAll(c.tty, []byte(fmt.Sprintf("\r\n%s\r\nEnter or Esc/q to return: ", c.heading(QuotedID(err.Error()))))); e != nil {
		return e
	}
	_, e := c.acknowledgeView(ctx)
	if errors.Is(e, errDetach) {
		return nil
	}
	return e
}
