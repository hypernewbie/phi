# Phi User Guide

Phi is a browser-based control center for AI coding sessions. It runs a local Go server, serves a vanilla JavaScript UI, and connects browser terminals to real PTYs through WebSockets.

Use this guide as the in-app reference for everyday operation.

## Quick Start

1. Start Phi from the project directory you want as the initial workspace.

```bash
phi
```

2. Open the URL printed by the server. The default is:

```text
http://localhost:7070
```

3. Pick a coder from the left sidebar and click `New Session`.

4. Use the terminal input bar at the bottom to send prompts, shell commands, shortcuts, model switches, and quick commands.

## Layout

Phi has three main areas:

- Left sidebar: coder selector, session list, workspace/worktree context, and the help button.
- Center panel: terminal tabs, PTY output, staged input, model presets, quick commands, and direct controls.
- Right panel: Git diff/log/status, Markdown docs, and reusable terminal commands.

You can resize the left and right panels with the vertical handles.

## Workspaces

The workspace picker in the header controls which project Phi is looking at.

- The directory where Phi starts becomes the default workspace.
- Use `+` next to the workspace picker to add another workspace path.
- Use `-` to remove the selected workspace from the picker.
- Workspace choices affect session discovery, Git worktrees, Markdown scanning, and default new-session directories.
- Phi remembers your last selected workspace in local browser storage.

If a workspace contains Git worktrees, Phi shows them in the session/worktree area and tracks dirty states.

## Coder Sessions

Supported session types:

- OpenCode
- Claude Code
- Antigravity / Agy
- Pi Coder
- Shell / Bash
- Kanban board tab
- Review tabs for transcript inspection

Basic flow:

1. Select the coder in the left sidebar.
2. Choose an existing session if one is listed, or click `New Session`.
3. Phi creates a tab in the center terminal area.
4. Closing the browser does not immediately kill the PTY. Existing PTYs can be reattached while they are still alive.

Session controls:

- Pin: keep important sessions alive and visible.
- Mark: visually highlight a session you want to track.
- Rename: give a session a clearer title.
- Delete/close: remove or close sessions from the UI.
- Reconnect: attach the browser tab back to an existing PTY.
- Restart: respawn a dead session when reconnect is not enough.

> **Note:** Claude Code defaults to fullscreen TUI mode. Use `/tui` in the session to switch to inline (non-fullscreen) so it stays scrollable inside phi's terminal.

## Terminal Tabs

Tabs are the active working surface.

- Click a tab to switch to it.
- Use `Alt+1` through `Alt+8` to switch to a numbered tab.
- Use `Alt+9` to switch to the last tab.
- Phi stores open tab state in browser storage and attempts to restore tabs on reload.
- Switching tabs updates the active workspace/CWD context for Git and Markdown panels.

### Reconnect And Replay

When a WebSocket drops (WiFi hiccup, browser crash, laptop lid), the tab goes dead but the underlying PTY survives for a 30-minute grace period. Reconnecting replays the server-side ring buffer (1 MiB default) so you see what the agent did while you were gone.

Dead tabs show distinct messages:

- **Connection lost** — WebSocket dropped, PTY is still alive. Reconnect to reattach.
- **Session expired (PTY gone)** — PTY was killed by the grace timer. Restart to respawn.
- **Process exited (code N)** — the agent exited on its own. Restart to respawn.

Clicking a dead tab (or using Alt+1–9) always attempts to reconnect it, even with auto-reconnect off. A disconnect banner at the top of the terminal area shows how many tabs are dead and offers a Reconnect all button.

### Auto-Reconnect

Automatic reconnection is **on by default** (`auto_reconnect: "visible"`) and can be toggled in **Config → Behavior → "Auto-reconnect disconnected terminals (active tab)"**. It only ever redials the active pane of a visible window — returning to the page (laptop wake, phone unlock), a network restore, and a bfcache restore all trigger an immediate redial, and a passive retry loop covers drops that happen while you're watching: exponential backoff with full jitter, delays capped at 20s, up to 10 attempts. Background windows and background tabs never dial (that would create reconnect storms in many-window workflows); they revive when you switch to them. Turning the toggle off restores fully manual reconnection.

### Terminal Search

`Ctrl+Shift+F` opens a find bar in the active terminal. Incremental search with next/prev navigation and match highlighting.

### Find In Terminal Output

Terminal scrollback is set to 10000 lines so the replay buffer is not truncated client-side.

## Input Bar

The bottom input bar is a staged input area.

- Type a prompt or command and press `Enter` to send it.
- Use multi-line text for longer prompts.
- If the input is empty, navigation/control keys are passed directly to the PTY where appropriate.
- The cancel button sends the interrupt/cancel action to the active terminal.
- The `Ctrl+T` button appears for backends where that shortcut is useful.
- `Ctrl+Shift+Enter` recalls the previous shell command and executes it.

For long or multi-line pasted input, Phi uses bracketed paste where appropriate so terminal apps receive the content safely.

## Preset Buttons

The preset strip above the input bar exposes common backend-specific actions.

Examples include:

- slash commands
- escape
- yes/confirm
- model switch shortcuts
- utility control sequences

On mobile, Phi groups slash commands and utility buttons to keep the strip usable on small screens.

## Quick Commands

Quick Commands are reusable snippets sent to the active terminal.

Open them with the `Cmds` button in the preset strip.

What you can do:

- Click a command to send it.
- Add a command.
- Edit a command with the compact editor modal.
- Delete a command.
- Copy command config to the clipboard.
- Paste command config from the clipboard.

Placeholder behavior:

```text
{}
```

If a quick command contains `{}`, Phi replaces it with the current staged input text. If there is staged input and the command does not contain `{}`, Phi prefixes the command with the staged input.

Command config copy/paste uses the `PHICMDS:` prefix. It is separate from model presets and full page config.

## Model Presets

Model presets are saved per coder backend.

Open them with the `Models` button in the preset strip.

What you can do:

- Click a model to send the appropriate model switch command for the active backend.
- Add a model identifier.
- Edit an existing model identifier.
- Delete a model identifier.
- Copy model config to the clipboard.
- Paste model config from the clipboard.

Model config copy/paste uses the `PHIMODELS:` prefix. It does not overwrite command config.

## Config Copy And Paste

Phi has three config scopes:

- Full config: header config pill, prefix `PHICONFIG:`.
- Models only: model preset menu, prefix `PHIMODELS:`.
- Commands only: command menus, prefix `PHICMDS:`.

Use full config for backup/restore of the whole app state. Use models or commands when sharing only those presets between machines.

## Right Panel: Git

The right panel has these tabs:

- `diff`: live Git diff for the active workspace/CWD.
- `log`: recent Git history.
- `status`: short Git status.
- `md`: Markdown file browser and renderer.
- `cmd`: reusable terminal command launcher.

The refresh button reloads the active right-panel view.

Rich diff:

- Open the rich diff modal from the diff controls.
- Toggle side-by-side layout.
- Toggle extended context lines.
- Copy or inspect large diffs without leaving Phi.

## Right Panel: Markdown

The `md` tab scans configured Markdown directories relative to the active workspace/CWD.

Defaults include:

- `.`
- `./temp`
- `./tmp`

Markdown features:

- Click a file to render it in the Markdown modal.
- Use `Copy Markdown` to copy raw Markdown.
- Add a Markdown directory.
- Remove a Markdown directory.
- Use file actions for copy, paste, delete, and worktree-oriented operations where available.
- When switching terminal tabs, the Markdown panel refreshes for the new active tab context.

The help page you are reading uses the same Markdown renderer.

## Right Panel: Commands

The `cmd` tab is for terminal commands you run often.

What you can do:

- Add a terminal command.
- Run a command.
- Edit a command.
- Delete a command.
- Copy a single command JSON.
- Copy or paste the full command config with `PHICMDS:`.

There is also a `Reuse existing terminal tab` toggle:

- Off: commands open a new shell tab.
- On: commands route to an existing live shell tab when possible.

## Kanban Board

Phi can open a Vikunja Kanban board as a custom tab.

Open it with the Kanban button in the header.

Login:

- Enter the Vikunja server URL.
- Enter username and password.
- Enable `Remember Password` if you want Phi to store the password in the backend config vault.

Autologin:

- If a password is saved and the URL/username are cached, Phi attempts login automatically before showing the login form.
- If saved login fails, Phi falls back to the login form and shows the failure.

Board usage:

- Select a project.
- Phi detects the Kanban view for the project.
- Tasks are loaded by bucket.
- Drag tasks between buckets.
- Open task details to inspect and edit task data.
- HTML task descriptions render in view mode.
- Use edit mode when you need to modify raw description HTML.

## Push Notifications

Open push notification settings from the header bell button.

Supported options:

- Simplepush: clean zero-signup push notifications using a short key from the Simplepush app.
- Custom webhook: POST notification payloads to your own endpoint.
- Pushover: use a Pushover user key and app token.

When enabled, Phi sends notifications for idle/completed long-running sessions. Notification payloads include useful context such as coder, project, host, session title, and duration.

## Remote Clipboard

Use the clipboard button in the header to sync the active session clipboard back to your local browser clipboard.

Notes:

- Phi reads from the active pane when possible.
- Empty remote clipboards are reported as empty instead of clearing your local clipboard silently.
- Browser clipboard permissions may require a secure context or explicit user action.

## Themes And Favicon

Use the theme/accent picker to change Phi's highlight color.

The chosen accent affects:

- buttons
- glows
- selected tab highlights
- UI focus rings
- the generated favicon

Phi caches the chosen color locally so the favicon can render with the correct color on first paint.

## Mobile Use

Phi includes mobile-specific behavior:

- Sidebar becomes a drawer.
- Terminal and modal layouts adapt to bottom-sheet patterns.
- Preset controls are grouped to avoid horizontal overflow.
- Dropup menus are constrained to the viewport.
- Action buttons use larger touch targets on narrow screens.

For serious multi-session work, desktop is still the primary target, but mobile is usable for monitoring, simple commands, and quick interventions.

## Keyboard Shortcuts

Common shortcuts:

| Shortcut | Action |
| --- | --- |
| `Alt+1` to `Alt+8` | Switch to tab 1 through 8 |
| `Alt+9` | Switch to last tab |
| `Ctrl+Shift+Enter` | Recall previous shell command and execute it |
| `Ctrl+Shift+F` | Find in terminal output |
| `Ctrl+Shift+D` | Open diagnostics panel |
| `Escape` | Close modals/dropups where supported |
| Empty input + arrows | Send navigation keys to the active PTY |
| Empty input + `Ctrl+C` | Send interrupt/control key to the active PTY |

Backend-specific preset buttons may expose additional shortcuts.

## Troubleshooting

No sessions listed:

- Confirm the selected coder CLI is installed.
- Confirm the selected workspace is the project where that coder stores sessions.
- Try refreshing the browser.

Terminal colors look wrong:

- Phi supports truecolor output.
- Standard 16-color ANSI values are intentionally kept close to terminal defaults.
- Apps like Vim, Neovim, and tmux may need their own truecolor settings.

Kanban cannot connect:

- Verify the Vikunja URL from the Phi host, not from your phone/browser context.
- Check username/password.
- Clear remembered password by unchecking `Remember Password` and reconnecting.

Config paste fails:

- Check the prefix. Full config starts with `PHICONFIG:`, model config with `PHIMODELS:`, and command config with `PHICMDS:`.
- Make sure the clipboard contains the complete generated string.

Markdown files missing:

- Confirm the active tab is in the workspace/CWD you expect.
- Add the directory in the `md` panel.
- Switch tabs or use refresh to rescan.

Notifications not arriving:

- Confirm the provider is enabled.
- Use the provider test button.
- Check keys/tokens.
- Confirm the device/app allows notifications.

## Fleet Strip

If you run phi on multiple machines, add peer servers to your config:

```json
{
  "peers": [
    {"name": "zen", "url": "http://zen:7777"},
    {"name": "hora", "url": "http://hora:7070"}
  ]
}
```

Phi polls each peer's `/api/terminals` and `/api/version` endpoints every 15 seconds (3s timeout, marked stale after 2 consecutive misses). The sidebar footer shows a compact row per peer: name, tab count, busy/idle split, quiet duration, and version. Click a peer row to open its UI in a new browser tab.

This is presence-only — no remote control. The peer side needs zero changes; phi just reads the existing terminal-list API.

## Self-Update

When running a release binary (installed via npm or downloaded from GitHub releases), phi checks for new versions on startup and hourly thereafter. The sidebar version badge indicates when an update is available; click it to open the changelog modal which shows the latest version and install instructions.

- **npm installs**: click Apply to download and stage the new binary. It takes effect on the next restart (run `npm update -g @hypernewbie/phi-code` to converge the npm package metadata afterward).
- **standalone installs**: Apply stages the binary; "Apply & restart now" chains the swap into a graceful restart.
- **go-install**: no one-click update — run `go install github.com/hypernewbie/phi@latest`.
- **dev builds**: update checks are disabled.

The download is verified against goreleaser's `checksums.txt` (SHA-256, fail-closed). The old binary is preserved as `phi.old` for 10 minutes after boot.

### Rollback

If a self-update goes bad:

```bash
phi --rollback
```

This swaps the previous binary (`.old`) back into place. The bad binary is preserved as `.rejected`. Then restart phi normally.

Disable update checks in config:

```json
{"update_check": false}
```

## Diagnostics

`Ctrl+Shift+D` opens a diagnostics modal showing:

- phi version and install method
- uptime, goroutine count, memory allocation
- PTY count and per-pane stats (client count, ring buffer fill, busy state, last activity)

The same data is available via `GET /api/diag`.

## Security Notes

Phi is a local developer tool.

- It binds to `0.0.0.0` by default.
- It has no built-in authentication.
- Run it only on trusted networks, behind a tunnel, or behind your own auth layer.
- It can spawn shells and coder CLIs on the host machine.
- Saved Kanban passwords are encrypted in the backend config, but anyone with host-level access to your Phi config and key material should be treated as trusted.
- The self-update endpoint (`POST /api/update/apply`) can replace the phi binary on disk. On an unauthenticated `0.0.0.0` bind, anyone on the network can trigger an update. This motivates adding an auth token in a future release. For now, run phi on trusted networks only.
- The diagnostics endpoint (`GET /api/diag`) exposes runtime internals (goroutine count, memory, PTY state) without authentication. Same trusted-network caveat applies.
- The restart endpoint (`POST /api/restart`) can restart the phi process. Same trusted-network caveat applies.

## Files And State

Typical state lives under your Phi config directory and browser local/session storage.

Phi's config directory is `~/.phi/` (or `%USERPROFILE%\.phi\` on Windows). Important state includes:

- `tabs.json` — live tab tuples (coder, session_id, cwd, title) for post-restart restore. Written atomically (temp + rename), debounced 500ms.
- `syncboard.json` — AI Sync Board messages. Same atomic-write pattern.
- `phi_update.json` — update-check cache (last-checked timestamp, latest known version).
- `config.json` — main config (workspaces, themes, presets, peers, notification settings, Kanban vault). Written atomically.
- `phi.old` — previous binary after a self-update (retained 10 minutes).
- `phi.rejected` — bad binary after a rollback (preserved, not auto-deleted).

Browser local storage includes:

- registered workspaces
- theme color
- model presets
- quick commands
- terminal commands
- Markdown directories
- notification settings
- Kanban vault data
- active browser tab restoration data

- Use full config export for backup before making major changes.

## AI Sync Board

The `sync` tab exposes a dead-simple, in-memory CRUD message store. It is designed specifically to allow different AI agents (e.g., Claude Code, Agy, OpenCode) running on different workspaces or machines to coordinate and communicate with each other asynchronously.

### How It Works

Every Phi server has a local sync board. By setting a **Coordinator** URL in the sync tab, you point your UI and API proxy to a central Phi server's board.

The board can be manipulated by any tool or script via plain HTTP REST requests:

- **List all keys**: `GET /api/sync/messages`
- **Get specific key**: `GET /api/sync/messages/{key}`
- **Create/Upsert key**: `POST /api/sync/messages` with JSON body `{"key": "some_key", "value": "some_value"}`
- **Delete key**: `DELETE /api/sync/messages/{key}`

Because all writes (`POST`) act as upserts, AI agents can post updates atomically without needing to verify key existence beforehand.

### Creating a Custom Claude Skill

If you use Claude Code (the CLI) or Claude Desktop, you can teach it to coordinate automatically using the Sync Board by giving it a global skill. 

#### The Prompt to Give to Claude:
Paste the following prompt into Claude to have it create the sync tool on your system:

```text
Please create a global skill/tool for me that allows you to read, write, and delete messages on my local Phi server's Sync Board (running at http://localhost:7070). 
- To list keys: curl -s http://localhost:7070/api/sync/messages
- To read a key: curl -s http://localhost:7070/api/sync/messages/<key>
- To write/update a key: curl -s -X POST http://localhost:7070/api/sync/messages -H "Content-Type: application/json" -d '{"key":"<key>", "value":"<value>"}'
- To delete a key: curl -s -X DELETE http://localhost:7070/api/sync/messages/<key>

Explain where you are saving the tool/alias/script (e.g., in ~/.claude/skills/ or as a global CLI script/bash function) so I can use it across any project.
```
