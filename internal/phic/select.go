package phic

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// SelectResult is the outcome of the plan's startup selection.
type SelectResult struct {
	PaneID   string
	NewSpawn *SpawnRequest
	Existing *TerminalView
}

// Select implements PHIC_PLAN.md section 2's startup algorithm.
func (c *client) Select(ctx context.Context) (SelectResult, error) {
	if c.cfg.Pane != "" {
		panes, err := c.api.ListTerminals(ctx, "")
		if err != nil {
			return SelectResult{}, err
		}
		for _, p := range panes {
			if p.ID == c.cfg.Pane {
				return SelectResult{PaneID: p.ID, Existing: &p}, nil
			}
		}
		return SelectResult{}, fmt.Errorf("phic: pane %s is not live", QuotedID(c.cfg.Pane))
	}
	dir, err := normalizePath(c.cfg.Dir)
	if err != nil {
		return SelectResult{}, err
	}
	panes, err := c.api.ListTerminals(ctx, dir)
	if err != nil {
		return SelectResult{}, err
	}
	matched := matchingPanes(panes, dir, c.cfg.Coder)
	if c.cfg.NewPane {
		if c.cfg.Coder == "" {
			return SelectResult{}, fmt.Errorf("phic: --new requires --coder")
		}
		return c.chooseSpawn(ctx, dir, c.cfg.Coder)
	}
	switch len(matched) {
	case 1:
		return SelectResult{PaneID: matched[0].ID, Existing: &matched[0]}, nil
	case 0:
		if c.cfg.Coder != "" {
			return c.chooseSpawn(ctx, dir, c.cfg.Coder)
		}
		return c.chooseStartup(ctx, dir, panes)
	default:
		return c.chooseStartup(ctx, dir, panes)
	}
}

// matchingPanes returns the unattached panes that match dir
// (and coder, if set).
func matchingPanes(panes []TerminalView, dir, coder string) []TerminalView {
	var out []TerminalView
	for _, p := range panes {
		if p.ActiveWSCount > 0 {
			// Plan: "A live pane with another attached
			// client requires explicit selection."
			continue
		}
		if !MatchDir(p.Dir, dir) {
			continue
		}
		if coder != "" && p.Coder != coder {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out
}

// resolveDir canonicalizes a CLI directory argument.
func resolveDir(s string) (string, error) {
	if s == "" {
		return "", fmt.Errorf("phic: directory is required")
	}
	abs, err := filepath.Abs(s)
	if err != nil {
		return "", err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("phic: %s is not a directory", QuotedID(abs))
	}
	return filepath.Clean(abs), nil
}

// formatPaneRow formats a single line of the session list.
func formatPaneRow(i int, p TerminalView) string {
	status := "free"
	if p.ActiveWSCount > 0 {
		status = fmt.Sprintf("attached x%d", p.ActiveWSCount)
	}
	title := p.Title
	if title == "" {
		title = filepath.Base(p.Dir)
	}
	return fmt.Sprintf("  %d  %s  %s  %s  %s",
		i+1, QuotedID(p.Coder), status, QuotedID(p.ID), QuotedID(title))
}
