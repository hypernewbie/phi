# Native console client

`phic` is Phi Desktop Lite: a native multi-server Phi client built on Bubble Tea v2 with an embedded libghostty-vt terminal emulator. It renders backend output inside persistent application chrome instead of passing bytes through. Phi still owns processes, sessions, and durable recordings; the console owns the displayed frame and its bounded scrollback.

## Build

```sh
go build -o phic ./cmd/phic
```

The default build has no emulator and reports a precise error when a pane is opened. Enable the pinned native adapter with its build tag:

```sh
go build -tags termemu_ghostty -o phic ./cmd/phic
```

The adapter links the per-target archive under `native/libghostty-vt/<os>-<arch>/`; see `native/libghostty-vt/README.md` for the provenance manifest and rebuild contract. No runtime downloader, external Ghostty installation, or separate shared library is required. Unsupported targets keep the precise `native emulator not built in this binary` error rather than substituting another parser.

## Start

```sh
phic
phic --server http://host:7070
phic --pane <pane-id>
phic --new --coder bash /srv/project
phic --coder pi .
phic --diff
phic --worktrees
```

Normal startup restores the most recently used saved server. An empty server list opens **Add Phi server**, which accepts bare hostnames and HTTP(S) URLs, adds `http://` and port `7070` when desktop does, and splits spaces or pasted newlines into multiple servers. Credentials, non-root paths, query strings, and fragments are rejected after normalization. An empty list contains no invented localhost entry.

Profiles come from the shared desktop file; Go preserves desktop preferences and unknown fields, keeps a `.bak`, and saves through a synced temporary file and atomic rename. Standard locations:

- macOS: `~/Library/Application Support/phi-client/profiles.json`
- Linux: `$XDG_CONFIG_HOME/phi-client/profiles.json`, or `~/.config/phi-client/profiles.json`

The development app's `phi-desktop-electron` and legacy `Phi` files migrate to the same location. Use `--profiles FILE` when desktop userData is elsewhere. `--server URL` selects or adds that server in the same saved list. Desktop edits, including rename, removal, and reordering, load at startup and on reload.

Authentication uses the existing password challenge and cookie. Passwords are not echoed or stored. Each origin owns a separate cookie jar, even for servers on the same host at different ports. Switching servers leaves the old backend running; a failed switch returns to the outgoing tab.

An explicit directory argument is the captured launch target and outranks remembered UI state. Absolute remote paths are server paths, not local filesystem checks. A server switch never carries the outgoing server's directory into the next server's context.

## Console layout

- Server rail with identity glyphs, theme accent, health, and the active server.
- Context row: project, worktree, coder, New Session, and the diff toggle.
- Sessions sidebar: New Session, saved sessions for the selected coder/project, then live panes not yet open as tabs. `/` filters; `r` refreshes.
- Terminal tabs: attached panes, listed live panes, unread marks, exited panes, and `+N` overflow.
- Embedded terminal: copied cells with RGB/indexed colors, attributes, cursor position, and client-side selection.
- Optional diff panel with refresh, search (`/`, `n`/`N`), and explicit copy (`y`).
- Footer: status, errors, and contextual hints.

Chrome stays intact during cursor movement, clear-screen, scrolling, and alternate-screen output because the application renders a copied frame rather than passing bytes through.

## Keys

Prefix: Ctrl-] (`Ctrl-] Ctrl-]` sends a literal prefix). In terminal focus, keys go to the backend unchanged: Ctrl-C, Tab, arrows, digits, Escape, and bracketed paste.

| Key | Action |
| --- | --- |
| `Ctrl-] 1`–`9` | switch server |
| `Ctrl-] b` | focus server rail (`a` add, `m` rename, `x` remove, `r` reload, `K`/`J` reorder, `c` copy URL) |
| `Ctrl-] s` | focus sessions (`Enter` open/resume, `n` new, `c` coder, `p` project, `w` worktree) |
| `Ctrl-] t` | focus tabs (`x` soft close, `X` final close, `u` undo, `r` rename, `p` pin, `m` mark) |
| `Ctrl-] d` | toggle diff panel |
| `Ctrl-] h` | bounded history browser |
| `Ctrl-] p` / `w` / `c` | project / worktree / coder dialogs |
| `Ctrl-] n` | New Session |
| `Ctrl-] o` / `S` | OpenCode Mini / Shell session |
| `Ctrl-] a` / `m` / `r` | add / rename / reload servers |
| `Ctrl-] y` | copy diff text or the terminal selection |
| `Ctrl-] ?` / `q` | help / quit |

Tab cycles chrome regions; Esc returns to the terminal. New Session sends exactly one fresh spawn request with an empty resume identity and the captured project, worktree, coder, and widget geometry. A saved-session row sends its exact resume identity, preferring `session_path` when present, without another picker. `--pane` attaches the exact live pane with no project, coder, or session picker.

## Terminal fidelity

- Full key press/repeat/release, paste, and mouse routing. Modified Enter, Ctrl-digit, application-cursor arrows, and Kitty-style disambiguation are encoded by the adapter from the backend's current modes, not guessed by the UI.
- Normal and alternate buffers, RGB and indexed colors, graphemes with explicit width, synchronized output, and cursor state come from copied frames.
- The emulator runs on one owner goroutine per pane. The UI only reads copied frames and enqueues input requests, so no native call leaves the owner.
- Mouse is forwarded when the backend claims it; otherwise drag selects text and the release copies it. Denied host effects (clipboard writes, desktop notifications, file-backed graphics) never reach the application.

## Sessions, tabs, and lifecycle

- Live panes are listed without being seized. Selecting one attaches through Phi's recording at the current widget geometry; it never spawns or resumes a process.
- Soft close (`x`) marks the tab and arms a 3-second Undo (`u`). Final close (`X`, or a second close) sends exactly one DELETE to the captured origin.
- Quitting detaches every pane and sends no DELETE; server policy and pinned panes are unchanged.
- Reconnect keeps the retained core and replays the recording gap. A changed recording epoch rebuilds the emulator instead of merging two terminal states.
- History browsing replays a bounded tail of the recording into a separate emulator, so it cannot reset a live fullscreen application. Pane scrollback is bounded at 64 MiB / 10,000 lines; history windows are bounded at 4 MiB.
- UI intent (project, worktree, tab order, active tab, diff visibility) is stored in the shared desktop document under the versioned `phicUI` key. It never contains output, cookies, passwords, prompts, or emulator memory.

## Compatibility limits

macOS and Linux are the supported console platforms. Windows keeps the `phi` server command and cross-builds the client, but runtime Windows testing is not part of this change; the native adapter archive for Windows x64 must be produced by the documented rebuild contract. A build without `-tags termemu_ghostty` starts the console but reports the precise unsupported-adapter error when a pane is opened.

The legacy inline menu/relay client is no longer the entry point. Its code and tests remain temporarily because shared transport helpers and store-interoperability tests still depend on them; deletion is staged after the console contracts finish replacing them.
