// Package phic is the minimal native terminal client for Phi.
package phic

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// Run is the entry point. It parses flags, performs the auth
// dance, opens the WebSocket, and runs the relay loop until
// the backend exits or the user detaches.
func Run(args []string) error {
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
	var c config
	fs.StringVar(&c.Server, "server", "http://127.0.0.1:7070", "Phi server URL")
	fs.StringVar(&c.Pane, "pane", "", "exact live pane ID to attach to")
	fs.StringVar(&c.Coder, "coder", "", "backend name (e.g. pi, opencode, bash)")
	fs.BoolVar(&c.NewPane, "new", false, "create a fresh pane rather than reattaching")
	fs.BoolVar(&c.Help, "help", false, "show usage")
	fs.BoolVar(&c.Version, "version", false, "show version")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	return c, nil
}

type config struct {
	Server  string
	Pane    string
	Coder   string
	NewPane bool
	Help    bool
	Version bool
}

func printUsage(w *os.File) {
	fmt.Fprintln(w, `Usage: phic [options] <directory>

Options:
  --server URL    Phi server URL (default http://127.0.0.1:7070)
  --pane ID       attach to an exact live pane ID
  --coder NAME    backend name (e.g. pi, opencode, bash)
  --new           create a fresh pane rather than reattaching
  --help          show this message
  --version       show version`)
}

const version = "phic dev (commit unreleased)"

// client owns the connection lifetime.
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

// Close releases the controlling terminal.
func (c *client) Close() error {
	if c.tty != nil {
		return c.tty.Close()
	}
	return nil
}

// Run performs the auth dance, resolves a pane, and enters
// the relay loop. It returns on disconnect, fatal error, or
// signal.
func (c *client) Run(ctx context.Context) error {
	if err := c.authenticate(ctx); err != nil {
		return err
	}
	pane, err := c.resolvePane(ctx)
	if err != nil {
		return err
	}
	relay := NewRelay(c.tty, c.api)
	if _, err := relay.Connect(ctx, pane); err != nil {
		return err
	}
	return relay.Run(ctx)
}

// authenticate checks /api/auth/status and prompts for a
// password if the server requires one. The plan calls for
// the password to be read without echo before the relay
// takes input ownership — the relay is not yet started.
func (c *client) authenticate(ctx context.Context) error {
	status, err := c.api.AuthStatus(ctx)
	if err != nil {
		return err
	}
	if !status.Enabled {
		return nil
	}
	if status.Authenticated {
		return nil
	}
	pw, err := readPassword("Phi server password: ")
	if err != nil {
		return err
	}
	return c.api.Login(ctx, status, pw)
}

// resolvePane is the plan's startup selection (section 2).
// For Commit 2 the implementation is reduced to "use --pane
// or fail with a clear message"; Commit 3 adds the session
// list.
func (c *client) resolvePane(_ context.Context) (string, error) {
	if c.cfg.Pane != "" {
		return c.cfg.Pane, nil
	}
	return "", errors.New("phic: --pane is required in this build (commit 3 adds the session list)")
}

// readPassword reads a line from /dev/tty without echo. The
// plan: "Read the password without echo before the relay
// takes input ownership."
func readPassword(prompt string) (string, error) {
	f, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	fmt.Fprint(f, prompt)
	line, err := bufio.NewReader(f).ReadString('\n')
	if err != nil {
		return "", err
	}
	fmt.Fprintln(f)
	return trimCRLF(line), nil
}

func trimCRLF(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
