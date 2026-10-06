// Package phic provides Phi's native multi-server terminal client.
package phic

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

func Run(args []string) error { return RunWithVersion(args, "phic dev (commit unreleased)") }

func RunWithVersion(args []string, version string) error {
	cfg, err := parseFlags(args)
	if err != nil {
		return err
	}
	if cfg.Help {
		printUsage(os.Stdout)
		return nil
	}
	if cfg.Version {
		fmt.Println(version)
		return nil
	}

	ctx, cancel := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	cl, err := newClient(ctx, cfg)
	if err != nil {
		return err
	}
	defer cl.Close()
	return cl.Run(ctx)
}

func parseFlags(args []string) (config, error) {
	fs := flag.NewFlagSet("phic", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var c config
	fs.StringVar(&c.Server, "server", "http://127.0.0.1:7070", "Phi server URL override")
	fs.StringVar(&c.Profiles, "profiles", "", "desktop profiles.json path")
	fs.StringVar(&c.Pane, "pane", "", "exact live pane ID to attach to")
	fs.StringVar(&c.Coder, "coder", "", "backend name (e.g. pi, opencode, bash)")
	fs.BoolVar(&c.NewPane, "new", false, "create a fresh pane rather than reattaching")
	fs.BoolVar(&c.Help, "help", false, "show usage")
	fs.BoolVar(&c.Version, "version", false, "show version")
	fs.BoolVar(&c.Diff, "diff", false, "show diff in the native pager and exit")
	fs.BoolVar(&c.Worktrees, "worktrees", false, "select a worktree before opening a pane")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			c.Help = true
			return c, nil
		}
		return c, err
	}
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "server" {
			c.ServerExplicit = true
		}
	})
	c.Dir = "."
	if rest := fs.Args(); len(rest) > 0 {
		if len(rest) > 1 {
			return c, fmt.Errorf("phic: expected at most one directory")
		}
		c.Dir = rest[0]
	}
	if c.Pane != "" && (c.NewPane || c.Coder != "" || c.Worktrees) {
		return c, fmt.Errorf("phic: --pane cannot be combined with --new, --coder, or --worktrees")
	}
	return c, nil
}

type config struct {
	Server         string
	ServerExplicit bool
	Profiles       string
	Pane           string
	Coder          string
	Dir            string
	NewPane        bool
	Help           bool
	Version        bool
	Diff           bool
	Worktrees      bool
}

func printUsage(w *os.File) {
	fmt.Fprintln(w, `Usage: phic [options] <directory>

Options:
  --server URL    use this server (overrides desktop profiles by default)
  --profiles FILE desktop profiles.json (default: desktop userData file)
  --pane ID       attach to an exact live pane ID
  --coder NAME    backend name (e.g. pi, opencode, bash)
  --new           create a fresh pane rather than reattaching (requires --coder)
  --diff          show current diff in less -R and exit
  --worktrees     select an existing worktree before startup
  --help          show this message
  --version       show version

Relay keys: Ctrl-] then b servers, 1-9 switch server, s sessions, d diff,
w worktrees, ? help, q detach. Enhanced terminals also support Ctrl-1..9.
Ctrl-] Ctrl-] sends a literal prefix. Inline menus use arrows, Enter,
/ search, and Esc to return. Normal startup shows the server bar, including
Connect to another server. Backend output stays raw. Returning rebuilds from Phi's recording at current size.`)
}

type client struct {
	cfg           config
	tty           *TTY
	api           *apiClient
	servers       []*serverState
	serverIndex   int
	keys          inputParser
	store         *desktopStore
	currentServer *serverState
}

func newClient(_ context.Context, cfg config) (*client, error) {
	store, err := desktopStoreFor(cfg)
	if err != nil {
		return nil, err
	}
	cfg.Profiles = store.path
	profiles, selected, err := loadServerProfiles(cfg)
	if err != nil {
		return nil, err
	}
	var servers []*serverState
	for _, profile := range profiles {
		// Desktop retains legacy rows, even if their endpoint is unusable.
		// Show the same list; reject an invalid endpoint only when selected.
		api, _ := newAPIClient(profile.Origin)
		servers = append(servers, &serverState{profile: profile, api: api})
	}
	tty, err := OpenTTY()
	if err != nil {
		return nil, err
	}
	c := &client{cfg: cfg, tty: tty, servers: servers, serverIndex: selected, store: store}
	if selected >= 0 {
		c.currentServer = servers[selected]
		c.api = c.currentServer.api
	}
	return c, nil
}

func (c *client) Close() error {
	if c.tty != nil {
		return c.tty.Close()
	}
	return nil
}

func (c *client) Run(ctx context.Context) error {
	sessions := false
	// Normal startup is a client surface, not an implicit localhost probe.
	// Explicit CLI operations retain their direct-attachment semantics.
	if len(c.servers) == 0 {
		if err := c.tty.EnterRaw(); err != nil {
			return err
		}
		if err := c.tty.PrepareMenu(); err != nil {
			return err
		}
		choice, err := c.serverPicker(ctx)
		index := choice.Index
		sessions = choice.Sessions
		var shortcut viewCommand
		if errors.As(err, &shortcut) && byte(shortcut) >= '1' && byte(shortcut) <= '9' {
			index, err = int(byte(shortcut)-'1'), nil
		}
		if errors.Is(err, errDetach) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := c.selectServer(ctx, index); err != nil {
			return err
		}
	}
	for {
		err := c.start(ctx, sessions)
		sessions = false
		if ctx.Err() != nil || errors.Is(err, errDetach) {
			return nil
		}
		if errors.Is(err, errNoServer) {
			c.cfg.Pane = ""
			c.cfg.Coder = ""
			c.cfg.NewPane = false
			c.cfg.Diff = false
		}
		var exit *ExitError
		if err == nil || errors.As(err, &exit) || c.cfg.Pane != "" || c.cfg.NewPane || c.cfg.Coder != "" || c.cfg.Diff {
			return err
		}
		if e := c.tty.EnterRaw(); e != nil {
			return e
		}
		if e := c.tty.PrepareMenu(); e != nil {
			return e
		}
		var shortcut viewCommand
		index := -1
		if errors.As(err, &shortcut) && byte(shortcut) >= '1' && byte(shortcut) <= '9' {
			index = int(byte(shortcut) - '1')
		} else {
			if !errors.Is(err, errNoServer) {
				if e := writeAll(c.tty, []byte(c.heading(QuotedID(err.Error()))+"\r\n")); e != nil {
					return e
				}
			}
			var e error
			choice, pickErr := c.serverPicker(ctx)
			index, e = choice.Index, pickErr
			sessions = choice.Sessions
			if errors.As(e, &shortcut) && byte(shortcut) >= '1' && byte(shortcut) <= '9' {
				index = int(byte(shortcut) - '1')
			} else if errors.Is(e, errDetach) {
				return nil
			} else if e != nil {
				return e
			}
		}
		if err := c.selectServer(ctx, index); err != nil {
			return err
		}
		if c.keys.claimed == nil {
			c.keys.claimed = make(map[[2]int]bool)
		}
		if index < 9 {
			c.keys.claimed[[2]int{int('1') + index, 5}] = true
		}
		c.cfg.Pane = ""
		c.cfg.NewPane = false
		c.cfg.Coder = ""
		c.cfg.Dir = ""
	}
}

func (c *client) start(ctx context.Context, sessions bool) error {
	if c.api == nil {
		return fmt.Errorf("phic: selected desktop profile has an invalid server origin")
	}
	if err := c.persistActiveProfile(); err != nil {
		return err
	}
	if err := c.authenticate(ctx); err != nil {
		return err
	}
	c.refreshIdentity(ctx, c.activeServer())
	if c.cfg.Worktrees {
		dir, err := c.directory(ctx, c.cfg.Dir)
		if err != nil {
			return err
		}
		items, err := c.api.Worktrees(ctx, dir)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			return fmt.Errorf("phic: no worktrees")
		}
		labels := make([]string, len(items))
		for i, w := range items {
			labels[i] = fmt.Sprintf("%+q", w.Path)
		}
		i, err := c.choose(ctx, "Worktrees", labels)
		if err != nil {
			return err
		}
		c.cfg.Dir = items[i].Path
	}
	if c.cfg.Diff {
		var dir string
		var err error
		if c.cfg.Pane != "" {
			selection, selectErr := c.Select(ctx)
			err = selectErr
			if err == nil {
				dir = selection.Existing.Dir
			}
		} else {
			dir, err = c.directory(ctx, c.cfg.Dir)
		}
		if err != nil {
			return err
		}
		text, err := c.api.RawDiff(ctx, dir, true)
		if err != nil {
			return err
		}
		pager, err := NewPager(c.diffText(dir, text))
		if err != nil {
			return err
		}
		defer pager.Close()
		return RunPager(ctx, c.tty, pager.Path())
	}
	var sel SelectResult
	var err error
	if sessions {
		var dir string
		dir, err = c.directory(ctx, c.cfg.Dir)
		if err == nil {
			sel, err = c.pickSessions(ctx, dir)
		}
	} else {
		sel, err = c.Select(ctx)
	}
	if err != nil {
		if errors.Is(err, errDetach) {
			return nil
		}
		return err
	}
	return c.attachSelected(ctx, sel)
}

// authenticate checks /api/auth/status and prompts for a
// password before the relay takes input ownership.
func (c *client) authenticate(ctx context.Context) error {
	status, err := c.api.AuthStatus(ctx)
	if err != nil {
		return err
	}
	if !status.Enabled || status.Authenticated {
		return nil
	}
	pw, err := c.tty.Password(ctx, "Phi server password: ")
	if err != nil {
		return err
	}
	return c.api.Login(ctx, status, pw)
}
