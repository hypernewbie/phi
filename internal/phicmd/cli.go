// Package phicmd CLI dispatch: one command per invocation, stable exit
// codes, bounded output.
package phicmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

const usageText = `phi-cmd - drive Phi backends from the command line

Usage: phi-cmd [global flags] <command> [args]

Commands:
  servers                  configured backends, health, identity, live counts
  status [--watch]         live chat sessions, panes, coders of one backend
  tabs [--coder ID]        coder tabs with their sessions, plus live panes
  use [CODER] [--server S] [--cwd DIR] [--session SID] [--clear]
                           remember the selection for later commands
  sessions [--limit N]     persisted sessions of the active coder/cwd
  transcript [--session SID | --id ID]
                           read a transcript (--tail N to bound it)
  send [--new | --resume PATH | --session SID] "message"
                           prompt a chat session and stream the answer
  input [--pane ID] [--hex] "text"
                           type raw bytes into a live pane (\r, \x1b as \xNN)
  models                   available models, thinking levels, or the recipe
  model set PROVIDER/MODEL | MODEL [--pane ID]
                           switch by chat set_model, pi bridge, or recipe
  git status | log | diff  read-only git views of a server cwd
  run [--cwd DIR] "cmd"    run a command on the backend host
  raw METHOD PATH [BODY]   bounded escape hatch to any /api endpoint

Global flags:
  --server NAME|URL        target backend (default: state file, or the only one)
  --coder ID               active coder (default: pi)
  --cwd DIR                server-side working directory
  --session SID            live chat session id
  --json                   machine-readable output (stable field names)
  --timeout DUR            overall deadline (default 2m)
  --profiles FILE          desktop profiles.json override
  --password-file FILE     access password file (else PHI_CMD_PASSWORD, else TTY)
  --no-login               never log in; fail on auth
  --max-bytes N            output byte cap (default 1 MiB)
  --tail N                 keep only the last N lines/messages

Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 auth, 5 timeout.
Config: reads the desktop's shared profile document; writes only its own
state file (%s). No terminal emulation, no server changes.`

// usageBanner fills the usage text's state-file placeholder.
func usageBanner() string {
	path, _ := statePath()
	return fmt.Sprintf(usageText, path)
}

// Run is the CLI entry point; it returns the process exit code.
func Run(argv []string) int {
	if len(argv) == 0 {
		fmt.Fprint(os.Stderr, usageBanner())
		return ExitUsage
	}
	if argv[0] == "help" || argv[0] == "--help" || argv[0] == "-h" {
		fmt.Print(usageBanner())
		return ExitOK
	}
	if argv[0] == "--version" || argv[0] == "version" {
		fmt.Println(Version())
		return ExitOK
	}
	globals, rest, err := parseGlobals(argv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "phi-cmd:", err)
		return exitCodeOf(err)
	}
	// Flag registration resets its variable to the default, so the env
	// rebinds first and re-parses the same pre-command tokens to restore
	// the parsed values into its own Globals copy.
	preCommand := argv
	if len(rest) <= len(argv) {
		preCommand = argv[:len(argv)-len(rest)]
	}
	if len(rest) == 0 {
		fmt.Fprint(os.Stderr, usageBanner())
		return ExitUsage
	}
	cmd, args := rest[0], rest[1:]

	ctx, cancel := context.WithTimeout(context.Background(), globals.Timeout)
	defer cancel()
	// Ctrl-C cancels the deadline instead of killing mid-write.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	go func() {
		<-stop
		cancel()
	}()

	var runErr error
	withMode := func(fn func(context.Context, *Env, []string) error, allServers bool) error {
		env, err := resolveEnvMode(globals, allServers)
		if err != nil {
			return err
		}
		env.globalFS = bindGlobalFlags(&env.Globals)
		if len(preCommand) > 0 {
			_ = env.globalFS.Parse(preCommand)
		}
		return fn(ctx, env, args)
	}
	with := func(fn func(context.Context, *Env, []string) error) error {
		return withMode(fn, false)
	}
	switch cmd {
	case "servers":
		runErr = withMode(cmdServers, true)
	case "status":
		runErr = with(cmdStatus)
	case "tabs":
		runErr = with(cmdTabs)
	case "use":
		runErr = withMode(cmdUse, true)
	case "sessions":
		runErr = with(cmdSessions)
	case "transcript":
		runErr = with(cmdTranscript)
	case "send":
		runErr = with(cmdSend)
	case "input":
		runErr = with(cmdInput)
	case "models":
		runErr = with(cmdModels)
	case "model":
		if len(args) == 0 || args[0] != "set" {
			runErr = usagef("model: only `model set` exists")
		} else {
			args = args[1:]
			runErr = with(cmdModelSet)
		}
	case "git":
		runErr = with(cmdGit)
	case "run":
		runErr = with(cmdRun)
	case "raw":
		runErr = with(cmdRaw)
	case "--version", "version":
		fmt.Println(Version())
		return ExitOK
	default:
		runErr = usagef("unknown command %q (see `phi-cmd help`)", cmd)
	}
	if runErr != nil {
		fmt.Fprintln(os.Stderr, "phi-cmd:", runErr)
	}
	return exitCodeOf(runErr)
}

// Version is overridden by the build (-X phicmd.version).
var version = "dev"

// Version returns the CLI version string.
func Version() string { return "phi-cmd " + version }

// SetVersion sets the version banner from the build.
func SetVersion(v, commit string) {
	if v != "" && v != "dev" {
		version = v
	}
	if commit != "" && commit != "unreleased" {
		version += " (commit: " + commit + ")"
	}
}
