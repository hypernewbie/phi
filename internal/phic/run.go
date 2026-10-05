// Package phic is the minimal native terminal client for Phi.
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
	fs.StringVar(&c.Server, "server", "http://127.0.0.1:7070", "Phi server URL")
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
	Server    string
	Pane      string
	Coder     string
	Dir       string
	NewPane   bool
	Help      bool
	Version   bool
	Diff      bool
	Worktrees bool
}

func printUsage(w *os.File) {
	fmt.Fprintln(w, `Usage: phic [options] <directory>

Options:
  --server URL    Phi server URL (default http://127.0.0.1:7070)
  --pane ID       attach to an exact live pane ID
  --coder NAME    backend name (e.g. pi, opencode, bash)
  --new           create a fresh pane rather than reattaching (requires --coder)
  --diff          show current diff in less -R and exit
  --worktrees     select an existing worktree before startup
  --help          show this message
  --version       show version

Relay keys: Ctrl-] q detaches; Ctrl-] Ctrl-] sends a literal prefix.
Live menus are disabled until screen restoration is proved. Startup
selection and --diff do not overwrite an attached backend screen.`)
}

type client struct {
	cfg config
	tty *TTY
	api *apiClient
}

func newClient(_ context.Context, cfg config) (*client, error) {
	tty, err := OpenTTY()
	if err != nil {
		return nil, err
	}
	api, err := newAPIClient(cfg.Server)
	if err != nil {
		_ = tty.Close()
		return nil, err
	}
	return &client{cfg: cfg, tty: tty, api: api}, nil
}

func (c *client) Close() error {
	if c.tty != nil {
		return c.tty.Close()
	}
	return nil
}

func (c *client) Run(ctx context.Context) error {
	if err := c.authenticate(ctx); err != nil {
		return err
	}
	if c.cfg.Worktrees {
		dir, err := resolveDir(c.cfg.Dir)
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
		dir, err := resolveDir(c.cfg.Dir)
		if c.cfg.Pane != "" {
			selection, selectErr := c.Select(ctx)
			err = selectErr
			if err == nil {
				dir = selection.Existing.Dir
			}
		}
		if err != nil {
			return err
		}
		text, err := c.api.RawDiff(ctx, dir, true)
		if err != nil {
			return err
		}
		pager, err := NewPager(text)
		if err != nil {
			return err
		}
		defer pager.Close()
		return RunPager(ctx, c.tty, pager.Path())
	}
	sel, err := c.Select(ctx)
	if err != nil {
		if errors.Is(err, errDetach) {
			return nil
		}
		return err
	}
	pane := sel.PaneID
	if pane == "" && sel.NewSpawn != nil {
		cols, rows, err := c.tty.Size()
		if err != nil {
			return err
		}
		if cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 {
			return fmt.Errorf("phic: unusable terminal size")
		}
		sel.NewSpawn.Cols, sel.NewSpawn.Rows = uint16(cols), uint16(rows)
		sp, err := c.api.Spawn(ctx, *sel.NewSpawn)
		if err != nil {
			return err
		}
		pane = sp.PaneID
	}
	if pane == "" {
		return fmt.Errorf("phic: server returned an empty pane ID")
	}
	if err := c.tty.EnterRaw(); err != nil {
		return err
	}
	relay := NewRelay(c.tty, c.api)
	// Resuming a saved session still starts a new process and recording. Its
	// startup terminal queries are live, not replies from an older attachment.
	relay.fresh = sel.NewSpawn != nil
	if _, err := relay.Connect(ctx, pane); err != nil {
		return err
	}
	defer relay.Close()
	return relay.Run(ctx)
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
