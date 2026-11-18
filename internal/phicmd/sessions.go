package phicmd

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

type persistedSession struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Cwd         string `json:"cwd"`
	Coder       string `json:"coder"`
	SessionPath string `json:"session_path,omitempty"`
	TimeUpdated string `json:"time_updated"`
}

type liveSessionSummary struct {
	SID    string `json:"sid"`
	Title  string `json:"title"`
	Cwd    string `json:"cwd"`
	Status string `json:"status"`
}

// cmdTabs reconstructs the tab view: coder tabs (the sidebar), their
// persisted sessions and live chat sessions, plus live panes. The web
// tab bar is browser-local; this is the information the backend owns.
func cmdTabs(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("tabs")
	coderFlag := fs.String("coder", "", "narrow to one coder tab")
	if _, err := parseSubArgs(fs, env, args); err != nil {
		return usagef("tabs: %v", err)
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	var coders []coderDescriptor
	if err := h.Do(ctx, "GET", "/api/coders", nil, &coders); err != nil {
		return err
	}
	var live map[string][]liveSessionSummary
	if c, err := DialControl(ctx, h); err == nil {
		if sessions, err := c.ListSessions(ctx); err == nil {
			live = groupLive(sessions)
		}
		c.Close()
	}

	// Only an explicit flag narrows: the remembered/default coder must
	// not hide the other tabs.
	want := *coderFlag
	type tabOut struct {
		ID       string               `json:"id"`
		Name     string               `json:"name"`
		IsShell  bool                 `json:"is_shell,omitempty"`
		Sessions []persistedSession   `json:"sessions"`
		Live     []liveSessionSummary `json:"live"`
	}
	tabs := make([]tabOut, 0, len(coders))
	for _, cd := range coders {
		if !cd.SidebarVisible {
			continue
		}
		if want != "" && cd.ID != want {
			continue
		}
		tab := tabOut{ID: cd.ID, Name: cd.Name, IsShell: cd.IsShell, Sessions: []persistedSession{}, Live: []liveSessionSummary{}}
		query := "coder=" + url.QueryEscape(cd.ID)
		if c := env.resolveCwd(); c != "" {
			query += "&cwd=" + url.QueryEscape(c)
		}
		var sessions []persistedSession
		if err := h.Do(ctx, "GET", "/api/sessions?"+query, nil, &sessions); err == nil {
			tab.Sessions = sessions
		}
		if live != nil {
			tab.Live = live[cd.ID]
		}
		if tab.Live == nil {
			tab.Live = []liveSessionSummary{}
		}
		tabs = append(tabs, tab)
	}
	var terminals []terminalSnapshot
	if err := h.Do(ctx, "GET", "/api/terminals", nil, &terminals); err != nil {
		return err
	}
	panes := make([]PaneRow, 0, len(terminals))
	for _, t := range terminals {
		if want != "" && t.Coder != want {
			continue
		}
		panes = append(panes, paneRowOf(t))
	}
	if env.JSON {
		return printJSON(map[string]any{"tabs": tabs, "panes": panes})
	}
	for _, tab := range tabs {
		fmt.Printf("[%s] %s\n", tab.ID, tab.Name)
		for _, s := range tab.Live {
			fmt.Printf("  live  %s  %s\n", s.SID, s.Title)
		}
		for _, s := range tab.Sessions {
			fmt.Printf("  hist  %s  %s\n", s.ID, s.Title)
		}
	}
	if len(panes) > 0 {
		fmt.Printf("[panes]\n")
		for _, p := range panes {
			fmt.Printf("  %s  %s  %s\n", p.ID, p.Coder, p.Title)
		}
	}
	return nil
}

func groupLive(sessions []*wspb.SessionSummary) map[string][]liveSessionSummary {
	// Live chat sessions are Pi RPC instances; they group under the pi
	// tab unless a summary carries a coder hint (it does not today).
	out := map[string][]liveSessionSummary{}
	for _, s := range sessions {
		out["pi"] = append(out["pi"], liveSessionSummary{SID: s.GetSid(), Title: s.GetTitle(), Cwd: s.GetCwd(), Status: s.GetStatus()})
	}
	return out
}

// cmdSessions lists persisted sessions for the active coder/cwd.
func cmdSessions(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("sessions")
	limit := fs.Int("limit", 0, "page size (server caps at 500)")
	offset := fs.Int("offset", 0, "page offset")
	if _, err := parseSubArgs(fs, env, args); err != nil {
		return usagef("sessions: %v", err)
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	coder := env.resolveCoder()
	query := "coder=" + url.QueryEscape(coder)
	if c := env.resolveCwd(); c != "" {
		query += "&cwd=" + url.QueryEscape(c)
	}
	if *limit > 0 {
		query += "&limit=" + strconv.Itoa(*limit)
	}
	if *offset > 0 {
		query += "&offset=" + strconv.Itoa(*offset)
	}
	var sessions []persistedSession
	if err := h.Do(ctx, "GET", "/api/sessions?"+query, nil, &sessions); err != nil {
		return err
	}
	if env.Tail > 0 && len(sessions) > env.Tail {
		sessions = sessions[len(sessions)-env.Tail:]
	}
	if env.JSON {
		return printJSON(map[string]any{"coder": coder, "cwd": env.resolveCwd(), "sessions": sessions})
	}
	w := newTable("ID", "TITLE", "CWD", "UPDATED")
	for _, s := range sessions {
		w.row(s.ID, s.Title, s.Cwd, s.TimeUpdated)
	}
	w.flush()
	return nil
}

type transcriptMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// cmdTranscript reads a session's messages: the live instance via
// control hydrate when it exists, else the persisted transcript.
func cmdTranscript(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("transcript")
	sid := fs.String("session", "", "live session id")
	persistedID := fs.String("id", "", "persisted session id (with --coder)")
	if _, err := parseSubArgs(fs, env, args); err != nil {
		return usagef("transcript: %v", err)
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	target := firstNonEmpty(*sid, env.Session, env.State.Session)
	if target == "" && *persistedID == "" {
		// The only live session is a sensible default.
		if c, err := DialControl(ctx, h); err == nil {
			if live, err := c.ListSessions(ctx); err == nil && len(live) == 1 {
				target = live[0].GetSid()
			}
			c.Close()
		}
	}
	if target != "" {
		c, err := DialControl(ctx, h)
		if err != nil {
			return err
		}
		defer c.Close()
		snap, err := c.Hydrate(ctx, target)
		if err != nil {
			return err
		}
		msgs := snapshotMessages(snap)
		msgs = tailMessages(msgs, env.Tail)
		if env.JSON {
			return printJSON(map[string]any{"session": target, "messages": msgs})
		}
		printMessages(msgs)
		return nil
	}
	if *persistedID == "" {
		return usagef("transcript: pass --session, --id, or select one with `phi-cmd use --session`")
	}
	query := "coder=" + url.QueryEscape(env.resolveCoder()) + "&id=" + url.QueryEscape(*persistedID)
	if c := env.resolveCwd(); c != "" {
		query += "&cwd=" + url.QueryEscape(c)
	}
	var msgs []transcriptMessage
	if err := h.Do(ctx, "GET", "/api/session-transcript?"+query, nil, &msgs); err != nil {
		return err
	}
	msgs = tailMessages(msgs, env.Tail)
	if env.JSON {
		return printJSON(map[string]any{"id": *persistedID, "messages": msgs})
	}
	printMessages(msgs)
	return nil
}

// snapshotMessages renders a transcript snapshot's messages as plain
// role/text pairs, pairing tool results with their calls.
func snapshotMessages(snap *wspb.TranscriptSnapshot) []transcriptMessage {
	if snap == nil {
		return []transcriptMessage{}
	}
	out := make([]transcriptMessage, 0, len(snap.GetMessages()))
	for _, m := range snap.GetMessages() {
		out = append(out, transcriptMessage{Role: m.GetRole(), Text: externalValueText(m.GetContent())})
	}
	return out
}

func tailMessages(msgs []transcriptMessage, n int) []transcriptMessage {
	if n <= 0 || len(msgs) <= n {
		return msgs
	}
	return msgs[len(msgs)-n:]
}

func printMessages(msgs []transcriptMessage) {
	for _, m := range msgs {
		role := m.Role
		if role != "" {
			role = strings.ToUpper(role[:1]) + role[1:]
		}
		fmt.Printf("%s: %s\n", role, m.Text)
	}
}
