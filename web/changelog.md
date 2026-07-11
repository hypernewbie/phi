# Phi Changelog

All notable changes to phi are documented here. Newest versions first.

## v0.7.13 — 2026-07-10

**Changed**
- **npm install-time security** (npm v12+): added `allowScripts` allowlist to `package.json` so the Go binary download `postinstall` runs automatically on project-scoped installs. Global installs (`npm i -g`) still require `--allow-scripts` or a one-time `npm config set allow-scripts=@hypernewbie/phi-code --location=user`. See `npm/README.md`.
- **OIDC trusted publishing prep** (npm): release workflow now has `id-token: write` permission and runs `npm publish --provenance` (SLSA provenance signed by GitHub OIDC). `NODE_AUTH_TOKEN` still falls back to `secrets.NPM_TOKEN` until npmjs.org trusted publishing is enabled for the package — no behaviour change yet. Migration steps in `npm/README.md`.
- Metadata-only npm package bump; the Go binary on GitHub is identical to 0.7.12.

## v0.7.12 — 2026-07-10

**Fixed**
- **BUG-1 (P0, the user-reported bug)** — Kanban tab switching back to a kanban tab from a terminal in a different workspace clobbered the sidebar workspace/CWD. The kanban tab held a stale snapshot of the workspace from when it was opened; `switchTab` applied it as the new active workspace. Fixed by short-circuiting `switchTab` for `coder === 'kanban'` and `'review'` — they are independent views and never participate in workspace/CWD sync.
- **BUG-2 (P0)** — Kanban tab vanished on page reload because `restoreTabsState` only iterated server-side terminal entries. Now: `openBoard` sets `localStorage.phi_kanban_open=1`, `restoreTabsState` checks it and re-opens kanban via `kanbanManager.openBoard()`, `cleanup()` clears it.
- **BUG-3 (P1)** — Closing the kanban tab left its document-level `ESC` keydown listener, modal overlays, detail panel, and drag state alive — they could fire on other tabs. Added `KanbanManager.cleanup()`; `TabManager.closeTab` calls it (and `reviewManager.cleanup?.()` defensively).
- **BUG-4 (P1)** — If the kanban container was wiped (hot reload, scripted DOM mutation), re-opening the existing tab found it in `tabs.has()` and just switched → empty panel. `openBoard` now checks for an empty container and re-inits before switching.
- **BUG-5 (P2)** — Race where `createTab`'s synchronous `switchTab` fired before the kanban container was populated. The empty-container check from BUG-4 covers this on subsequent opens.

Added 6 jsdom tests in `test-js/kanbanTabInteraction.test.js`.

## v0.7.11 — 2026-07-10

**Fixed**
- **Kanban / Vikunja API alignment** — CREATE task is `PUT /projects/{id}/tasks` (was POST), UPDATE task is `POST /tasks/{id}` (was PUT in the prior commit — that commit had CREATE/UPDATE swapped), MOVE bucket is the dedicated `POST /projects/{p}/views/{v}/buckets/{b}/tasks` with `{task_id}` body. Vendored Vikunja's swagger.json at `web/vendor/vikunja_swagger.json` and locked in the contract with `test-js/vikunjaContract.test.js` so future drift fails the suite instead of silently returning 405.
- **Kanban security + error UX** — `task.description` was rendered raw into `innerHTML` (P0 stored XSS — a Vikunja task with `<script>` in its description would execute in phi's session). Escaped. Also escaped `bucket.title`, `lbl.title`, `idLabel`, project title in select dropdown. `lbl.hex_color` now goes through `safeHexColor` (`/^[0-9a-fA-F]{3,6}$/`) to prevent CSS injection via crafted label colors. Vikunja error envelopes (`{message: "..."}` / `{messages: {field: [...]}}`) are now flattened via `extractVikunjaError`; nginx HTML error pages no longer leak raw HTML to the user (truncated, tag-stripped). Auth: 401 drops the token everywhere (was only in `loadAndRenderBoard`). Save button re-enable moved from `catch` to `finally` so a successful save followed by a throwing re-render can't leave it stuck disabled.

> Note: `v0.7.10` was a parallel-session bump commit with no tag/published version — folded into this entry.

## v0.7.8 — 2026-07-09

**Fixed**
- White-on-white text contrast for buttons in the white theme.
- Completed notifications no longer fire for terminal/shell tabs (only for coder tabs).

**CI**
- Added test workflow running Go (`go test ./...`) and JS (`npm test`) on every push/PR.

## v0.7.7 — 2026-07-09

**Fixed**
- **OSC 52 agent clipboard copy** — phi's handler called `navigator.clipboard.writeText` directly. When phi is served over plain HTTP on a LAN address (common case), `window.isSecureContext` is false and `navigator.clipboard` is undefined, so `writeText` threw synchronously into the OSC-decode `try/catch` — opencode reported "copied" while nothing reached the clipboard. Added `_agentClipboardCopy`: prefers the async Clipboard API only when it genuinely exists in a secure context, falls back to synchronous `execCommand('copy')`, and if all automated attempts fail, shows a toast with a manual "Copy to Clipboard" button that runs inside the click's user-gesture.
- **Config editor submit button** — the `type="submit"` button in the config editor lived in the footer, **outside** the `<form>` it was meant to submit. A submit button outside its form never submits on click, so "Add Command" (and every other config-editor save) did nothing and the promise never resolved. Root-caused by writing a jsdom test that reproduced the failure. Fixed by giving the form a unique id and associating the button via its `form` attribute (also makes Enter-submit reliable). Exported `App` so the flow is testable.

## v0.7.6 — 2026-07-09

**Added**
- **Ctrl+P capture** — the browser's print dialog was hijacking Ctrl+P except when the staged-input box was empty. Added a document-level capture in `handleGlobalTabShortcuts` that forwards Ctrl+P as `\x10` to the active live terminal (opencode, pi, claude, bash — anyone who wants it) and `preventDefault`s so print never fires. Runs at bubble phase and bails on `e.defaultPrevented`, so it never double-sends with the existing handlers. Skips review/kanban and `ws`-less tabs; ignores Ctrl+Shift+P / Meta+P / Alt+P.

## v0.7.5 — 2026-07-09

**Added**
- **Vitest test suite** for the frontend JS — completely separate from the Go test suite, in `test-js/`. 14 baseline tests covering `normalizePath` (sessions.js), `normalizeCwd` (diff.js). Includes a `node --check` syntax guard over all `web/*.js` files (which would have caught a shipped SyntaxError — see v0.7.4 fixes).

**Changed**
- Phase-A pure-helper extraction into `web/util.js`:
  - `projectWorktreeLabel` (from terminal.js)
  - `relativeToCwd` (from markdown.js — preserved two known quirks: case-sensitive prefix match and naive `startsWith` matches partial segment names)
  - `buildProxyUrl` (sync coordinator URL composer)
  - `getLastFolderName` / `formatWorkspaceLabel` (from sessions.js)
  - `cpuLevel` (CPU % → indicator class mapping, from terminal.js)

## v0.7.4 — 2026-07-08

**Fixed**
- **Critical SyntaxError in `terminal.js`** — `renderPresets` declared `const activeTab` twice in the same method scope (introduced in 246e0ba when the models trigger button was greyed out for agy). A duplicate lexical `const` is a `SyntaxError` that prevented `terminal.js` from loading in the browser. Reused the existing `activeTab` variable (its value didn't change between the two points). Surfaced when wiring `node --check` into the JS test workflow; the earlier per-file `node --check` runs were false positives (bash `/tmp` vs node `/tmp` path mismatch meant node never actually read the files).
- **Tab switching project context sync bug + race conditions** (`d862975`) — switching tabs now uses normalized path comparisons (`normalizePath`) so `/foo` and `c:\Foo` match correctly across platforms.
- **Worktree highlight path comparison** (`bcb3ee5`) — same root cause as the tab-switch bug: `highlightActiveWorktree` now compares normalized paths, and passes the section's own `data-worktree-path` (not the incoming `cwdPath`) into `loadWorktreeSessions`.
- Backend config race: split handlers into per-domain files (`api_config.go`, `api_git.go`, `api_kanban.go`, `api_markdown.go`, `api_notifications.go`), renamed `AgyMeta` → `SessionMeta`, added `sync.RWMutex` around `loadConfig`/`saveConfig`. Added `TestConfigConcurrentAccess` stress test (50 goroutines × 100 ops).

## v0.7.3 — _internal / unpublished_

This version was committed but never tagged or published to npm. Included in the changelog for historical reference: the backend refactor, config race fix, `AgyMeta` → `SessionMeta` rename, and the tab-switching / worktree-highlight fixes all landed in this version.

## v0.7.2 — 2026-07-07

**Added**
- Colored welcome banner and status dump on startup, using the active theme color.
- Meaningful Claude session names: active labels, `aiTitle`, and URL-safe slugs.
- Windows VT console processing for ANSI escapes and colors (so the colored welcome banner and other ANSI output render correctly when running phi.exe from a plain Windows terminal).

**Changed**
- Model presets dropup desktop width increased to 320px; bounds clamped to avoid overflow on narrow viewports.
- Models trigger button greyed out and disabled when the active coder is agy (Antigravity), which doesn't support model selection.

**Fixed**
- Welcome banner: added missing theme colors (cyan, rose, lime, white, gold).
- Welcome banner ASCII art alignment and backslash escaping.

## v0.7.1 — 2026-07-07

**Changed**
- Help guide updated with the new AI Sync Board details and an LLM custom skill prompt.

**Fixed**
- Loaded config data now stored in `sessionsManager` for cross-controller access — previously, other controllers (`diffController`, `markdownManager`, `syncManager`, etc.) each fetched `/api/config` independently, which led to race conditions and stale reads. Now `sessionsManager.loadConfig()` is the single source of truth and other controllers read from `this.app.sessionsManager.config`.

## v0.7.0 — 2026-07-07

**Added**
- **AI Sync Board** — a separate panel in the diff/cmd/md/sync tabs for sharing AI session messages across worktrees/hosts. Uses a coordinator server (default `http://localhost:7070`, configurable via `sync_coordinator`). Premium CPU-state animations on the brand logo (`cpu-idle` / `cpu-moderate` / `cpu-high` / `cpu-critical` thresholds: 30 / 70 / 90).
- Consistent SVG icons for the quick commands dropup (replacing mixed emoji + text buttons).

**Changed**
- Files tab feature removed (reverted). It caused noticeable performance lag with large workspaces; reverted in `101a426` with a "surgically complete" removal.

**Fixed**
- File selection handler now uses the library's node object instead of the DOM event (which was wrong after SortableJS normalized the event).
- Empty-state hostname updates dynamically after config loads (was hardcoded at page boot).

## v0.6.5 — 2026-07-06

**Added**
- **File Browser sidebar panel with Vim integration** — sidebar-mounted tree view of the active workspace, with `:edit <path>` integration that opens the file in the user's configured editor.
- Monochromatic SVG icons replacing emojis and text action buttons across the UI, plus styled SVG pushpins for the tab bar.
- Hostname display on the home screen with subtle CSS animations.

**Changed**
- Auto-reconnect on Vikunja session expiration in the kanban panel.

## v0.6.4 — 2026-07-05

**Changed**
- Kanban description editor: text buttons replaced with pencil/eye SVG icons for edit/preview toggle.
- Terminal tabs now show a detailed tooltip with session name, project, and path on hover.
- Coder launch button in the empty state now switches the coder context before spawning a session (previously it spawned the session first, which led to a confusing flash of the wrong coder).

**Fixed**
- Header z-index layering — some dropdowns were appearing behind the tab bar.

## v0.6.3 — 2026-07-04

**Added**
- **In-app help guide** — a `?` button in the sidebar footer opens a modal with the user guide rendered as Markdown (`help.md`).
- Polished command and model editors with **split config APIs** — quick commands and terminal commands are now managed through separate endpoints (`/api/config/quick-commands` vs `/api/config/terminal-commands`), and model presets have their own endpoint (`/api/config/model-presets`). Previously all three shared one endpoint which made exports brittle.
- Rich HTML kanban descriptions with a raw-HTML toggle.
- **Simplepush** zero-signup iOS push notifications.
- **Custom Webhook / Bark** zero-signup push notifications.
- **Pushover** push notifications (replaces ntfy.sh as the primary push service).
- Enhanced notification payload with theme color emoji, project name, hostname, and execution duration.

**Changed**
- Markdown panel auto-refreshes on tab/workspace context changes (previously required manual refresh).
- Terminal theme restored to standard ANSI colors (was a custom palette that confused muscle memory).

**Fixed**
- Kanban saved-password autologin.
- Favicon initial color flash on page load (was rendering with the default theme color before the user's saved theme loaded).
- ntfy.sh `Priority: high` header for iOS/Android system push alerts.
- Build: `loadConfig`/`saveConfig` signatures and missing imports.

## v0.6.0 — 2026-07-02

**Added**
- **Kanban board** — full Vikunja-backed kanban in its own tab type, with inline task creation, fuzzy text search, and obsidian-glassmorphism styling.
- **Encrypted password vault** for Vikunja login — phi encrypts the Vikunja password with an AES key derived from a session secret and stores the ciphertext server-side; on reload, phi auto-decrypts and auto-logs-in. Backed by a `/api/config/kanban-vault` endpoint.
- **Empty state welcome landing page** with quick-launch coder buttons (opencode / claude / pi / bash / agy).
- **ntfy.sh push notifications** with a UI configuration modal (login URL, topic, priority).
- **Server-side idle detection watcher** for PTY — phi monitors how long each PTY has been idle and can trigger notifications.
- Four new accent colors: **White**, **Violet**, **Emerald**, **Gold**.
- Recalibrated saturation profiles for gold, emerald, violet, neon, coral, fuchsia themes.
- **Vim** and **Neovim** themes matching phi color schemes.
- **btop** themes matching phi color schemes.

**Changed**
- UI precision obsidian glassmorphism and accent glow beauty pass — every panel re-skinned for the new aesthetic.
- Theme dropdown simplified to single-word labels.
- Updated opencode background to rich obsidian dark.

**Fixed**
- Inject dummy `DISPLAY` on headless Linux to enable clipboard shims (xclip, etc. require a `$DISPLAY` even if headless).
- Exclude `btop` tabs from reusable shell command routing — btop is interactive full-screen TUI, not a shell, and reusing it for quick commands broke both.
- Convert vim themes to Unix LF line endings (they were checked in with CRLF and looked broken on Linux).

## v0.5.6 — 2026-06-30

**Fixed**
- Refresh race condition in agy (Antigravity) presets — two concurrent `/api/config` loads could stomp each other.

---

_Missing from the registry: 0.5.7, 0.5.8, 0.5.9, 0.6.1, 0.6.2, 0.6.6 — these were manually bumped in the source tree without a corresponding version-bump commit; never tagged or published to npm._