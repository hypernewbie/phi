package phicmd

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/hypernewbie/phi/internal/phiprofiles"
)

// ServerIdentity mirrors GET /api/config.
type ServerIdentity struct {
	Hostname   string   `json:"hostname"`
	Theme      string   `json:"theme_color,omitempty"`
	Workspaces []string `json:"workspaces,omitempty"`
	ActiveCwd  string   `json:"active_cwd,omitempty"`
}

// ServerRow is one `servers` answer row.
type ServerRow struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Origin       string `json:"origin"`
	Health       string `json:"health"` // "up", "down"
	Hostname     string `json:"hostname,omitempty"`
	ActiveCwd    string `json:"active_cwd,omitempty"`
	LiveSessions *int   `json:"live_sessions,omitempty"`
	Auth         bool   `json:"auth_required,omitempty"`
}

// cmdServers probes every configured backend: liveness without
// credentials, identity with them, and live session counts best-effort.
func cmdServers(ctx context.Context, env *Env, args []string) error {
	if _, err := parseSubArgs(newSubflags("servers"), env, args); err != nil {
		return usagef("servers: %v", err)
	}
	if len(env.Profiles) == 0 && env.ProfileIdx < 0 {
		return usagef("no servers configured; add one with `phi-cmd use --server URL` or in the desktop app")
	}
	rows := make([]ServerRow, 0, len(env.Profiles))
	type result struct {
		idx  int
		row  ServerRow
		auth bool
	}
	results := make(chan result, len(env.Profiles))
	for i, p := range env.Profiles {
		go func(i int, p phiprofiles.Profile) {
			row := ServerRow{ID: p.ID, Name: p.Name, Origin: p.Origin}
			h, err := NewHTTP(p.Origin, NoPassword)
			if err != nil {
				row.Health = "down"
				results <- result{i, row, false}
				return
			}
			probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if err := h.Health(probeCtx); err != nil {
				row.Health = "down"
				results <- result{i, row, false}
				return
			}
			row.Health = "up"
			var id ServerIdentity
			authRequired := false
			if err := h.Do(probeCtx, "GET", "/api/config", nil, &id); err != nil {
				authRequired = isAuthErr(err)
			} else {
				row.Hostname = id.Hostname
				row.ActiveCwd = id.ActiveCwd
			}
			// Live sessions are best-effort: a locked backend reports none.
			if !authRequired {
				if c, err := DialControl(probeCtx, h); err == nil {
					if sessions, err := c.ListSessions(probeCtx); err == nil {
						n := len(sessions)
						row.LiveSessions = &n
					}
					c.Close()
				}
			}
			results <- result{i, row, authRequired}
		}(i, p)
	}
	authFlags := make([]bool, len(env.Profiles))
	for range env.Profiles {
		r := <-results
		authFlags[r.idx] = r.auth
		rows = append(rows, r.row)
	}
	sort.Slice(rows, func(a, b int) bool { return rows[a].ID < rows[b].ID })
	for i := range rows {
		rows[i].Auth = authFlags[i]
	}
	if env.JSON {
		return printJSON(map[string]any{"servers": rows})
	}
	w := newTable("ID", "NAME", "ORIGIN", "HEALTH", "HOSTNAME", "LIVE", "AUTH")
	for _, r := range rows {
		live := ""
		if r.LiveSessions != nil {
			live = fmt.Sprintf("%d", *r.LiveSessions)
		}
		auth := ""
		if r.Auth {
			auth = "yes"
		}
		w.row(r.ID, r.Name, r.Origin, r.Health, r.Hostname, live, auth)
	}
	w.flush()
	return nil
}

func isAuthErr(err error) bool {
	if err == nil {
		return false
	}
	if e, ok := err.(*APIError); ok && e.Status == httpStatusUnauthorized {
		return true
	}
	return strings.Contains(err.Error(), "authentication")
}

// cmdUse stores the CLI's own selection. It writes only phi-cmd's state
// file, never the desktop profiles document.
func cmdUse(_ context.Context, env *Env, args []string) error {
	next := env.State
	fs := newSubflags("use")
	server := fs.String("server", "", "server profile name/id or URL to select")
	coder := fs.String("coder", "", "active coder")
	cwd := fs.String("cwd", "", "active cwd on the server")
	session := fs.String("session", "", "active live session id")
	clear := fs.Bool("clear", false, "reset the selection")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("use: %v", err)
	}
	if *clear {
		return SaveState(State{})
	}
	if len(positional) > 0 {
		// `phi-cmd use pi` selects the coder positionally.
		if *server == "" && *coder == "" {
			*coder = positional[0]
		} else {
			return usagef("use: pass either a positional coder or flags, not both")
		}
	}
	if *server != "" {
		if !isURL(*server) {
			found := false
			for _, p := range env.Profiles {
				if p.ID == *server || p.Name == *server {
					found = true
					break
				}
			}
			if !found && len(env.Profiles) > 0 {
				return fmt.Errorf("%w: no configured server %q", ErrNotFound, *server)
			}
		} else if len(env.Profiles) == 0 {
			// First run: record nothing in the desktop document (read-only),
			// but keep the URL in phi-cmd's own state.
		}
		next.Server = *server
	}
	if *coder != "" {
		next.Coder = *coder
	}
	if *cwd != "" {
		next.Cwd = *cwd
	}
	if *session != "" {
		next.Session = *session
	}
	if err := SaveState(next); err != nil {
		return err
	}
	if env.JSON {
		return printJSON(next)
	}
	fmt.Printf("server=%q coder=%q cwd=%q session=%q\n", orDash(next.Server), orDash(next.Coder), orDash(next.Cwd), orDash(next.Session))
	return nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
