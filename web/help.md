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

## Terminal Tabs

Tabs are the active working surface.

- Click a tab to switch to it.
- Use `Alt+1` through `Alt+8` to switch to a numbered tab.
- Use `Alt+9` to switch to the last tab.
- Phi stores open tab state in browser storage and attempts to restore tabs on reload.
- Switching tabs updates the active workspace/CWD context for Git and Markdown panels.

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

## Security Notes

Phi is a local developer tool.

- It binds to `0.0.0.0` by default.
- It has no built-in authentication.
- Run it only on trusted networks, behind a tunnel, or behind your own auth layer.
- It can spawn shells and coder CLIs on the host machine.
- Saved Kanban passwords are encrypted in the backend config, but anyone with host-level access to your Phi config and key material should be treated as trusted.

## Files And State

Typical state lives under your Phi config directory and browser local/session storage.

Important state includes:

- registered workspaces
- theme color
- model presets
- quick commands
- terminal commands
- Markdown directories
- notification settings
- Kanban vault data
- active browser tab restoration data

Use full config export for backup before making major changes.
