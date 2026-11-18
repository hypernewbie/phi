package phicmd

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// cmdInput sends raw bytes to a live pane over the pane WebSocket.
// The CLI interprets nothing: \r and \x1b sequences are typed as-is
// after escape decoding of \r, \n, \t, \\ and \xNN.
func cmdInput(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("input")
	paneFlag := fs.String("pane", "", "pane id (default: the only live pane)")
	hexMode := fs.Bool("hex", false, "send raw bytes given as hex")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("input: %v", err)
	}
	if len(positional) < 1 {
		return usagef("input: pass the text to type (quote it)")
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	pane, err := resolvePane(ctx, env, h, *paneFlag)
	if err != nil {
		return err
	}
	if pane == "" {
		return fmt.Errorf("%w: no live pane (spawn one in the web UI or via the server API)", ErrNotFound)
	}
	var payload []byte
	if *hexMode {
		payload, err = hex.DecodeString(strings.Join(positional, ""))
		if err != nil {
			return usagef("input: bad hex: %v", err)
		}
	} else {
		payload = []byte(unescapeInput(strings.Join(positional, " ")))
	}
	p, err := AttachPane(ctx, h, pane)
	if err != nil {
		return err
	}
	defer p.Close()
	select {
	case ev := <-p.Frames():
		if ev.Kind != "attach" {
			return fmt.Errorf("phi-cmd: expected attach frame first, got %s", ev.Kind)
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := p.SendInput(payload); err != nil {
		return err
	}
	if env.JSON {
		return printJSON(map[string]any{"pane": pane, "sent_bytes": len(payload)})
	}
	fmt.Printf("sent %d bytes to pane %s\n", len(payload), pane)
	return nil
}

// unescapeInput decodes the small set of escapes a command line can
// carry: \r \n \t \\ and \xNN. Everything else is literal.
func unescapeInput(s string) string {
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 >= len(s) {
			sb.WriteByte(s[i])
			continue
		}
		i++
		switch s[i] {
		case 'r':
			sb.WriteByte('\r')
		case 'n':
			sb.WriteByte('\n')
		case 't':
			sb.WriteByte('\t')
		case '\\':
			sb.WriteByte('\\')
		case 'x':
			if i+2 < len(s) {
				if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
					sb.WriteByte(byte(v))
					i += 2
					continue
				}
			}
			// Not two hex digits: keep the original bytes.
			sb.WriteByte('\\')
			sb.WriteByte('x')
		default:
			sb.WriteByte('\\')
			sb.WriteByte(s[i])
		}
	}
	return sb.String()
}

// gitKind is one read-only git view.
func cmdGit(ctx context.Context, env *Env, args []string) error {
	if len(args) < 1 {
		return usagef("git: pass a subcommand: status | log | diff")
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "status":
		return cmdGitRaw(ctx, env, rest, "raw-status", nil)
	case "log":
		return cmdGitRaw(ctx, env, rest, "raw-log", nil)
	case "diff":
		return cmdGitDiff(ctx, env, rest)
	default:
		return usagef("git: unknown subcommand %q (status | log | diff)", sub)
	}
}

func cmdGitRaw(ctx context.Context, env *Env, args []string, endpoint string, _ any) error {
	fs := newSubflags("git " + endpoint)
	cwd := fs.String("cwd", "", "working directory (default: active cwd)")
	if _, err := parseSubArgs(fs, env, args); err != nil {
		return usagef("git: %v", err)
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	query := ""
	if c := firstNonEmpty(*cwd, env.resolveCwd()); c != "" {
		query = "cwd=" + url.QueryEscape(c)
	}
	body, status, err := h.Raw(ctx, "GET", "/api/git/"+endpoint+"?"+query, nil)
	if err != nil {
		return err
	}
	return printGitBody(env, body, status)
}

func cmdGitDiff(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("git diff")
	cwd := fs.String("cwd", "", "working directory")
	commit := fs.String("commit", "", "commit selector: sha | staged | unstaged; empty = whole worktree")
	contextLines := fs.String("context", "3", "context lines: 3 | 30")
	ansi := fs.Bool("ansi", false, "keep the server's ANSI colours")
	if _, err := parseSubArgs(fs, env, args); err != nil {
		return usagef("git diff: %v", err)
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	params := []string{}
	if c := firstNonEmpty(*cwd, env.resolveCwd()); c != "" {
		params = append(params, "cwd="+url.QueryEscape(c))
	}
	if *commit != "" {
		params = append(params, "commit="+url.QueryEscape(*commit))
	}
	if *contextLines == "30" {
		params = append(params, "context=30")
	}
	if *ansi {
		params = append(params, "ansi=1")
	}
	query := strings.Join(params, "&")
	body, status, err := h.Raw(ctx, "GET", "/api/git/raw-diff?"+query, nil)
	if err != nil {
		return err
	}
	return printGitBody(env, body, status)
}

func printGitBody(env *Env, body []byte, status int) error {
	text := string(body)
	if env.JSON {
		return printJSON(map[string]any{"status": status, "text": text})
	}
	if t, _ := tailLines(text, env.Tail); true {
		text = t
	}
	capped, _ := capString(text, env.MaxBytes)
	fmt.Print(capped)
	if !strings.HasSuffix(capped, "\n") {
		fmt.Println()
	}
	return nil
}

type runResultRow struct {
	Worktree   string `json:"worktree"`
	Success    bool   `json:"success"`
	ExitCode   int    `json:"exit_code"`
	Output     string `json:"output"`
	DurationMs int64  `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
}

// cmdRun executes a command on the backend host via the quick-command
// endpoint, once per worktree.
func cmdRun(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("run")
	cwd := fs.String("cwd", "", "working directory (default: the server's active cwd)")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("run: %v", err)
	}
	if len(positional) < 1 {
		return usagef("run: pass the command line (quote it)")
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{
		"command": strings.Join(positional, " "),
		"cwd":     firstNonEmpty(*cwd, env.resolveCwd()),
	})
	var out struct {
		Results []runResultRow `json:"results"`
	}
	if err := h.Do(ctx, "POST", "/api/cmd/run", payload, &out); err != nil {
		return err
	}
	if env.JSON {
		return printJSON(out)
	}
	for _, r := range out.Results {
		fmt.Printf("# %s (exit %d, %dms)\n", r.Worktree, r.ExitCode, r.DurationMs)
		fmt.Print(r.Output)
		if r.Error != "" {
			fmt.Printf("error: %s\n", r.Error)
		}
	}
	return nil
}

// cmdRaw is the bounded escape hatch: any /api endpoint, same auth.
func cmdRaw(ctx context.Context, env *Env, args []string) error {
	fs := newSubflags("raw")
	positional, err := parseSubArgs(fs, env, args)
	if err != nil {
		return usagef("raw: %v", err)
	}
	if len(positional) < 2 {
		return usagef("raw: pass METHOD and PATH (e.g. raw GET /api/version)")
	}
	method, path := strings.ToUpper(positional[0]), positional[1]
	var body []byte
	if len(positional) >= 3 {
		body = []byte(strings.Join(positional[2:], " "))
	}
	h, err := env.connect()
	if err != nil {
		return err
	}
	respBody, status, err := h.Raw(ctx, method, path, body)
	if err != nil && status == 0 {
		return err
	}
	if env.JSON {
		return printJSON(map[string]any{"status": status, "body": string(respBody)})
	}
	fmt.Printf("status: %d\n", status)
	text := string(respBody)
	if t, _ := tailLines(text, env.Tail); true {
		text = t
	}
	fmt.Print(text)
	if !strings.HasSuffix(text, "\n") && text != "" {
		fmt.Println()
	}
	return nil
}
