---
name: phi-sync-board
description: Read, write, and delete messages on a Phi Sync Board coordinator, pass state/messages between machines or agents on the same tailnet/LAN, and trigger rich UI actions (render interactive action cards, preview files/images, show web links, stage/run terminal buttons, or pop toast notifications) in the Phi web UI. Use when the user asks to "sync", "post to the board", "preview this image/file in Phi", "open a link in Phi", "add buttons to Phi", or mentions the Phi server / sync board.
allowed-tools: Bash, Read
---

# Phi Sync Board

Stateless key/value REST API exposed by a Phi server, used as a shared
coordination board between machines/agents on the same tailnet or LAN.
Every write is an upsert (no need to check existence first).

## Coordinator Address Resolution

Resolve the coordinator URL using the first available source:
1. `$PHI_COORDINATOR` environment variable (if set).
2. The `sync_coordinator` field from `~/.phi/config.json` (or `%USERPROFILE%\.phi\config.json` on Windows).
3. Fallback: `http://127.0.0.1:7070`.

Do not halt or prompt the user for an address — use the configured coordinator or default directly. In the commands below, `$PHI_COORDINATOR` refers to this resolved address.

## API

| Action | Command |
|---|---|
| List all keys | `curl -s "$PHI_COORDINATOR/api/sync/messages"` |
| Get one key | `curl -s "$PHI_COORDINATOR/api/sync/messages/<key>"` |
| Create/update key | `curl -s -X POST "$PHI_COORDINATOR/api/sync/messages" -H "Content-Type: application/json" -d '{"key":"<key>","value":"<value>"}'` |
| Delete key | `curl -s -X DELETE "$PHI_COORDINATOR/api/sync/messages/<key>"` |

## Response shape

Each entry is a JSON object:

```json
{"key":"some_key","value":"some_value","created_at":"2026-07-07T05:41:33.721438439Z","updated_at":"2026-07-07T05:41:33.721438439Z"}
```

- `GET /api/sync/messages` → JSON array of entries (`[]` when empty).
- `GET /api/sync/messages/<key>` → single entry object.
- `POST /api/sync/messages` → upsert, returns the resulting entry.
- `DELETE /api/sync/messages/<key>` → 200 on success, whether or not the key existed.

`value` accepts raw JSON objects, JSON arrays, numbers, or plain strings.
When sending structured JSON (such as the action schema below), you can pass
`"value": { ... }` directly without manual string-escaping. Plain strings are
also fully supported.

## Desktop alerts: PHI_NOTIF (notify) and PHI_ALARM (error)

Any sync message whose **key or value** contains `PHI_NOTIF` or `PHI_ALARM` triggers a desktop-shell alert (the Phi Electron / `?desktop=1` build only — plain browser tabs ignore it).

- `PHI_NOTIF` — **notify** (informational). Use for "done", hand-off, ready-for-review.
- `PHI_ALARM` — **error/alarm** (higher priority, breaks through). Use for failures, blocked, needs-attention. Takes precedence over `PHI_NOTIF` if both are present.

The web client (`web-src/sync.ts:signalDesktopAlert`) scans the refreshed message list; when a marker is found it writes `PHI_NOTIF <key>` or `PHI_ALARM <key>` (truncated to 120 chars) into `document.title` as a transient signal the desktop shell observes via `page-title-updated`. The terminal-activity title updater overwrites it on the next tick, so the marker is transient by design and display-only — never a remote action.

Include the marker in either field; key is conventional so the title shows the context:

```bash
# notify — informational hand-off
curl -s -X POST "$PHI_COORDINATOR/api/sync/messages" -H "Content-Type: application/json" \
  -d '{"key":"my_task PHI_NOTIF","value":"{\"status\":\"done\"}"}'

# error/alarm — failure
curl -s -X POST "$PHI_COORDINATOR/api/sync/messages" -H "Content-Type: application/json" \
  -d '{"key":"build PHI_ALARM","value":"tests failed on linux"}'
```

Shorthand: think `synboard notify` → add `PHI_NOTIF`, `syncboard error` → add `PHI_ALARM`.

## Interactive Action Cards & Agent Control

The Sync Board natively renders structured JSON action payloads as interactive cards in the web UI, complete with instant WebSocket push (`0x0a` frame) so updates appear with zero latency:

```bash
curl -s -X POST "$PHI_COORDINATOR/api/sync/messages" -H "Content-Type: application/json" \
  -d '{
    "key": "feature:auth-mockup PHI_NOTIF",
    "value": {
      "title": "Auth Page Redesign",
      "description": "Generated login UI mockup and started Vite dev server.",
      "preview": "screenshots/login_mockup.png",
      "url": "http://localhost:5173/login",
      "actions": [
        { "label": "Run E2E Tests", "command": "pnpm test:e2e\r", "style": "primary" },
        { "label": "Git Status", "command": "git status\r" }
      ],
      "toast": "Mockup ready for review!",
      "auto_open": true
    }
  }'
```

### Schema Properties

- `title` *(string)*: Card title displayed in bold.
- `description` / `desc` *(string)*: Optional text or markdown explanation.
- `preview` / `image` / `file` *(string)*: Relative path to a file or image in the workspace. Renders a clickable **Preview [filename]** button that opens Phi's preview modal (ViewerJS for images, Plyr for media, PDF viewer, code highlighting).
- `url` / `link` *(string)*: External or local web URL (`http://` or `https://`). Renders a styled clickable chip opening the link in a new browser tab.
- `actions` *(array of objects)*: List of buttons that send inputs to the terminal:
  - `label` *(string)*: Button text.
  - `command` *(string)*: Input string to send (automatically appends `\r` to execute if omitted).
  - `style` *(string, optional)*: `"primary"`, `"success"`, or `"danger"`.
  - `stage` *(boolean, optional)*: If `true`, stages command into the prompt input bar instead of executing immediately.
- `toast` *(string)*: Displays a transient toast notification in the browser UI immediately upon message arrival.
- `auto_open` *(boolean)*: If `true`, automatically opens the file preview modal or web link the instant the message arrives over WebSocket.

## Notes

- The coordinator address is whatever your phi server binds to. On a default
  install phi binds to loopback + LAN (RFC 1918) + Tailscale CGNAT
  (100.64/10); pick whichever address is reachable from the machine running
  `claude` (often a Tailscale IP for cross-machine sync).
- All writes are upserts: POST with an existing key overwrites its value and
  bumps `updated_at`.
- `DELETE` on a nonexistent key is not an error.
- No auth on this API — treat the board as trusted-network-only, don't put
  secrets in it.

## Coordinator Address Reference

- **`~/.phi/config.json`** — `sync_coordinator` field (configured coordinator address).
- **Welcome banner** — printed when `phi` starts.
- **Local default** — `http://127.0.0.1:7070` when running locally.
