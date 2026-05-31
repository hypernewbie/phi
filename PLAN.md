# Φ phi (Phi) — Master Implementation Plan & Architecture

Phi is a terminal multiplexer and browser-based control center specifically built for AI coding assistants (such as **OpenCode**, **Claude Code**, and **Antigravity / Agy**).

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Φ phi                                                    [workspace: ~/code] │
├────────────┬────────────────────────────────────────┬───────────────────────┤
│  SESSIONS  │  [tab: opencode #1] [tab: opencode #2] │  GIT DIFF             │
│            ├────────────────────────────────────────┤                       │
│ opencode   │                                        │  @@  -12,7 +12,9 @@   │
│ ● sess 1   │   xterm.js PTY terminal                │  -  old line          │
│   sess 2   │   (running opencode TUI)               │  +  new line          │
│   sess 3   │                                        │  +  new line          │
│            │                                        │                       │
│ ────────── │                                        │  [↻ refresh]          │
│ + New      │                                        │  [git log]            │
│            ├────────────────────────────────────────┤                       │
│            │ [input bar .............. ] [send ↵]   │                       │
│            │ [/exit] [/context] [y] [ctrl+c] [esc]  │                       │
└────────────┴────────────────────────────────────────┴───────────────────────┘
```

### 1.1 Project Directory Structure

```
phi/
├── main.go                    HTTP server entrypoint, routing, flag parsing
├── go.mod
├── pkg/
│   ├── pty/
│   │   ├── manager.go         PTY registry, process lifecycle, 30-min detach timer
│   │   └── pty.go             PTY process wrapper (os.StartProcess + creack/pty)
│   ├── session/
│   │   ├── session.go         Unified Session models
│   │   ├── opencode.go        Reads ~/.local/share/opencode/opencode.db (SQLite)
│   │   ├── claude.go          Reads ~/.claude/projects/ directory list + summaries
│   │   └── agy.go             Reads ~/.gemini/antigravity-cli/conversations/ + sidecar sessions.json
│   ├── ws/
│   │   ├── hub.go             WebSocket Hub for panel communication
│   │   └── bridge.go          Multiplexes/pipes bidirectional I/O between PTY and WS
│   ├── diff/
│   │   └── diff.go            Runs non-interactive `git diff` streams
│   └── coders/
│       └── coders.go          Definitions & presets for OpenCode, Claude Code, Agy
└── web/
    ├── index.html             Vanilla HTML layout
    ├── style.css              Dark void theme & CSS grids
    ├── app.js                 Core application orchestrator & panel drag-resizers
    ├── terminal.js            xterm.js Tab/Terminal Manager
    ├── sessions.js            Session explorer interaction & Renamer API
    ├── diff.js                Git Diff controller & Git Log pane
    ├── ws.js                  Binary WebSocket client protocol handler
    └── vendor/                Downloaded xterm.js & Addons (fit, webgl)
```

---

## 2. Core Decisions & Rules (Locked)

1. **Input Focus (Hybrid Mode)**:
   - xterm.js gets direct focus by default. Direct typing is sent byte-by-byte to PTY.
   - Click terminal area -> focus terminal (native direct mode).
   - Click input bar -> focus text area (staged mode).
   - Preset buttons (like `/exit`, `ctrl+c`, `y↵`) fire immediately directly to PTY stdin. No ESC key hotkey (too risky).

2. **WebSocket Protocol (Binary Type Prefix)**:
   - Client -> Server frames:
     - `0x01` + Raw UTF-8 bytes: Input data (piped to PTY stdin)
     - `0x02` + Resize JSON/binary: `{cols: uint16, rows: uint16}` (5 bytes total, big-endian)
     - `0x03` + Raw bytes: Ping
   - Server -> Client frames:
     - `0x01` + Raw bytes: PTY output data (piped directly to xterm.js)
     - `0x02` + Control JSON: metadata, errors, session updates
     - `0x03` + Raw bytes: Pong

3. **PTY Detachment & Lifecycle**:
   - Tab closed in browser -> WS drops -> PTY detaches.
   - Detached PTY is preserved in backend memory.
   - Spawns a **30-minute grace timer** on detach. If no WebSocket reconnects to this pane ID before the timer fires, the PTY is killed (`process.Kill()`).
   - If user opens the session again from the list, it attaches to the existing running PTY instead of creating a new one.

4. **Diff Panel**:
   - Non-interactive read-only xterm.js terminal running `git diff --color=always -w`.
   - **Manual refresh only** (clicked by user).
   - Toggleable panel (state persisted in localStorage).
   - Secondary sub-tab shows `git log --oneline -10 --color=always`.

5. **Session Parsing Methods**:
   - **OpenCode**: Query SQLite `~/.local/share/opencode/opencode.db` using `modernc.org/sqlite` (pure Go). Group by project, filter by current CWD worktree matching.
   - **Claude Code**: Scan `~/.claude/projects/`. Decode directory name. Parse UUID JSONL files, look for `{"type":"summary"}` lines.
   - **Agy**: Scan binary `*.pb` files in `~/.gemini/antigravity-cli/conversations/`. Since files are encrypted/binary, keep local map `~/.phi/sessions.json` for custom names and timestamps. Fallback to `"Gemini session <uuid-short> <date>"`.

6. **No-Slop Rendering Checklist**:
   - Debounced `ResizeObserver` on terminal container.
   - Container has `overflow: hidden`, no padding.
   - WebGL renderer with immediate Canvas fallback.
   - On reconnect, send `SIGWINCH` or trigger TUI repaint.

---

## 3. Step-by-Step Implementation Sequence

1. **Setup Dependencies**: Install pure Go SQLite driver (`modernc.org/sqlite`).
2. **Coder Structs & Presets (`pkg/coders`)**: Define commands, args, and button panels.
3. **PTY Manager (`pkg/pty`)**: Build process spawner, registry, and 30-min detach timer.
4. **Session Parsers (`pkg/session`)**: Write direct read routines for OpenCode, Claude Code, and Agy configurations.
5. **WebSocket & Hub (`pkg/ws`)**: Code binary multiplexing protocol and backpressure handling.
6. **Git Diff Streamer (`pkg/diff`)**: Execute command and stream diff to browser client.
7. **Go Main (`main.go`)**: Create API routes (`/api/sessions`, `/api/terminals`, etc.) and static file server.
8. **Static Vendor Assets (`web/vendor`)**: Fetch local xterm.js assets.
9. **UI & Drag Layout (`web/style.css`, `web/index.html`)**: Construct three-panel grid system with resizable splitters.
10. **JS Engine (`web/*.js`)**: Wire up tabs, renamer, binary websocket client, fit addon, and diff refreshes.

Let's build!
