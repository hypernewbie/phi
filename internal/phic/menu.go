package phic

import (
	"context"
	"fmt"
)

type lineTerminal interface {
	ReadContext(context.Context, []byte) (int, error)
	Write([]byte) (int, error)
}

func (c *client) menuClaims() map[[2]int]bool {
	if c.keys.claimed == nil {
		c.keys.claimed = make(map[[2]int]bool)
	}
	return c.keys.claimed
}

// Help/error views use the selection key decoder and consumed-key ownership.
func (c *client) acknowledgeView(ctx context.Context) (string, error) {
	if err := writeAll(c.tty, []byte("\x1b[?2004h")); err != nil {
		return "", err
	}
	defer func() { _ = writeAll(c.tty, []byte("\x1b[?2004l")) }()
	reader := menuReader{claimed: c.menuClaims()}
	for {
		key, err := reader.read(ctx, c.tty, len(c.servers))
		if err != nil {
			return "", err
		}
		switch key {
		case "enter":
			return "", nil
		case "back", "q":
			return "", errDetach
		}
	}
}

func (c *client) choose(ctx context.Context, title string, items []string) (int, error) {
	return c.chooseStyled(ctx, title, items, nil)
}

func (c *client) chooseStyled(ctx context.Context, title string, items []string, paint func(int, string, bool) string) (int, error) {
	if c.tty == nil {
		return 0, fmt.Errorf("phic: selection requires a terminal")
	}
	if err := c.tty.EnterRaw(); err != nil {
		return 0, err
	}
	// Own paste reporting while the client owns this view. The relay's
	// preparation/replay restores backend modes after this scope ends.
	if err := writeAll(c.tty, []byte("\x1b[?2004h")); err != nil {
		return 0, err
	}
	defer func() { _ = writeAll(c.tty, []byte("\x1b[?2004l")) }()
	return c.selectionView(ctx, c.tty, c.tty.Size, title, items, paint)
}

func (c *client) chooseSpawn(ctx context.Context, dir, coder string) (SelectResult, error) {
	registry, err := c.api.ListCoders(ctx)
	if err != nil {
		return SelectResult{}, err
	}
	for _, d := range registry {
		if d.ID == coder {
			return SelectResult{NewSpawn: &SpawnRequest{Coder: coder, Dir: dir}}, nil
		}
	}
	return SelectResult{}, fmt.Errorf("phic: backend %s is not advertised by Phi", QuotedID(coder))
}

func (c *client) chooseStartup(ctx context.Context, dir string, panes []TerminalView) (SelectResult, error) {
	registry, err := c.api.ListCoders(ctx)
	if err != nil {
		return SelectResult{}, err
	}
	var choices []SelectResult
	var labels []string
	for _, p := range panes {
		if !MatchDir(p.Dir, dir) || (c.cfg.Coder != "" && p.Coder != c.cfg.Coder) {
			continue
		}
		copy := p
		choices = append(choices, SelectResult{PaneID: p.ID, Existing: &copy})
		labels = append(labels, fmt.Sprintf("● %s · %s  (%d other clients)", menuLabel(p.Coder), menuLabel(p.Title), p.ActiveWSCount))
	}
	for _, d := range registry {
		if c.cfg.Coder != "" && d.ID != c.cfg.Coder {
			continue
		}
		choices = append(choices, SelectResult{NewSpawn: &SpawnRequest{Coder: d.ID, Dir: dir}})
		action := "New pane"
		if d.Capabilities.List {
			action = "Sessions / New pane"
		}
		labels = append(labels, fmt.Sprintf("+ %s · %s", menuLabel(d.Name), action))
	}
	if len(choices) == 0 {
		return SelectResult{}, fmt.Errorf("phic: no selectable backend or pane")
	}
	i, err := c.choose(ctx, "Phi sessions", labels)
	if err != nil {
		return SelectResult{}, err
	}
	choice := choices[i]
	if choice.NewSpawn == nil {
		return choice, nil
	}
	var descriptor CoderDescriptor
	for _, d := range registry {
		if d.ID == choice.NewSpawn.Coder {
			descriptor = d
			break
		}
	}
	if !descriptor.Capabilities.List {
		return choice, nil
	}
	saved, err := c.api.ListSessions(ctx, descriptor.ID, dir)
	if err != nil {
		return SelectResult{}, err
	}
	labels = []string{"+ New pane"}
	for _, s := range saved {
		labels = append(labels, fmt.Sprintf("↩ %s  ·  %s", menuLabel(s.Title), s.TimeUpdated.Format("2006-01-02")))
	}
	i, err = c.choose(ctx, "Saved sessions", labels)
	if err != nil {
		return SelectResult{}, err
	}
	if i > 0 {
		selected := saved[i-1]
		choice.NewSpawn.SessionID = selected.ID
		if selected.SessionPath != "" {
			choice.NewSpawn.SessionID = selected.SessionPath
		}
	}
	return choice, nil
}
