# Phi Skills

Agent skills that let an LLM drive Phi features over HTTP.

Included:

- `phi-sync-board` — read/write/delete board messages, pass state between
  machines, and render action cards (done cards, previews, links, git diffs,
  checklists, terminal buttons, toasts) in the Phi web UI.

The board needs no credential and no browser session, so plain `curl` works.
When an access password is set, `/api/` and `/ws/` routes require the
`phi_access_session` cookie, except `/api/auth/status`, `/api/auth/login`, and
`/api/sync/messages*`.

## Install

From the repository root, macOS / Linux:

```sh
./bonus/phi-skills/install.sh            # detected harnesses
./bonus/phi-skills/install.sh --dry-run  # show targets only
```

From the repository root, Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File bonus/phi-skills/install.ps1 -DryRun  # show targets only
powershell -ExecutionPolicy Bypass -File bonus/phi-skills/install.ps1
```

Both scripts copy each skill directory into the skill folder of every harness
they find:

| Harness | Directory |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Pi | `~/.pi/agent/skills/` |
| Codex | `~/.codex/skills/` |
| OpenCode | `~/.config/opencode/skill/` |

`~` is `$HOME` on macOS/Linux and `%USERPROFILE%` on Windows. Missing harnesses
are skipped with a message. Restart the harness after installing so it reloads
the skills.

Manual install, any harness:

```sh
cp -R bonus/phi-skills/phi-sync-board ~/.claude/skills/
```

```powershell
Copy-Item -Recurse bonus/phi-skills/phi-sync-board "$HOME\.claude\skills\"
```

## Coordinator address

Skills resolve the coordinator at use time, in this order:

1. Non-empty `$PHI_COORDINATOR`
2. Non-empty `sync_coordinator` in `~/.phi/config.toml`
3. `http://127.0.0.1:7070` for a local default-port install

An empty coordinator makes the Phi web UI use its current origin. Shell agents
cannot infer that origin; set `PHI_COORDINATOR` when Phi uses a custom port or
runs on another machine.

No editing of `SKILL.md` is needed. Set `PHI_COORDINATOR` for a one-off run, or
set the coordinator in the Phi web UI so every agent on that machine agrees.
