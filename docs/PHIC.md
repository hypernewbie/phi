# Native console client

`phic` is Phi Desktop Lite: a native multi-server Phi client built on Bubble Tea v2 with an embedded libghostty-vt terminal emulator. It renders backend output inside persistent application chrome instead of passing bytes through. Phi still owns processes, sessions, and durable recordings; the console owns the displayed frame and its bounded scrollback.

## Build

```sh
go build -o phic ./cmd/phic
```

The default CGO build includes the emulator. Source installation requires Go and a supported C compiler.

```sh
go install ./cmd/phic
```

The module includes the pinned static archives under `native/libghostty-vt/<os>-<arch>/`.
The manifest and rebuild procedure are in `native/libghostty-vt/README.md`.
No special build tag, runtime downloader, external Ghostty installation, or separate shared library is necessary.
A CGO-disabled client cannot run the console. It reports the requirement before it enters fullscreen.
The root `phi` server retains its pure-Go build path.

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

Authentication uses the existing password challenge and cookie. Passwords are not echoed or stored. Each origin owns a separate cookie jar, even for servers on the same host at different ports. A server switch leaves the old backend running. An unavailable server shows an error and keeps the old tabs available.
Selecting the outgoing server returns to its retained terminal state.

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
| `Ctrl-] x` / `u` | close the active terminal / Undo within 3 seconds |
| `Ctrl-] d` | toggle diff panel |
| `Ctrl-] h` | recording browser: `[` earlier page, `]` later page, `x` text/hex |
| `Ctrl-] p` / `w` / `c` | project / worktree / coder dialogs |
| `Ctrl-] n` | New Session |
| `Ctrl-] o` / `S` | OpenCode Mini / Shell session |
| `Ctrl-] a` / `m` / `r` | add / rename / reload servers |
| `Ctrl-] y` | request a copy from the focused diff or terminal |
| `Ctrl-] D` | detach the selected tab without DELETE |
| `Ctrl-] ?` / `q` | help / quit |

Tab cycles chrome regions; Esc returns to the terminal. New Session sends exactly one fresh spawn request with an empty resume identity and the captured project, worktree, coder, and widget geometry. A saved-session row sends its exact resume identity, preferring `session_path` when present, without another picker. `--pane` attaches the exact live pane with no project, coder, or session picker.

## Terminal fidelity

- Full key press/repeat/release, paste, and mouse routing. Modified Enter, Ctrl-digit, application-cursor arrows, and Kitty-style disambiguation are encoded by the adapter from the backend's current modes, not guessed by the UI.
- Normal and alternate buffers, RGB and indexed colors, graphemes with explicit width, synchronized output, and cursor state come from copied frames.
- The emulator runs on one owner goroutine per pane. The UI only reads copied frames and enqueues input requests, so no native call leaves the owner.
- The backend receives mouse press, release, motion, and wheel events in widget coordinates when its modes request them.
- Shift-drag selects text instead. The release requests a clipboard copy, but terminal permission can prevent that copy.
- Without backend mouse ownership, the wheel scrolls retained normal-screen history.
- Backend clipboard commands, desktop notifications, and file-backed graphics do not reach the host.

## Sessions, tabs, and lifecycle

- Live panes are listed without being seized. Selecting one attaches through Phi's recording at the current widget geometry; it never spawns or resumes a process.
- Click `[x] close`, or press `Ctrl-] x`, to close the active terminal with a 3-second Undo grace.
- Click `[u] undo`, or press `Ctrl-] u`, to restore the same pane during that grace.
- In tab focus, plain `x` and `u` also work. In terminal focus, plain `x` remains backend input.
- Final close (`X` in tab focus, or a second close of the same tab) sends exactly one DELETE to the captured origin.
- Quitting detaches every pane and sends no DELETE; server policy and pinned panes are unchanged.
- Reconnect keeps the retained core and replays the recording gap. A changed recording epoch rebuilds the emulator instead of merging two terminal states.
- Each pane requests 64 MiB and 10,000 lines of native scrollback. Ghostty prunes pages, so the retained row count can be smaller.
- The recording browser reads contiguous 8 KiB pages without changing the live core. Earlier/later actions reach older retained output.
- Text view strips terminal commands. Hex view exposes exact bytes, including control commands and partial UTF-8 at a page boundary.
- The browser does not claim to reconstruct a screen from an arbitrary recording offset.
- At most 16 panes attach at once. An explicit detach releases a slot and applies the server's normal disconnect grace.
- UI intent (project, worktree, tab order, active tab, diff visibility) is stored in the shared desktop document under the versioned `phicUI` key. It never contains output, cookies, passwords, prompts, or emulator memory.

## Compatibility limits

The native client links for macOS/Linux amd64 and arm64, plus Windows amd64.
The local runtime cohort covers Shell, Pi, Codex, Claude, OpenCode full, and OpenCode Mini on macOS arm64.
Those runs cover unauthenticated startup, repeated client views, detach, and reattach, without model prompts.
Actual Windows Terminal runs remain unverified. Windows arm64 has no native archive or runtime proof.
Many-tab latency and memory-plateau measurements remain open.
Release packaging is not ready: the old CGO-disabled release job must change before publication.

The legacy inline menu/relay client is no longer the entry point. Its code and tests remain temporarily because shared transport helpers and store-interoperability tests still depend on them; deletion is staged after the console contracts finish replacing them.
