package phicmd

import (
	"context"
	"fmt"
)

// StatusRow is one live chat session in a `status` answer.
type StatusRow struct {
	SID           string  `json:"sid"`
	Title         string  `json:"title"`
	Cwd           string  `json:"cwd"`
	Status        string  `json:"status"`
	Busy          bool    `json:"busy"`
	Model         string  `json:"model,omitempty"`
	Thinking      string  `json:"thinking,omitempty"`
	InputTokens   int64   `json:"input_tokens,omitempty"`
	OutputTokens  int64   `json:"output_tokens,omitempty"`
	ContextUsed   int64   `json:"context_used_tokens,omitempty"`
	ContextWindow int64   `json:"context_window_tokens,omitempty"`
	Cost          float64 `json:"cost,omitempty"`
	QueueDepth    uint32  `json:"queue_depth,omitempty"`
}

// PaneRow is one live pane in a `status`/`tabs` answer.
type PaneRow struct {
	ID           string `json:"id"`
	Coder        string `json:"coder"`
	Cwd          string `json:"cwd"`
	Title        string `json:"title"`
	Busy         bool   `json:"busy"`
	Pinned       bool   `json:"pinned,omitempty"`
	LastActivity int64  `json:"last_activity_unix,omitempty"`
	Workspace    string `json:"workspace,omitempty"`
}

type terminalSnapshot struct {
	ID               string `json:"id"`
	Cwd              string `json:"cwd"`
	Coder            string `json:"coder"`
	Title            string `json:"title"`
	Busy             bool   `json:"busy"`
	Pinned           bool   `json:"pinned"`
	LastActivityUnix int64  `json:"last_activity_unix"`
	Workspace        string `json:"workspace"`
}

type coderDescriptor struct {
	ID                  string          `json:"id"`
	Name                string          `json:"name"`
	SidebarVisible      bool            `json:"sidebar_visible"`
	IsShell             bool            `json:"is_shell"`
	Capabilities        map[string]bool `json:"capabilities"`
	ModelSwitchDisabled bool            `json:"model_switch_disabled"`
	Presets             []preset        `json:"presets,omitempty"`
	ModelSwitch         []recipeStep    `json:"model_switch,omitempty"`
}

type preset struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// cmdStatus answers "which backend is in which state": live chat
// sessions with full state, live panes, and coder capabilities.
func cmdStatus(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("status")
	watch := fs.Bool("watch", false, "stream state events until timeout or Ctrl-C")
	if _, err := parseSubArgs(fs, env, args); err != nil {
		return usagef("status: %v", err)
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	var coders []coderDescriptor
	if err := h.Do(ctx, "GET", "/api/coders", nil, &coders); err != nil {
		return err
	}
	var terminals []terminalSnapshot
	if err := h.Do(ctx, "GET", "/api/terminals", nil, &terminals); err != nil {
		return err
	}
	c, err := DialControl(ctx, h)
	if err != nil {
		return err
	}
	defer c.Close()
	live, err := c.ListSessions(ctx)
	if err != nil {
		return err
	}
	rows := make([]StatusRow, 0, len(live))
	for _, s := range live {
		row := StatusRow{SID: s.GetSid(), Title: s.GetTitle(), Cwd: s.GetCwd(), Status: s.GetStatus()}
		if state, err := c.State(ctx, s.GetSid()); err == nil && state != nil {
			row.Busy = state.GetBusy()
			row.Status = orDefault(state.GetStatus(), s.GetStatus())
			row.Model = state.GetModel()
			row.Thinking = state.GetThinking()
			row.InputTokens = state.GetInputTokens()
			row.OutputTokens = state.GetOutputTokens()
			row.ContextUsed = state.GetContextUsedTokens()
			row.ContextWindow = state.GetContextWindowTokens()
			row.Cost = state.GetCost()
			row.QueueDepth = state.GetQueueDepth()
		}
		rows = append(rows, row)
	}
	panes := make([]PaneRow, 0, len(terminals))
	for _, t := range terminals {
		panes = append(panes, paneRowOf(t))
	}
	if *watch {
		return watchStatus(ctx, c, rows)
	}
	if env.JSON {
		return printJSON(map[string]any{
			"origin":   env.Origin,
			"sessions": rows,
			"panes":    panes,
			"coders":   coderSummaries(coders),
		})
	}
	fmt.Printf("backend %s\n", env.Origin)
	fmt.Printf("\nlive chat sessions:\n")
	if len(rows) == 0 {
		fmt.Printf("  (none)\n")
	}
	for _, r := range rows {
		busy := "idle"
		if r.Busy {
			busy = "busy"
		}
		fmt.Printf("  %s  %s  [%s]  %s  model=%s\n", r.SID, quote(r.Title), r.Status, busy, orDash(r.Model))
	}
	fmt.Printf("\nlive panes:\n")
	if len(panes) == 0 {
		fmt.Printf("  (none)\n")
	}
	for _, p := range panes {
		fmt.Printf("  %s  %s  %s\n", p.ID, p.Coder, quote(orDefault(p.Title, p.Cwd)))
	}
	return nil
}

type coderSummary struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Capabilities map[string]bool `json:"capabilities"`
}

func coderSummaries(coders []coderDescriptor) []coderSummary {
	out := make([]coderSummary, 0, len(coders))
	for _, c := range coders {
		if !c.SidebarVisible {
			continue
		}
		out = append(out, coderSummary{ID: c.ID, Name: c.Name, Capabilities: c.Capabilities})
	}
	return out
}

// watchStatus hydrates every session (events are per-subscription) and
// prints state events as they arrive. It never prints transcripts.
func watchStatus(ctx context.Context, c *Control, rows []StatusRow) error {
	for _, r := range rows {
		_, _ = c.Hydrate(ctx, r.SID)
	}
	fmt.Printf("watching %d session(s); events follow\n", len(rows))
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.Done():
			return fmt.Errorf("phi-cmd: control socket ended: %w", c.Err())
		case ev := <-c.Events():
			line := fmt.Sprintf("%s seq=%d %s", orDash(ev.SID), ev.Seq, ev.Name)
			if st := ev.Wire().GetStateChanged(); st != nil && st.GetState() != nil {
				state := st.GetState()
				busy := "idle"
				if state.GetBusy() {
					busy = "busy"
				}
				line += fmt.Sprintf(" status=%s %s", state.GetStatus(), busy)
				if state.GetModel() != "" {
					line += " model=" + state.GetModel()
				}
			}
			fmt.Println(line)
		}
	}
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func quote(s string) string {
	if s == "" {
		return `""`
	}
	return s
}

func paneRowOf(t terminalSnapshot) PaneRow {
	return PaneRow{
		ID: t.ID, Coder: t.Coder, Cwd: t.Cwd, Title: t.Title,
		Busy: t.Busy, Pinned: t.Pinned,
		LastActivity: t.LastActivityUnix, Workspace: t.Workspace,
	}
}
