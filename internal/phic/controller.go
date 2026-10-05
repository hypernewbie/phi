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
		relay := NewRelay(c.tty, c.api)
		relay.fresh = fresh
		if _, err = relay.Connect(ctx, current.PaneID); err == nil {
			err = relay.Run(ctx)
		}
		relay.Close()
		c.tty.Unread(relay.viewInput)
		var command viewCommand
		if !errors.As(err, &command) {
			return err
		}
		if err := c.tty.PrepareMenu(); err != nil {
			return err
		}
		next, viewErr := c.liveView(ctx, current, byte(command))
		fresh = false
		if ctx.Err() != nil {
			return nil
		}
		if viewErr != nil && !errors.Is(viewErr, errDetach) {
			if err := c.viewError(ctx, viewErr); err != nil {
				return err
			}
		} else if viewErr == nil && next != nil {
			replacement, isFresh, spawnErr := c.materialize(ctx, *next)
			if spawnErr != nil {
				if err := c.viewError(ctx, spawnErr); err != nil {
					return err
				}
			} else {
				current, fresh = replacement, isFresh
			}
		}
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
		err := writeAll(c.tty, []byte("Φ  Shortcuts\r\n\r\nCtrl-] s   Sessions / new pane\r\nCtrl-] d   Diff\r\nCtrl-] w   Worktrees\r\nCtrl-] q   Detach (backend keeps running)\r\nCtrl-] ?   Help\r\nCtrl-] twice sends the prefix to the backend\r\n\r\nEnter or Esc/q to return: "))
		if err == nil {
			_, err = readMenuInput(ctx, c.tty)
		}
		return nil, err
	case 'd':
		text, err := c.api.RawDiff(ctx, dir, true)
		if err != nil {
			return nil, err
		}
		pager, err := NewPager(text)
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
	if e := writeAll(c.tty, []byte(fmt.Sprintf("\r\nΦ  %s\r\nEnter or Esc/q to return: ", QuotedID(err.Error())))); e != nil {
		return e
	}
	_, e := readMenuInput(ctx, c.tty)
	if errors.Is(e, errDetach) {
		return nil
	}
	return e
}
