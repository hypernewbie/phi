# Native terminal client

`phic` is a native multi-server Phi client. Backend output is raw; client menus are inline TUIs. It uses no Charm libraries, TUI framework, or terminal emulator.

Phi owns the processes, sessions, and durable recordings. The native terminal owns the displayed buffers and its scrollback limit.

## Start

Start Phi first. Then run:

```sh
phic .
phic --new --coder bash .
phic --coder pi .
phic --pane <pane-id>
```

By default, phic reads the desktop client's `profiles.json` in saved sidebar order and starts with the most recently used server. Standard locations are:

- macOS: `~/Library/Application Support/phi-client/profiles.json`
- Linux: `$XDG_CONFIG_HOME/phi-client/profiles.json`, or `~/.config/phi-client/profiles.json`

The development app's `phi-desktop-electron` directory is also recognized. Use `--profiles FILE` if desktop userData is elsewhere. The client reads the backup when necessary, but never writes or renames either desktop file.

With no saved profiles, the default is `http://127.0.0.1:7070`. `--server URL` uses one explicit server; combine it with `--profiles FILE` to retain that saved list and select or add the explicit origin for this run. No server configuration is duplicated or persisted by phic.

Without an unambiguous free pane, the client shows a numbered startup list. A live pane with another attached client requires explicit selection. Shared clients can change the same backend terminal size.

`--pane` uses the server's exact pane identity and directory. It does not change the existing OpenCode launch mode.

Authentication uses the existing password challenge and cookie. Passwords are not echoed or stored by the client. Each origin owns a separate cookie jar, even for servers on the same host at different ports. Changing servers leaves the old backend running and remembers its exact pane for return during this client run.

Remote `phic .` opens the server's project list. Absolute remote paths are server paths, not local filesystem checks. A server switch never carries the outgoing server's directory into the next server's project selection. An unavailable server can be skipped from the startup picker; a failed live switch returns to the outgoing pane.

## Other operations

```sh
phic --diff .
phic --worktrees .
```

`--diff` opens the current server diff in `less -R`, then exits. It retains the existing diff endpoint's whitespace policy.

`--worktrees` selects an existing worktree before startup. It does not change the browser's global workspace or create a worktree.

## Relay keys

- Press Ctrl-], then `b`, for the colored server bar.
- Press Ctrl-], then `1`–`9`, to switch servers in desktop sidebar order.
- On terminals with Kitty or modifyOtherKeys reporting, Ctrl-1 through Ctrl-9 also switch servers. Plain digits are never interpreted as shortcuts.
- Press Ctrl-], then `s`, for sessions and new panes.
- Press Ctrl-], then `d`, for the current pane's diff.
- Press Ctrl-], then `w`, for worktrees.
- Press Ctrl-], then `?`, for help.
- Press Ctrl-], then `q`, to detach.
- Press Ctrl-] twice to send one original prefix sequence.
- Other application input stays unchanged, including delimited paste.

The server bar shows colored boxes and highlights the active server. Session, project, worktree, help, error, and diff headings use the selected server's reported Phi accent. Backend output is not recolored. Unobserved or login-protected servers use the default accent until their identity is available. `NO_COLOR` and `TERM=dumb` disable client colors.

Use numbered choices, Enter, n/p for pages, and Esc/q to return. Enhanced Ctrl-digit shortcuts also work in client selection menus. Inside the external pager, use its own keys and exit it before switching servers. Holding Ctrl alone is not observable on legacy terminals; use Ctrl-] b.

The client recognizes the prefix under legacy, Kitty, and modifyOtherKeys encodings. Kitty alternate-key identities, associated text, and Caps/Num Lock state bits are supported. Undelimited pasted control bytes cannot be distinguished from typed control bytes.

## Compatibility limits

macOS and Linux are the supported client platforms. Windows still supports the existing `phi` server command. The native `phic` relay is not supported there.

Client views take ownership only after both relay workers stop. Menus print inline, with numbered choices, pagination, and Esc/q cancellation. Backend output continues into Phi's recording, not a client queue. Returning reconnects to the selected pane and rebuilds the native display. The diff pager runs with `LESSSECURE=1` and does not run shell commands or input filters.

Fixed-geometry rebuilds are tested against a development-only terminal oracle, including normal/alternate buffers, cursor/style continuation, tabs, scroll regions, and repeated returns. See `internal/termproof/PROOF.md` for the distinction from arbitrary screen snapshotting.

Reused panes replay from the beginning of Phi's recording in bounded requests. Repaint suppresses already-seen terminal queries and clipboard writes. A small per-origin/per-pane frontier distinguishes this history from bytes emitted while a menu or another server was open: those bytes are delivered as live, so new terminal queries receive their replies. An unfinished request could not have been answered before its terminator existed; it resumes live at that frontier. The original recording is never changed, and the client keeps no output copy.

For a pane first attached by this client, complete requests in its existing recording are treated as historical. Fresh launches and saved-session launches receive their startup replies normally.

Replay uses the current native terminal size. Output originally drawn at another size can wrap or position differently. The client sends the current PTY dimensions but does not resize the user's terminal window or inject backend redraw keys. It is not an exact historical screen emulator. Repaint rejects an escape longer than 1 MiB rather than silently truncate it.

Native scrollback capacity depends on the terminal. The full recording remains in Phi; this client does not implement a deferred history viewer.

A saved-session resume starts a new process and recording. Its startup terminal replies are live, even though its conversation already exists.

On an input socket-write failure, the client exits instead of retrying an input frame whose delivery is ambiguous. Output reconnects recover missed recording bytes without moving the written frontier over a failed range.

Detach does not kill or pin a backend. Existing server policy applies: an unpinned pane with no attached clients has a 30-minute grace timer.

Terminal cleanup is best effort. SIGKILL cannot run cleanup.

## Native test

Run installed backends without user credentials or model prompts:

```sh
python3 scripts/test-phic-native.py --opencode2 /absolute/path/to/opencode2
```

Use `--coders bash,pi` for a smaller installed set. The runner requires tmux as a test dependency; phic does not. It uses an isolated HOME, service port, Git fixture, and tmux socket. Shell startup files and user Git configuration are excluded. It prints the evidence directory.

For each backend, the runner compares native styled cells and cursor/buffer state after six view returns, then detaches and checks historical reattachment and backend survival. Shell also retains an unfinished command. A blank screen or failure to detach makes the command fail. No model prompts are sent. Codex and Claude onboarding checks do not claim paid-model access.

The Linux CI job runs this native Shell check in addition to the Go PTY tests and the development-only screen oracle.
