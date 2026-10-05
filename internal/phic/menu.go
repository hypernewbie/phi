package phic

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type lineTerminal interface {
	ReadContext(context.Context, []byte) (int, error)
	Write([]byte) (int, error)
}

func readLine(ctx context.Context, t lineTerminal) (string, error) {
	var line []byte
	var b [1]byte
	for len(line) < 4096 {
		n, err := t.ReadContext(ctx, b[:])
		if n > 0 {
			if b[0] == '\n' || b[0] == '\r' {
				return string(line), nil
			}
			line = append(line, b[0])
		}
		if err != nil {
			return "", err
		}
		if n == 0 {
			return "", io.EOF
		}
	}
	return "", fmt.Errorf("phic: input line too long")
}
func (c *client) choose(ctx context.Context, title string, items []string) (int, error) {
	if c.tty == nil {
		return 0, fmt.Errorf("phic: selection requires a terminal")
	}
	cols, rows, err := c.tty.Size()
	if err != nil {
		return 0, err
	}
	perPage := rows - 4
	if perPage < 1 {
		perPage = 1
	}
	if cols < 8 {
		return 0, fmt.Errorf("phic: terminal too narrow for selection")
	}
	page := 0
	for {
		var out strings.Builder
		fmt.Fprintln(&out, title)
		start, end := page*perPage, (page+1)*perPage
		if end > len(items) {
			end = len(items)
		}
		for i := start; i < end; i++ {
			// Metadata is already quoted. ASCII quoting keeps width predictable.
			line := fmt.Sprintf("%d  %s", i+1, items[i])
			if len(line) > cols-1 {
				line = line[:cols-4] + "..."
			}
			fmt.Fprintln(&out, line)
		}
		fmt.Fprint(&out, "number, n/p, or q: ")
		if _, err := c.tty.Write([]byte(out.String())); err != nil {
			return 0, err
		}
		line, err := readLine(ctx, c.tty)
		if err != nil {
			return 0, err
		}
		switch strings.TrimSpace(line) {
		case "q", "\x1b":
			return 0, errDetach
		case "n":
			if end < len(items) {
				page++
			}
			continue
		case "p":
			if page > 0 {
				page--
			}
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(line))
		if err == nil && n >= start+1 && n <= end {
			return n - 1, nil
		}
	}
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
		labels = append(labels, fmt.Sprintf("live %s %s (other clients: %d)", fmt.Sprintf("%+q", p.Coder), fmt.Sprintf("%+q", p.Title), p.ActiveWSCount))
	}
	for _, d := range registry {
		if c.cfg.Coder != "" && d.ID != c.cfg.Coder {
			continue
		}
		choices = append(choices, SelectResult{NewSpawn: &SpawnRequest{Coder: d.ID, Dir: dir}})
		labels = append(labels, fmt.Sprintf("%+q sessions / new pane", d.Name))
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
	labels = []string{"new pane"}
	for _, s := range saved {
		labels = append(labels, fmt.Sprintf("resume %+q (%s)", s.Title, s.TimeUpdated.Format("2006-01-02")))
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
