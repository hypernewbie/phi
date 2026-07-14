# Phi Changelog

All notable changes to phi are documented here. Newest versions first.

## v0.9.1 — 2026-07-14

Polished theme details for the obsidian glassmorphic and Greek-Egyptian visual style.

### Added
- **Focus breathing on input textarea.** Focus glows now pulse gently with a 4s ease-in-out breathing animation, mimicking organic torchlight rather than static digital borders.
- **Active tab inner top light.** Added a subtle radial accent glow to the inside top edge of active tabs, giving them a polished light-catching feel.
- **Header button hover beacons.** Hovering over header action buttons casts a soft radial glow underneath, adding visual depth.
- **Active coder tab accent sliver.** The active coder tab now has a thin accent-colored bottom border to unify it with the main terminal tabs.
- **Session list active indicators.** The active session dot is now the Egyptian Ankh (`☥`), U+2625, indicating "running/active" status. Active session items also receive a deeper inset highlight.
- **Heat-shimmer empty state.** The scattered hieroglyphs on the empty state wall drift slowly with staggered animation timings, creating a desert mirage heat-shimmer effect.
- **Chromatic Φ logo.** The empty state hero logo now splits slightly into subtle cyan/rose chromatic drop-shadows at the peak of its breathing cycle.

## v0.9.0 — 2026-07-14

Egyptian theming across empty state landing page, worktree sidebar panels, and close countdowns.

### Added
- **Empty-state decoration.** Landing page features 15 hieroglyphs scattered with irregular scaling, rotation, and staggered entry, backed by a warm radial torchlight flicker.
- **Worktree-header hover card.** Hovering left-panel worktree section headers shows compact hieroglyph preview details.
- **Countdown theming.** Close grace countdown center spinner replaced with active worktree hieroglyphs alongside an animated ellipsis wave.

## v0.8.4 — 2026-07-13


UX-densification release. Two affordances for "scan lots of tabs fast":

### Added

- **Worktree icon on every tab.** Each worktree (cwd) deterministically hashes to one of 12 monochrome glyphs (◆ ◇ ▣ ❖ ⏣ ⏢ ❘ ⌧ ▖ ⏧ ⬡ ⬢) — chosen to be readable at 11px and to avoid already-used shapes (● ◯ ★ etc.). Rendered between the coder favicon and the title, colored in the theme's accent bright with a soft glow so it pops without screaming. Same worktree = same glyph = instant group-by-shape scan without reading any text. Hover tooltip adds `Icon: <glyph>` so users learn the mapping.

- **`+N more` chip at the strip's right edge.** Appears only when tabs overflow horizontally (`scrollWidth > clientWidth`); hidden when everything fits. Click opens a dropdown listing ALL open tabs grouped by worktree glyph (so the icon doubles as a section header inside the menu). Each row has click-to-switch + close. Auto-scrolls to the active tab. The existing `#hostname-tabs-dropdown` in the top header is unchanged — both surfaces share the same mental model, the chip is the discoverable one next to the tabs.

- **Sidebar worktree legend.** One chip per distinct worktree (glyph + label + tab count). Always-visible at the bottom of the left sidebar; built incrementally as tabs are created/closed. Lets you decode the glyph-to-worktree mapping without a legend modal and answers "how many tabs per worktree, right now" at a glance.

- **Edge auto-scroll while dragging.** During a tab drag, when the cursor enters a 48px zone at the left or right edge of the strip, the strip ramps an rAF-driven horizontal scroll. Velocity is proximity-ramped (closer = faster, capped at ~15px/frame) so it's controllable on trackpads. rAF loop self-idles when the cursor moves back to the middle, and is cancelled cleanly on dragend. The strip follows your drag now, so you can drop a tab past the visible end without first scrolling manually.

- **Drop-into-whitespace for the far edge.** When the strip auto-scrolls you past the last tab, there's no tab DOM there for the per-tab drop handler to catch. The container-level `drop` listener fills that gap: drop on whitespace past the right edge → append to end; before the left edge → prepend to start. Without this, auto-scroll gets you there but the drop silently no-ops.

- **Mouse wheel → horizontal scroll on the strip.** Plain-mouse users who couldn't horizontally scroll the strip at all (no trackpad, no horizontal tilt wheel) can now hover the strip and roll the wheel to scrub. Trackpads already worked via `deltaX`; the wheel handler unifies both. Doesn't preventDefault when there's no horizontal overflow, so the page scrolls normally elsewhere.

### Changed

- **Tab tooltip includes the worktree glyph** so users can correlate the tab icon with the worktree label without guessing.

## v0.8.3 — 2026-07-13

Bugfix-only release on top of v0.8.2 — three regressions in the soft-close tab pipeline that were hidden behind the v0.8.2 picker rework.

### Fixed

- **Soft-close tab no longer renders as a "big white XX" (line-through + still-visible ×).** The `.tab.soft-closed .tab-title` rule used `text-decoration: line-through`, which drew a horizontal stroke through the title text. Combined with the × close button — which had inline `style="display:none"` on its sibling `.tab-reopen` so the swap never toggled — the tab looked like an ✗-marked ghost. Now the title just dims to `opacity: 0.7`, the line-through is gone, and the CSS toggle actually hides `.tab-close` while revealing the ↻ reopen button on soft-closed tabs. The strip entry is also slightly more readable (opacity `0.55` instead of `0.45`).

- **Active-tab soft-close no longer auto-switches to a "next" tab.** The `pickNextTab` priority chain from v0.8.2 (same workspace + coder → same workspace → same coder → last tab) was a band-aid: the right fix is not to switch at all on close. Soft-close now keeps the user on the closing tab under a backdrop + spinner ring + countdown so they can still see what they were looking at and undo. Other tabs wait patiently in the strip; the picker is removed entirely. (If the user lets the 5s grace expire and other tabs survive, the most-recent one becomes active then — as a finality, not a surprise on every close.)

- **Undoing a soft-close is possible from the tab strip, not just the toast.** Previously the ↻ button was permanently hidden via an inline style that no CSS or JS undid. Clicking the strip entry now actually undoes the close, since `.tab.soft-closed .tab-close { display:none }` and `.tab.soft-closed .tab-reopen { display:flex }` rule on the same condition.

### Added

- **Countdown pill on each soft-closed tab.** A tiny `5s → 4s → 3s → 2s → 1s` chip next to the title on the strip entry, so users closing background tabs (who don't get the content overlay since they're on a different tab) still see how long they have to undo.

- **Content-area overlay on active-tab soft-close.** Dark backdrop + circular drain-ring that animates 100→0 over the 5s grace + rotating spinner + "Closing in Ns · Click ↻ in the tab strip to undo" text. Removed cleanly on undo or finalize.

## v0.8.2 — 2026-07-12

Small followup on top of v0.8.1 — one tab-management upgrade plus a handful of UX fixes.

### Added

- **Tab soft-close with 5s grace + smart next-tab picker.** Closing a tab now fades it out (`line-through` + 0.45 opacity, × swaps to ↻) and schedules a 5-second finalize. Hit Undo in the toast (or click the ↻) and the tab comes back — PTY was never killed. If you really mean it, click × twice. The "which tab opens next" picker now prefers the same workspace + same coder, then same workspace, then same coder, then the most-recent other tab — so closing a tab in `/projects/foo` no longer jumps to a tab in `/scratch/bar` from four hours ago. Capped at 3 soft-closed tabs at a time so the strip stays readable.

- **Manual "Restart phi" button.** A `↻` icon in the sidebar footer (next to the version pill + help button). Opens a confirm modal explaining what restart does and when to use it (`git pull && go install .`, `npm i -g phi-code`, or replace the standalone binary — whatever your install method is), then POSTs `/api/restart`. The existing WebSocket `0x05` frame handler does the reload dance. Works for every install method. Deliberately no auto-detection of new binaries on disk: the user knows what they did better than we do.

- **Copy button in the diff toolbar.** A 📋 icon next to Refresh + Close. Copies the current xterm selection if there is one, otherwise dumps the entire buffer (with xterm's trailing whitespace-only padding stripped) to the clipboard. Pairs with the new copy plumbing so drag-select / Cmd-C / Ctrl-Shift-C / right-click on git diff/status/log output now works the same as in the main terminal.

### Fixed

- **Git diff / status / log output now copies correctly.** Previously rendered as an "image" — drag-select highlighted the text but Cmd-C produced nothing. Root cause: the diff xterm had none of the copy handlers the main terminal has (`onSelectionChange` auto-copy, Cmd-C, Ctrl-Shift-C, right-click). Ported those handlers from the main terminal; the renderer itself (canvas/WebGL) wasn't the problem. (You can drag-select, Cmd-C, right-click — or just hit the new Copy button.)

- **Clicking the already-active tab stopped snapping the terminal to the bottom.** Previously, clicking on the tab you were already on rerouted the WS reset path and glued the viewport to the row of your last keystroke even if you'd scrolled up to read scrollback. Now clicking the active tab is a no-op.

- **Vendor truncated xterm addons replaced.** Some of the addons shipped in `web/vendor/xterm/` had been truncated mid-file (Firefox and Safari users saw `Could not open session` at launch). Replaced with intact copies; no expected behavior change on a working install.

- **Sidebar version pill no longer flashes `dev` for stamped builds.** When `/api/version` returns the ldflags-stamped version it wins. When it returns `dev` (un-stamped `go run` / dev build), the HTML ships with the latest release tag (`v0.8.2`) and is preserved as-is, so the sidebar never displays a useless `dev` string.

## v0.8.1 — 2026-07-12

Small polish release on top of v0.8.0.

### Added

- **Drag-to-reorder tabs.** Pick up any tab in the top bar and drag it to a new slot. A 2px accent indicator on the target tab's left or right edge shows where the drop will land. Pinned tabs are locked at the front and not draggable; everything else is freely movable. Order is persisted in `localStorage.phi_tab_order` (a JSON array of paneIds) so it survives page reload in the same browser. Stale paneIds (closed tabs, renamed sessions) are filtered out at restore time; new tabs are appended at the end. No backend changes - this is a per-browser preference, no sync.

## v0.8.0 — 2026-07-11

The "phi remembers" release. The focus of v0.8 is **durability**: phi was great while you were watching, but the moment you looked away — closed a laptop, lost WiFi, restarted the server — every tab went dead and stayed dead, with no way to recover the output you missed and no way to know *why* a tab died. v0.8 makes death cheap and recovery lossless.

### Added

- **Replay buffer.** Every pane now has a server-side ring buffer (1 MiB default, configurable via `terminal.replay_buffer_bytes`, set to `0` to disable). When you reconnect to a live PTY — after a WiFi drop, a browser crash, or just closing and reopening the tab — phi replays the buffered output before switching to live mode. You see exactly what the agent did while you were gone, not a blank screen. A `replay-complete` frame (protocol type `0x06`) marks the boundary between replay and live output; clients built against the old protocol ignore it silently.
- **Distinct death reasons.** Dead tabs now tell you *why* they died. A PTY that exited on its own (e.g. the agent ran `/exit`) shows "process exited (code N)" and offers only Restart. A PTY that was killed by the grace-period timer (you were gone too long) shows "session expired (PTY gone)". A plain WebSocket drop shows "connection lost" and offers Reconnect. The server broadcasts a `pty-exited` frame (`0x04`) with the real exit code so the client can pick the right message. No more staring at a red "Connection lost" overlay wondering if the agent finished or the network hiccupped.
- **Disconnect banner.** When one or more tabs go dead, a banner appears at the top of the terminal area: "N tabs disconnected — [Reconnect all] [Dismiss]". Reconnects only the tabs that died from disconnect (not exited processes). The banner re-arms if more tabs die after you dismiss it.
- **Optional auto-reconnect.** A new `auto_reconnect` config option (default `"off"`) can be set to `"visible"` to automatically attempt reconnection on dead tabs — but only for the active pane, only when the browser tab is visible and focused, with exponential backoff (1s, 2s, 4s, 8s, 16s, max 5 attempts). This is opt-in because the user's workflow involves many browser windows controlling the same server, and auto-reconnecting all of them simultaneously would be chaos.
- **Explicit tab click always reconnects.** Even with `auto_reconnect` off, clicking a dead tab (or using Alt+1–9, or clicking an OS notification) attempts to reconnect it. Only passive/programmatic tab switches (boot restore, close-tab fallback) respect the gate — explicit user actions always try to revive.
- **Post-restart tab restore.** Phi now persists a tiny tuple (`coder`, `session_id`, `cwd`, `title`) for each live tab to `~/.phi/tabs.json` using atomic write-then-rename. After a server restart, these appear as ghost tabs in the session list — the PTY is gone, but the tab is there with a "session expired" overlay and a Restart button, so you don't lose your mental map of what was running. Shells restore their `cwd`; coder sessions restore via their existing resume paths.
- **Sync Board persistence.** The AI Sync Board's in-memory message store is now persisted to `~/.phi/syncboard.json` (atomic writes, 500ms debounce). Messages survive server restarts. The coordinator pattern still works — the persisted store is the local one, and remote agents posting to your coordinator hit the same store.
- **Graceful shutdown.** On `SIGINT`/`SIGTERM` (or the `/api/restart` endpoint), phi flushes all persisted state, broadcasts a `server-shutdown` frame (`0x05`) with a reason (`restart`, `shutdown`) to every connected client, waits 200ms for the frames to land, then exits. The frontend polls `/api/version` and reloads when the server comes back (or after a 10s fallback). No more manual browser refresh after a restart.
- **Fleet strip.** Add peer phi servers to your config (`peers: [{name: "zen", url: "http://zen:7777"}]`) and phi polls each one's existing `/api/terminals` and `/api/version` endpoints every 15s (3s timeout, stale after 2 misses). The sidebar shows a compact presence row per peer: name, tab count, busy/idle split, quiet duration, and version. Click a peer to open its UI in a new tab. This is "10% of federation" — presence only, no remote control, zero changes required on the peer side.
- **Self-update (check + badge).** When built as a release binary (`BuildSource=release`, stamped by goreleaser), phi checks GitHub for a newer release on startup (30s staggered) and hourly thereafter (gated by a 24h staleness window + 6h minimum real-check interval, persisted in `~/.phi/phi_update.json`). The sidebar version badge turns into an update indicator; the changelog modal shows the latest version and install instructions tailored to your install method (npm, standalone, go-install, or dev). Update checks can be disabled with `update_check: false` in config.
- **Self-update (one-click staged swap).** For npm and standalone installs, the changelog modal's "Apply" button downloads the new release archive, verifies the SHA-256 against goreleaser's `checksums.txt` (fail-closed if the checksum is missing or mismatched), extracts the binary (zip-slip immune — only the base filename is used, never archive paths), and performs a rename dance: the running binary is renamed to `phi.old`, the new binary takes its place. On Windows this works because the OS allows renaming a running `.exe`. The swap takes effect on the next restart. For standalone installs, an "Apply & restart now" button chains the swap into a graceful restart. npm installs are excluded from restart-now because the Node shim's lifecycle makes detached restart unreliable.
- **`--rollback` flag.** If a self-update goes bad, run `phi --rollback` to swap the previous binary (`.old`) back into place. The current (bad) binary is preserved as `.rejected` rather than deleted. The `.old` backup is retained for 10 minutes after boot (configurable via `CleanupOldBinaryDelay` in the code) before being cleaned up, giving you a real window to notice and revert.
- **Diagnostics panel.** `Ctrl+Shift+D` opens a modal showing phi's version, install method, uptime, goroutine count, memory allocation, PTY count, and per-pane stats (client count, ring buffer fill, busy state, last activity). Also available via `GET /api/diag`. Intentionally unauthenticated — see Security Notes.
- **Terminal search.** `Ctrl+Shift+F` opens a find bar in the active terminal (powered by the xterm.js search addon). Incremental search, next/prev navigation, match highlighting.
- **10x scrollback.** Terminal scrollback increased from the xterm.js default of 1000 lines to 10000 lines, so the 1 MiB replay buffer isn't truncated client-side.
- **Viewer-count awareness.** The hub tracks how many WebSocket clients are attached to each pane (used by the diag panel). This is the groundwork for a future viewer-count badge in the tab UI.

### Changed

- **Version stamping.** phi now stamps `Version`, `Commit`, `Date`, and `BuildSource` at build time via goreleaser ldflags. The sidebar badge, `--version` flag, and `/api/version` endpoint all read from these stamped vars instead of a hardcoded string. The install method (npm, standalone, go-install, dev) is detected from `BuildSource` + the executable path + the Go build info, and drives which update instructions are shown.
- **Hub send-buffer overflow handling.** Previously, a slow client (e.g. a backgrounded browser tab being throttled by the browser) whose send channel filled up would have its WebSocket forcibly closed — terminal state corruption prevention, but a harsh UX. Now the hub drops the oldest queued messages and injects a `[phi: output dropped — slow client]` marker into the stream. The connection is only closed after 30+ seconds of sustained fullness, indicating a genuinely stuck client rather than a temporary throttle.
- **`-race` in CI.** The Go test step in GitHub Actions now runs with `-race`. The hub, ring buffer, PTY manager, and fleet poller all have significant concurrency; the race detector will catch regressions that are invisible on this Windows dev box (which can't run `-race` due to `CGO_ENABLED=0`).
- **Windows restart reliability.** `main()` now binds via `restart.BindWithRetry(addr, 5s, 100ms)` instead of a bare `http.ListenAndServe`. On Windows, when `/api/restart` spawns a detached child and the parent exits, the child retries the bind for up to 5 seconds to handle the port-release race. On Unix this succeeds on the first attempt (harmless no-op).
- **Idempotent WebSocket unregister.** The PTY manager's `UnregisterWS` is now keyed by client ID (a pointer string) in a `map[string]struct{}` instead of decrementing a counter. Double-unregister (e.g. from a race between read-pump and write-pump defers) is a no-op. The grace-period timer only starts on a true 1→0 client transition.

### Fixed

- **CRITICAL: v-prefix bug in self-update.** The update checker stored the latest version as the raw GitHub tag (e.g. `v0.8.2`), but the apply pipeline built asset URLs assuming a bare version (e.g. `releases/download/v{version}/phi_{version}_...`), producing `vv0.8.2` in the URL path and `phi_v0.8.2_` in the asset name — a guaranteed 404. One-click update was completely broken against any real release. Fixed by normalizing (stripping the leading `v`) at the `Apply()` entry point. The displayed version in the badge/banner is left v-prefixed for readability.
- **Stale-PTY gap.** A PTY that died in place (natural process exit or grace-period kill) kept a non-nil-but-dead `Pty` pointer forever. On reconnect, `HandleWS`'s dead-check wasn't taken, so the client got a normal replay+live attach, looked connected, then silently failed on the first keystroke instead of showing the correct "session expired" / "process exited" overlay. Fixed with a new `IsPtyDead()` method that does a non-blocking `select` on the `Pty.Closed` channel (race-free — the channel is closed exactly once by the process-wait goroutine). `SaveState` now skips died-in-place tabs too, so `tabs.json` doesn't accumulate dead records.
- **Diag modal was unreachable.** `initGlobalShortcuts()` (the `Ctrl+Shift+D` handler) was defined but never called from `init()`. The diag modal existed only in tests. Fixed by wiring it up; added a regression test that asserts the call is present in `init()`'s source.
- **F7: silent input loss on dead tabs.** `sendStagedInput()` and `sendRawInput()` had early `if (activeTab.isDead) return;` guards that silently dropped input *before* reaching `TabManager.sendInput()`'s toast-and-overlay path. Typing into the staged input bar on a dead tab would just vanish with no feedback. Fixed by removing the pre-check and letting `sendInput()` handle the dead case with a toast ("Tab is disconnected — input not sent") + reconnect overlay. The staged draft is now preserved on a failed send instead of being cleared.
- **F5: reconnectInFlight stuck.** If the `PTYWebSocket` constructor threw (unlikely but possible), `reconnectInFlight` stayed `true` forever and the tab could never be reconnected. Fixed with a try/catch that clears the flag and re-enables the overlay buttons.
- **F8: stdin/resize errors swallowed.** `bridge.go` discarded PTY write errors with `_, _ = inst.Pty.Write(payload)`. Now logged; `io.ErrClosedPipe` / `os.ErrClosed` trigger the normal PTY-exited broadcast path instead of a silent goroutine exit.
- **F9: dead client-side ping code.** `ws.js` had a `sendPing()` method and `pingInterval` clears that were never invoked — pure dead code from an earlier design. Removed.
- **Periodic update re-check.** The update checker ran exactly once at boot (30s staggered) and never again. A long-running phi process would never learn about new releases. Fixed with an hourly ticker that respects the 24h staleness window — each tick is cheap (no network call unless the 24h window has elapsed).

## v0.7.15 — 2026-07-10

**Added**
- **Kanban / Vikunja: full CRUD on tasks and buckets.** The board was missing basics that should have been there from day one — task delete, bucket create/rename/delete, and add/remove labels on a task.
  - **Delete task:** inline X on each card (hover-revealed, top-right) for quick delete + a dedicated Delete button in the detail panel footer. Both confirm before destructive action.
  - **Create column:** `+ Column` button in the toolbar. Prompts for a name and creates a new Vikunja bucket.
  - **Rename column:** click the column title to edit inline; Enter or blur saves, Escape cancels. Pencil icon next to the title does the same.
  - **Delete column:** trash icon next to the title; confirms, then drops the bucket + its cached tasks.
  - **Add/remove labels on a task:** the detail panel now has a label picker (dropdown of available Vikunja labels, minus the ones already on the task) with an Add button. Each existing label pill has an X to remove it.
- 14 jsdom tests in `test-js/kanbanCrud.test.js` covering the new API methods, the cache invalidation rules, the empty-title guard, and the "requires project/view cached" guard.

## v0.7.14 — 2026-07-10

**Added**
- **Clickable sidebar version text** — the `v0.7.15` text in the sidebar footer is now a button. Click it to open a markdown changelog popup (powered by a new `web/changelog.md` that ships embedded in the Go binary). Same widget as the `?` help button.

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

## v0.6.2 — 2026-07-06

**Fixed**
- Terminal theme: restored standard ANSI colors (was a custom palette that confused muscle memory; back to the conventional colors expected by every shell tool).
- Favicon: fixed initial color flash on page load — was rendering with the default theme color before the user's saved theme loaded.

## v0.6.1 — 2026-07-06

**Added**
- **Rich HTML kanban descriptions** — task descriptions can now contain markdown/HTML, rendered with a glassmorphism styling. Includes a raw-HTML toggle so you can see/edit the source.

**Changed**
- UI polish: fancy glassmorphism updates across kanban cards and modals for the obsidian aesthetic.

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

_Never made it into git history (no commits found via `git log --all -S 'v0.5.7'` / `'0.5.8'` / `'0.5.9'` / `'0.6.6'`): 0.5.7, 0.5.8, 0.5.9, 0.6.6 — these were apparently local-only version bumps that were overwritten before commit. Not on npm._