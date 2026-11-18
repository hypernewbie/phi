package phicmd

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hypernewbie/phi/internal/phiprofiles"

	"golang.org/x/term"
)

// Globals are the flags every command shares.
type Globals struct {
	Server       string
	Coder        string
	Cwd          string
	Session      string
	JSON         bool
	Timeout      time.Duration
	Profiles     string
	PasswordFile string
	NoLogin      bool
	MaxBytes     int64
	Tail         int
}

// State is phi-cmd's own selection file. It never touches the desktop's
// profiles document.
type State struct {
	Server  string `json:"server,omitempty"`
	Coder   string `json:"coder,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	Session string `json:"session,omitempty"`
}

func statePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "phi-cmd", "state.json"), nil
}

// LoadState reads the selection file. A corrupt file is reported on
// stderr and reset, never fatal.
func LoadState() (State, error) {
	path, err := statePath()
	if err != nil {
		return State{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return State{}, nil
		}
		return State{}, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		_ = os.Remove(path)
		return State{}, fmt.Errorf("state file was corrupt and has been reset: %w", err)
	}
	return s, nil
}

// SaveState writes the selection atomically.
func SaveState(s State) error {
	path, err := statePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// usageError marks a CLI mistake: exit 2.
type usageError struct{ err error }

func (u usageError) Error() string { return u.err.Error() }

func usagef(format string, args ...any) error {
	return usageError{fmt.Errorf(format, args...)}
}

// Env holds one command's resolved environment. globalFS stays bound to
// the Globals copy so a command's unknown flags can fall back to the
// global definitions and mutate this env in place.
type Env struct {
	Globals
	State      State
	Profiles   []phiprofiles.Profile
	ProfileIdx int // -1 when --server was a raw URL
	Origin     string
	globalFS   *flag.FlagSet
}

// resolveEnv loads state, merges flags, and resolves the target server:
// flag (profile name/id/URL) > state file > the only configured profile.
func resolveEnv(g Globals) (*Env, error) {
	state, warn := LoadState()
	if warn != nil {
		fmt.Fprintln(os.Stderr, "phi-cmd:", warn)
		state = State{}
	}
	env := &Env{Globals: g, State: state, ProfileIdx: -1}

	path, err := phiprofiles.DefaultPath(g.Profiles)
	if err != nil {
		return nil, err
	}
	data, readErr := os.ReadFile(path)
	if readErr == nil {
		doc, err := phiprofiles.Parse(data)
		if err != nil {
			return nil, fmt.Errorf("phi-cmd: %s: %w", path, err)
		}
		env.Profiles = doc.Profiles()
	} else if !os.IsNotExist(readErr) {
		return nil, readErr
	}

	want := firstNonEmpty(g.Server, state.Server)
	if want == "" {
		if len(env.Profiles) == 1 {
			env.Origin = env.Profiles[0].Origin
			env.ProfileIdx = 0
			return env, nil
		}
		if len(env.Profiles) == 0 {
			return nil, usagef("no servers configured (run `phi-cmd use --server URL` or pass --server)")
		}
		return nil, usagef("multiple servers configured; pass --server NAME or run `phi-cmd use`")
	}
	if isURL(want) {
		env.Origin = strings.TrimRight(want, "/")
		return env, nil
	}
	for i, p := range env.Profiles {
		if p.ID == want || p.Name == want {
			env.Origin = p.Origin
			env.ProfileIdx = i
			return env, nil
		}
	}
	return nil, fmt.Errorf("%w: no configured server %q (see `phi-cmd servers`)", ErrNotFound, want)
}

func isURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// resolveCoder: flag > state > default "pi".
func (e *Env) resolveCoder() string {
	return firstNonEmpty(e.Coder, e.State.Coder, "pi")
}

// resolveCwd: flag > state > "" (server default).
func (e *Env) resolveCwd() string {
	return firstNonEmpty(e.Cwd, e.State.Cwd)
}

// passwordSource resolves the access password: --password-file >
// PHI_CMD_PASSWORD > TTY prompt > absent. --no-login disables login.
func passwordSource(g Globals) PasswordSource {
	if g.NoLogin {
		return NoPassword
	}
	return func(ctx context.Context) (string, error) {
		if g.PasswordFile != "" {
			data, err := os.ReadFile(g.PasswordFile)
			if err != nil {
				return "", fmt.Errorf("read --password-file: %w", err)
			}
			return strings.TrimSpace(string(data)), nil
		}
		if env := os.Getenv("PHI_CMD_PASSWORD"); env != "" {
			return env, nil
		}
		return promptPassword(ctx)
	}
}

// promptPassword asks on the TTY only when stdin is one. /dev/null is a
// character device, so the check must be a real isatty, not a mode bit.
func promptPassword(_ context.Context) (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", nil
	}
	fmt.Fprint(os.Stderr, "phi access password: ")
	return readSecretLine(os.Stdin)
}

func readSecretLine(r io.Reader) (string, error) {
	// Minimal line read without echoing controls; the terminal is the
	// caller's, not ours.
	var buf [1]byte
	var line []byte
	for {
		n, err := r.Read(buf[:])
		if n > 0 {
			if buf[0] == '\n' {
				fmt.Fprintln(os.Stderr)
				return strings.TrimSpace(string(line)), nil
			}
			if buf[0] != '\r' {
				line = append(line, buf[0])
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) > 0 {
				fmt.Fprintln(os.Stderr)
				return strings.TrimSpace(string(line)), nil
			}
			return "", err
		}
	}
}

// connect builds the HTTP client for the resolved origin.
func (e *Env) connect() (*HTTP, error) {
	h, err := NewHTTP(e.Origin, passwordSource(e.Globals))
	if err != nil {
		return nil, err
	}
	if e.MaxBytes > 0 {
		h.MaxBytes = e.MaxBytes
	}
	return h, nil
}

// exitCodeOf maps an error to the contract exit code.
func exitCodeOf(err error) int {
	if err == nil {
		return ExitOK
	}
	var u usageError
	if errors.As(err, &u) {
		return ExitUsage
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ExitTimeout
	}
	var api *APIError
	if errors.As(err, &api) && api.Status == httpStatusUnauthorized {
		return ExitAuth
	}
	if errors.Is(err, ErrUnauthorized) {
		return ExitAuth
	}
	if errors.Is(err, ErrNotFound) {
		return ExitNotFound
	}
	return ExitError
}

const httpStatusUnauthorized = 401

// newFlagSet builds a per-command flag set that still sees the globals.
type flagParser struct {
	g    *Globals
	fs   *flag.FlagSet
	args []string
}

// parseGlobals parses the global flags that appear before the command
// name. Flags after the command belong to the command; those it does not
// define fall back to the same set (so `send "hi" --json` works).
func parseGlobals(argv []string) (Globals, []string, error) {
	var g Globals
	fs := bindGlobalFlags(&g)
	if err := fs.Parse(argv); err != nil {
		return g, nil, usagef("bad flags: %v", err)
	}
	return g, fs.Args(), nil
}

// bindGlobalFlags builds the shared flag set over one Globals value.
// Commands reuse it for their unknown-flag fallback, mutating g in place.
func bindGlobalFlags(g *Globals) *flag.FlagSet {
	fs := flag.NewFlagSet("phi-cmd", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&g.Server, "server", "", "server profile name/id or URL")
	fs.StringVar(&g.Coder, "coder", "", "backend coder (e.g. pi, opencode, bash)")
	fs.StringVar(&g.Cwd, "cwd", "", "working directory on the server")
	fs.StringVar(&g.Session, "session", "", "live chat session id")
	fs.BoolVar(&g.JSON, "json", false, "machine-readable output")
	fs.DurationVar(&g.Timeout, "timeout", 2*time.Minute, "overall deadline")
	fs.StringVar(&g.Profiles, "profiles", "", "desktop profiles.json path override")
	fs.StringVar(&g.PasswordFile, "password-file", "", "file with the access password")
	fs.BoolVar(&g.NoLogin, "no-login", false, "never log in; fail on auth")
	fs.Int64Var(&g.MaxBytes, "max-bytes", defaultMaxOut, "output byte cap")
	fs.IntVar(&g.Tail, "tail", 0, "keep only the last N lines/messages (0 = all)")
	return fs
}
