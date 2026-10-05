# Native terminal client

`phic` is a Go client for Phi on the same host. It forwards terminal bytes without a TUI framework or an emulator.

Phi owns the processes, sessions, and durable recordings. The native terminal owns the displayed buffers and its scrollback limit.

## Start

Start Phi first. Then run:

```sh
phic .
phic --new --coder bash .
phic --coder pi .
phic --pane <pane-id>
```

The default server is `http://127.0.0.1:7070`. Use `--server` for a different local port.

Without an unambiguous free pane, the client shows a numbered startup list. A live pane with another attached client requires explicit selection. Shared clients can change the same backend terminal size.

`--pane` uses the server's exact pane identity and directory. It does not change the existing OpenCode launch mode.

Authentication uses the existing password challenge and cookie. Passwords are not echoed or stored by the client.

## Other operations

```sh
phic --diff .
phic --worktrees .
```

`--diff` opens the current server diff in `less -R`, then exits. It retains the existing diff endpoint's whitespace policy.

`--worktrees` selects an existing worktree before startup. It does not change the browser's global workspace or create a worktree.

## Relay keys

- Press Ctrl-], then `q`, to detach.
- Press Ctrl-] twice to send one original prefix sequence.
- Other application input stays unchanged, including delimited paste.

The client recognizes the prefix under legacy, Kitty, and modifyOtherKeys encodings. Kitty alternate-key identities, associated text, and Caps/Num Lock state bits are supported. Undelimited pasted control bytes cannot be distinguished from typed control bytes.

## Compatibility limits

macOS and Linux are the supported client platforms. Windows still supports the existing `phi` server command. The native `phic` relay is not supported there.

Live session, diff, and worktree overlays remain disabled. The original screen fixture did not prove safe restoration. See `internal/termproof/PROOF.md` for the measured counterexamples.

Reused panes replay from the beginning of Phi's recording in bounded requests. Repaint suppresses historical terminal queries and clipboard writes; live output and new queries remain unchanged. A control split between replay and live retains its replay policy until complete. The original recording is never changed.

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

Use `--coders bash,pi` for a smaller installed set. The runner requires tmux as a test dependency; phic does not. It uses an isolated HOME, service port, and tmux socket. It prints the evidence directory. A blank screen or failure to detach makes the command fail.

This tests startup and detach, not historical reattachment or live screen restoration.
