# Phi Changelog

All notable changes to phi are documented here. Newest versions first.

## v0.19.1 — 2026-08-12

### Fixed
- **Active server rail highlight** (`e2d681c`). Hovering another server no
  longer demotes the currently selected server's highlight.
- **Desktop runtime assets** (`e2d681c`). `phi-client` installers now package the icons,
  tray assets, and alarm sound required at runtime.

## v0.19.0 — 2026-08-12

### Added
- **Electron desktop client for Phi** (`2240b34`). A native Windows, macOS,
  and Linux client with a Discord-style server rail, retained per-server
  views, native window controls, tray integration, deep-link routing, protocol
  registration, global shortcuts, taskbar state, notifications, and the same
  vendored Phi header as the browser.
- **Protected-server desktop login** (`00ee611`). The desktop unlocks an
  access-protected body view with a one-time challenge/proof flow. The
  password and verifier stay in the host process; the body receives only its
  own same-origin session, with persisted credentials protected by the OS
  keychain.
- **Desktop release packages** (`6136bff`). Release CI builds separate
  Windows, Linux, and macOS installers and attaches them to the GitHub Release
  as `phi-client` artifacts.
- **Desktop interaction parity** (`14c7f7f`, `da688ff`). Plain F11 works on
  every desktop-owned surface, and the main header follows the selected
  server's workspace without stale cross-server repaints.

### Fixed
- **Server rail accent feedback** (`e65f02a`). Hover now gives every saved
  server its own faint accent treatment while the add button remains neutral.

## v0.18.1 — 2026-08-06

### Added
- **Optional `claude --dangerously-skip-permissions` flag** (`08b0413`). Mirrors
  the existing `pi --offline` opt-in: a per-coder boolean in `~/.phi/config.json`
  (`claude_dangerously_skip_permissions`, default `false`) that, when set, makes
  the next claude spawn pass `--dangerously-skip-permissions`. Scoped to claude
  because the flag is claude's own and other coders would reject it. Applies at
  exec time, so an already-running claude tab is unaffected. Surface is a new
  settings row in the Behavior group, **"Start Claude with
  --dangerously-skip-permissions (new tabs only)"**, that POSTs to
  `/api/config/claude-dangerously-skip-permissions`. `buildCoderArgs` gained a
  sixth parameter; the existing `pi --offline` plumbing was not touched. New
  tests pin off-by-default, scope-to-claude, no-registry-mutation, coexistence
  with `--resume`, save/load round-trip, and independence from the `--offline`
  flag (turning claude on does not leak `--offline` onto a claude spawn, and
  vice versa).

- **Paste clipboard text into a new markdown file** (`994ee2b`). A new
  **📋 Paste** button in the markdown tab's manage row reads plain text from
  the OS clipboard via `navigator.clipboard.readText()` and opens a modal that
  lets the user name the new file (default `pasted-YYYY-MM-DD-HHmmss.md` in
  local time) and pick a target markdown directory. When the browser blocks the
  clipboard read (insecure context, missing API, permission denied) the modal
  opens with an empty editable textarea and a contextual hint, so the user can
  paste by hand. The static modal markup reuses the generic
  `.modal-overlay / .modal-content / .modal-body / .modal-footer` classes, so
  it inherits the 2026-07-27 mobile-keyboard-aware fixes automatically — the
  Save button stays pinned above the on-screen keyboard on iOS without any new
  CSS in the `@media` block. The manage row gets `flex-wrap: wrap` so four
  buttons (Export, Import, Paste, Add Dir) fit on narrow sidebars. 409
  responses transition Save → Overwrite without closing the modal; editing the
  filename resets the conflict state so the user can change the name and try
  again without an overwrite. Every `focus()` call uses `{ preventScroll: true }`
  per the scroll-contract rule. 16 new test cases in
  `test-js/markdownPasteFromClipboard.test.js`.

### Dev tooling
- **Replaced the hand-rolled `pkg/lint` CSS/HTML linter with stylelint +
  html-validate.** The 581-LOC Go linter (brace-balance check plus a
  `media-too-large` size heuristic) is gone; `.stylelintrc.js` and
  `.htmlvalidate.js` extend `stylelint-config-standard` /
  `html-validate:recommended`, with every default-fighting rule disabled and
  justified inline against the real files' conventions (legacy `rgba()`
  color notation, BEM `--modifier` classes, inline `style=` attributes, and
  so on). Both run via `pnpm run lint:web`, wired into the advisory
  pre-commit hook (`web/style.css`, `web/index.html`, `web/md.html`) and
  into CI's `test-ts` job on every push/PR — restoring the enforced
  guarantee the old `go test ./pkg/lint` gave. Caught and fixed along the
  way: a duplicate `box-shadow` declaration and an invalid `group: hover`
  property in `web/style.css`; two missing `aria-label`s on `<aside>` panels
  and one unescaped `&` in `web/index.html`. One capability is lost with no
  replacement: the old heuristic flagged an `@media` block whose closing
  brace lands hundreds of lines later than expected while still
  brace-balanced (e.g. `@media block opened at line 3487 spans 620 lines —
  suspiciously large`); neither stylelint nor html-validate has an
  equivalent check. The largest legitimate `@media` block in the file today
  is 428 lines, for scale.

## v0.18.0 — 2026-08-02

### Added
- **Release binaries ship precompressed, minified web assets** (`40a2cc3`). Release
  builds (`-tags=embedassets`) embed a build-time mirror of `web/`: first-party
  JS/CSS minified with esbuild (per-file, module graph untouched; `vendor/` stays
  upstream-minified), then brotli-q11 compressed where it shrinks, decompressed once
  at startup (~10 ms) into an in-memory tree. The runtime brotli encoder from
  v0.17.0 never runs in release — clients get the build-time q11 bytes verbatim, so
  the ~200 ms first-hit encode spikes are gone. Measured: binary 15.24 → 13.53 MB
  (−1.71 MB); `app.js` travels 108 KB → 11.2 KB; the four heaviest assets 694 KB →
  64 KB of wire (~11×). Dev builds are untouched — `go run .` still embeds raw
  `web/` with no generator step and vite serves readable sources; the dev-only lazy
  encoder drops q11 → q6 (~60× faster encodes, bodies ~12% larger). ETags stay
  derived from the bytes actually served; `serveStatic` is one code path in both
  modes, and CI now smoke-tests the tagged build.

### Fixed
- **Control keys are forwarded to the PTY when the terminal is focused in
  non-direct mode** (`b8eebd0`).

## v0.17.0 — 2026-08-02

### Added
- **The web UI now caches and compresses its assets** (`94644ec`). Embedded assets
  shipped with no validators at all — `embed.FS` reports zero mod-times, so responses
  carried neither `Last-Modified` nor `ETag` and every page load re-downloaded ~2 MB.
  Each asset now gets a startup-computed strong ETag with `Cache-Control: no-cache`,
  so a warm reload revalidates instead of refetching: measured live, 716 KB of content
  arrives over 10.5 KB of wire (~300 bytes per asset). Responses also negotiate gzip
  or brotli per `Accept-Encoding`, compressed once per process and cached in memory —
  cold-load text drops ~74% (`xterm.js` 283→55 KB, `style.css` 200→31 KB over brotli)
  and the 152 KB bell chime travels at 49–70 KB. woff2 fonts (already brotli inside)
  and images are served as-is. Brotli only reaches Chromium-on-localhost and
  TLS-proxied clients; plain-HTTP LAN browsers negotiate the gzip floor. New
  `compression_enabled` setting (default on, config-file only) hands compression to a
  reverse proxy like nginx or varnish; ETags stay on either way. The trade-offs, plainly:
  the brotli library adds ~1.05 MB to the binary, partially offset by relocating the
  425 KB vikunja swagger test fixture out of the embedded tree (net +646 KB), and the
  "session done" chime now reuses one `Audio` object instead of constructing a fresh
  one (and a fresh 152 KB fetch) per chime. `help.md`/`changelog.md` fetches drop
  their `cache: 'no-store'` and revalidate like everything else.

### Fixed
- **`go test -race` no longer flakes on a leaked sync debounce timer** (`a2b7cfb`).
  `TriggerSaveSyncStore`'s 500 ms `time.AfterFunc` resolved the store path when it
  fired, reading `testSyncPath` while a later test rewrote it — roughly one full-suite
  run in three failed on whatever test happened to be running at the time. The timer
  now captures its path at schedule time; debounce semantics are unchanged.

## v0.16.2 — 2026-08-01

### Changed
- **The UI stops animating when nothing is happening** (`392f797`). The always-on animations cost about 1.4 cores on the idle screen and 0.7 in normal use, to produce motion that could not actually be seen. Measured by ablation on the real shell, as % of one core against a 10.7% floor: idle screen 146; with `backdrop-filter` disabled but animations kept 135; with animations disabled but `backdrop-filter` kept 11. Individually, the brand at `cpu-critical` 98, at `cpu-moderate` 70, the activity blink 35, the input focus glow 12. Afterwards: idle 11.8, typical use 10.9, critical load 11.2 — non-fast mode is now within noise of fast mode.

  Static shadows are free; animating them is billed every 16.7ms forever. So each CPU tier's glow is baked in from the peak of the keyframes it replaces — the brand now sits at full intensity rather than averaging toward the trough — and motion is kept only where it carries information: a finite burst when the tier changes, a one-shot wake when the activity indicator lights up. Both stop by themselves. The activity blink expressed roughly 1.2 changes a second but was billed 60 times a second; the glyph already swaps between a bar and a dash, so the wake plays once. The chromatic split, nuclear glow, hieroglyph registers, torchlight and empty-logo glow are all unchanged, and every spinner tied to real work still spins.

  This also removes a perverse incentive: `cpu-critical` previously cost the most CPU exactly when the machine was already under critical load.

### Fixed
- **Correction to the v0.16.0 entry below.** It claimed the idle CPU burn came from the header's `backdrop-filter` being recomputed, and credited compositor promotion with taking 100.5% down to 30.3%. That diagnosis was wrong. Ablation puts the blur at ~8% of the cost and the animations at ~99%, and on a blank page with no blur anywhere a single opacity animation on a 24px square still costs ~2.4ms per frame — twenty squares cost ~2.9ms. The charge is per frame for having any animation running at all, not per pixel and not for the blur. The promotion shipped in v0.16.0 measured as nothing, and its `will-change` hints are now scoped to the finite bursts that actually animate transform. The 30.3% figure was measured against a different implementation than the one released.

## v0.16.1 — 2026-08-01

### Added
- **Option to start pi with `--offline`** (`319d851`). New `pi_offline` setting under Settings ▸ Behaviour, off by default so existing configs are unchanged. When on, the pi coder is spawned with `--offline` to skip its startup network calls — useful on airgapped or metered hosts. Scoped to pi, since the flag is pi's own and other coders would reject it, and applied at spawn, so it affects new tabs rather than a running session.

### Fixed
- **npm publish no longer fails on the pnpm pin** (`9e48b54`). `setup-node`'s dependency cache is on by default; it read the repo's `packageManager: pnpm` and shelled out to pnpm, which the publish job does not install. That job only publishes the `npm/` wrapper and installs nothing, so the cache is now disabled there. The v0.16.0 release hit this after goreleaser had already cut the GitHub release, leaving npm a version behind until it was re-cut.

### Internal
- **Coder argv assembly extracted to `buildCoderArgs`** (`319d851`). It also copies the registry's `Args` slice instead of appending onto it. `coders.Registry` is process-wide, and the previous `append(c.Args, ...)` was safe only because those slices are zero-length — giving any coder default args would have leaked flags between spawns.

## v0.16.0 — 2026-08-01

### Added
- **Markdown files can pop out into their own window** (`ecf3d65`). "Open in new window" on the markdown list's context menu opens the file in a standalone popup (`web/md.html`) so the main UI stays free while you read. The popup shares the session cookie, live-refreshes when the file changes on disk — via a new listen-only `/ws/md-events` WebSocket that carries the existing fswatch broadcast — reconnects after a dropped connection, and preserves scroll position across refreshes.
- **Local images referenced by markdown now render** (`ecf3d65`). `![x](./img.png)` never worked: relative srcs resolved against the page URL and no endpoint served image bytes. A new `/api/markdown/asset` endpoint serves png/jpg/jpeg/gif/webp/svg confined to the workspace roots (symlinks resolved, direct navigation neutered with `script-src 'none'`), and the client rewrites relative image srcs against the markdown file's directory. Modal and popup both benefit.

### Fixed
- **Markdown rendered unsanitized HTML** (`ecf3d65`). Three call sites fed `marked.parse()` output straight into `innerHTML`, so a `<script>` tag or `onerror` attribute in any .md file or agent chat message executed with the page's session. All markdown-derived HTML now flows through one shared DOMPurify helper. The fswatcher also fires on in-place writes now, so external edits refresh the panel and popup reliably.

### Internal
> **Correction (v0.16.2):** the performance note that shipped with this release
> attributed the idle CPU cost to the header's `backdrop-filter` recompute and
> credited compositor promotion with a 3.3x win. Later measurement showed the
> blur was ~8% of the cost and the animations ~99%, and that the promotion
> changed nothing outside noise. See the v0.16.2 entry.

- **JS tooling moved from npm to pnpm** (`6d701d4`). `package-lock.json` is replaced by `pnpm-lock.yaml`, `packageManager` pins `pnpm@11.18.0`, and CI plus `.githooks/pre-commit` invoke pnpm. Contributors need pnpm on PATH — `npm i -g pnpm@11.18.0` works without admin rights, where `corepack enable` may not.

## v0.15.6 — 2026-08-01

### Added
- **Fast mode** (`e8f2d8a`). A setting that disables the idle-capable infinite animations and the always-visible backdrop blurs. Coarse by design — any single running animation is enough to keep the 60fps repaint pipeline alive.

### Changed
- **Idle UI animations no longer force the header blur to recompute** (`928f3b1`, `f9948f1`). `.app-header` carries `backdrop-filter: blur(20px) saturate(180%)`, and the brand, the terminal activity indicator and the logo glow all animate inside it. Without their own compositor layer each repaint dirtied the header layer and re-ran that blur for the whole strip, 60 times a second. Measured on one core: animations off 5.3%, breath + blink 100.5%, the same two with their own layer 30.3%. A pure opacity blink cost 121.3% on its own — as much as a text-shadow breath — which is the tell that the cost was the backdrop-filter recompute rather than the property being animated. Every animating descendant of the header is now promoted; promoting only some of them buys nothing. The layers are released under fast mode and `prefers-reduced-motion`, so none is parked while nothing animates. No visual change.

## v0.15.5 — 2026-08-01

### Changed
- **Fonts and coder logos are vendored; phi no longer contacts a CDN** (`d20391b`). Two remote asset references were shipping: Google Fonts for Inter and JetBrains Mono, and `google.com/s2/favicons` for all six coder logos. Both were hard dependencies on the public internet for something the UI needs to render — on a LAN-only or airgapped install you got fallback fonts and broken logos — and both disclosed every page load to Google. The fonts are now 13 local woff2 files (320K) generated from the css2 response with every gstatic URL rewritten; all unicode subsets are kept, because the greek subset renders the activity indicator's Φ/ϕ glyphs in the UI font. `//go:embed all:web` picks the new directories up automatically, and the binary serves them with correct content types. `test-js/noExternalAssets.test.js` fails the build if a reference to any known asset CDN reappears.

## v0.15.4 — 2026-08-01

### Fixed
- **macOS `.local` suffix no longer shows in the UI** (`cfd32dc`). macOS reports its hostname with the mDNS/Bonjour suffix attached, so the sidebar header, the empty state, the browser title and Settings ▸ About all read `studio.local` — the last of those uppercased into a shouty `.LOCAL`. phi labels a single machine, so the suffix carries no information. Display only: the raw hostname is unchanged everywhere it identifies the host. Case-insensitive, handles the fully-qualified trailing dot (`studio.local.`), strips only a trailing segment (`local.example.com` and `host.localdomain` are left alone), and never reduces a hostname to an empty string.

## v0.15.3 — 2026-07-31

Patch batch covering every commit since v0.15.2: three contributed features, a Kanban reliability pass, and four fixes found while testing.

### Added
- **Automatic browser reconnects** (`80028d0`, #16). The active tab revives on visibility return, network restore, and bfcache restore, with full-jitter exponential backoff (20s cap, 10 attempts). `auto_reconnect` defaults to `visible` and has a Settings toggle. Kanban and review panes are excluded — they have no PTY to redial.
- **File tree panel with per-coder `@path` insertion** (`90422b9`, #18). Browse the workspace and insert a path into the active coder's input, honouring `.gitignore`.
- **`Insert @path` in the markdown panel** (`d0a18ad`, #17). Context-menu action mirroring the same insertion behaviour.

### Changed
- **Kanban edits no longer reload the board** (`2ef4e85`, `aebc6a6`). Renames, priority, due dates, done toggles, deletes and subtask changes repaint the card or roll-up they touched; the board stays on screen and keeps its scroll position and active filter. Full reloads remain for first paint, project switches, and bucket changes, which are structural. A rejected write rolls back and re-reads the task, so the cache cannot keep a value the server refused — task writes send the whole object, so a stale cached field would otherwise be persisted by the next save.
- **Stats is board-wide, not feature-only** (`3a370c9`). The view was gated on feature parents, so a board of plain tasks showed an empty state and no charts. Every metric and chart now covers all tasks: completion, velocity, forecast, and filed-vs-done flow. Features remain as one secondary card, omitted when the board has none.

### Fixed
- **Kanban task creation on a fresh origin** (`44a9032`). Quick-add read the project id straight from `localStorage`, which is per-origin; on a host where the project dropdown had never been touched the key was absent, so the request went to the literal path `/projects/NaN/tasks` and Vikunja answered an opaque `400 Invalid model provided`. It now uses the resolved project id, and unresolved ids are refused before reaching the network.
- **Expired Kanban sessions recover themselves** (`1be0324`). Vikunja's JWT expires while the board sits open. Only board load recovered, via the saved-vault login, so the board returned but the next click — opening a description, saving, dragging — died with `Session expired`. Re-authentication now happens per request, with one shared login for parallel failures and a single retry.
- **Reconnect refreshes the terminal instead of stacking artefacts** (`e643bc8`). The server replays its whole ring buffer on every attach, so a reconnect appended a second copy of the scrollback. It now resets on the first replayed byte. The `[Connection lost]` / `[Reconnected]` buffer writes are gone — the overlay, banner and toast already report it without leaving permanent scrollback.
- **Terminal recovers from a lost WebGL context** (`6553d14`). The renderer was only guarded against failing to construct; a context lost at runtime left the addon drawing into a dead GL context, rendering garbage that never recovered. Most visible on mobile, where GPUs drop contexts under memory pressure. Disposing falls back to the DOM renderer.
- **Ctrl-C shuts the server down promptly** (`702d2a4`). Interactive shutdown waited up to 10s for PTYs and a further 15s to drain HTTP; a comment claimed a tty was unaffected, but that only ever applied to the drain delay. With a terminal attached both graces are now 1s. Separately, `Manager.Shutdown` documented a SIGKILL escalation for children that ignore SIGTERM and never performed one, so those children were orphaned when the process exited — it now escalates for real, which is what makes the shorter grace safe. `PHI_SHUTDOWN_PTY_GRACE` and `PHI_SHUTDOWN_GRACE` still override, and non-tty (k8s, systemd) shutdown keeps the original 5s/15s.
- **Auto-reconnect no longer flaps** (`c984174`). `reconnectAttempts` was cleared in the socket's `onopen` handler, so a connection that opened and immediately died counted as a success and the counter could never climb past 1. The exponential backoff therefore never engaged and the 10-attempt cap was unreachable, leaving a flapping pane redialling forever at roughly half-second intervals — which presents as constant disconnects during active use. The reset now runs from a 5s stability timer that is cancelled if the socket dies first, and every redial has a 1s floor (full jitter alone could return near-zero).
- **Websocket teardowns say why** (`dd9077c`). Both `WritePump` exits discarded the error, so a dropped socket and a clean client close produced identical output: nothing. Write failures now log the error, frame size, queue depth, and whether the `writeWait` deadline was what fired.
- **pi model selection commits the identifier, not the autocomplete's pick** (`d1a34ee`). Typing `/model` opens pi-tui's command autocomplete, which consumes Enter to accept its own highlighted entry. The sequence is now `/model <id>` → pause → Esc → pause → Enter: Esc dismisses the dropdown so the Enter commits the typed line. Three sends instead of four, 400ms instead of 600ms.
- **File-tree path guard is consistent across platforms** (`b95700a`). `filepath.IsAbs("/etc")` is false on Windows, where an absolute path needs a drive letter or UNC prefix, so the traversal guard did not fire there. Containment still held, so this was guard consistency rather than an escape.

### Tests
- `test-js/vikunjaRequestContract.test.js` (new) — validates every Kanban mutation against the vendored Vikunja swagger: path, method, body fields and types, plus unresolved ids. Derives the mutation surface from the code, so a new call site without a contract case fails the build.
- `test-js/kanbanIncremental.test.js` (new) — card and roll-up patching, delegated actions surviving a repaint, optimistic rollback, and refresh preserving scroll and filter.
- `test-js/kanbanReauth.test.js`, `test-js/reconnectReplay.test.js` (new) — session recovery and replay handling.
- `pkg/pty/manager_test.go` — `TestManagerShutdown_GracefulTerminatesAndCleansUp` polls for the asynchronous cleanup instead of asserting the instant `Shutdown` returns; it was failing CI intermittently at exactly the 4s bound (`ab846bf`).

## v0.15.2 — 2026-07-31

Patch bump for current Pi and Claude model-switch behavior.

### Changed
- **Pi saved-model picker** (`0e18ebc`). Model selection now follows Pi's current four-step interaction: `/model`, Enter, identifier, Enter, with a short pause between each state transition.
- **Claude model presets** (`f16aa57`). New configurations start with the compact aliases `fable`, `opus`, `sonnet`, and `haiku`.
- **Claude cache-warning confirmation** (`f16aa57`). After a Claude model command, Phi waits briefly and sends a final Enter to dismiss the CLI's model-switch cache warning. The delayed input stays pinned to the tab selected at click time.
+
### Tests
- `test-js/sendSlashCommand.test.js` — Pi picker ordering and Claude warning-confirmation routing, including cross-tab protection.
- `main_test.go` — exact default Claude preset list.
+
+## v0.15.1 — 2026-07-26

Patch bump. Kanban gets three new capabilities and one rendering fix; the access-password UX gets one CSS-specificity fix.

### Added
- **Feature portfolio stats** (`51bf080`). Kanban panel now shows aggregate counts of phi-native features by status (Active / Completed / Backlog) and by priority, alongside the existing Vikunja columns. Uses the same hierarchy-fetch path that landed in v0.15.0; failures are additive — Vikunja columns still render even when the feature fetch fails.
- **Project health chart** (`8f06312`). A small inline SVG chart on the Kanban panel shows the breakdown of phi-native features (active vs completed vs backlog) plus per-priority counts. Pulls from the same feature cache. Empty projects show a clean "no features yet" placeholder rather than a broken chart.

### Fixed
- **Kanban shared-task HTML descriptions render as HTML, not escaped text** (`da6f818`). Vikunja tasks marked as shared have HTML descriptions intended to render inline; the previous code escaped them, which broke shared task formatting. Now renders with a sanitization pass (script tags / event handlers / javascript: URLs stripped) so shared content stays safe to render while preserving its intended formatting.
- **Access-password Confirm remove was rendering in big red despite `el.hidden = true`** (`fce0ef9`). The HTML `hidden` attribute applies via the user-agent stylesheet (`[hidden] { display: none }`), but `.btn { display: flex }` has higher specificity (author > user-agent) and won. Switched to phi's existing `.hidden` class convention (which uses `!important`) — the button now actually disappears. Regression net added.

### Tests
- `test-js/kanbanFeatures.test.js` — extended with portfolio stats cases (counts by status, by priority, empty-state placeholder).
- `test-js/kanbanHealth.test.js` (new) — chart render cases (active/completed/backlog slice, per-priority slice, empty placeholder, data update on project switch).
- `test-js/kanbanSharedDescription.test.js` (new) — HTML render path with sanitization: tags preserved, `<script>` stripped, `onerror=` stripped, `javascript:` URLs stripped.
- `test-js/settingsModal.test.js` — +1 case pinning the `.hidden`-class convention over the `[hidden]` attribute.

## v0.15.0 — 2026-07-26

Minor bump for two user-facing fixes that together make phi feel less like raw infrastructure: the access-password UX rework and a Kanban fetch bug that was silently dropping bucket state.

### Changed
- **Unlock prompt copy** (`003b881`). "Phi is locked" → "Sign in to Phi" + "Unlock" → "Sign in" + new subtitle "Enter your password to continue." Industry convention over emergency-speak.
- **Settings password section rebuild** (`003b881`). Single primary button ("Set password" / "Update password") properly sized with padding and `min-width: 140px`. New + Confirm fields with inline validation ("At least 8 characters." / "Passwords don't match."), error clears on input. State indicator is now a colored dot (gray off / accent-glow on) instead of a text badge. Remove password is a quiet text-link + two-step inline Confirm button — replaces `window.confirm()`. Session cookie authorizes the action server-side; no API change.
- **Toast copy**: "Access password saved" → "Password updated", "Access password disabled" → "Password removed".

### Fixed
- **Kanban board: cards lost bucket state when the project had subtasks** (`cdb529a`). Vikunja's `?expand=subtasks` query parameter changes how it responds on Kanban views — cards were coming back without the authoritative bucket assignment, which made the board render cards in the wrong column whenever any task in the project had children. Fix: fetch the board unexpanded (preserves bucket state) and fetch the project tasks separately for the hierarchy; merge only the `related_tasks` relation map onto each board card. Features remain additive — if the hierarchy fetch fails the board still renders, just without phi-native subtask indicators.

### Tests
- `test-js/accessAuth.test.js` updated for the new copy.
- `test-js/settingsModal.test.js` — +4 cases for the new flow: short-password blocked, mismatch blocked, typing clears error, two-step remove confirm.
- `test-js/kanbanFeatures.test.js` — +2 cases pinning the subtask-merge behavior: cards retain bucket state when project has subtasks, hierarchy-only failures fall back to the board without features.

697 vitest pass (was 692 at v0.14.4; +5: 4 settings flow + 1 kanban subtask).

## v0.14.4 — 2026-07-25

Patch batch covering every commit since the v0.14.3 tag. Two user-facing features (optional access password, kanban feature roll-ups), a kanban black-screen fix, and three input-routing refactors that close a long-standing cross-tab race.

### Added
- **Optional access password** (`9c538aa`). A new `auth.go` middleware gates the HTTP API and a per-tab WebSocket auth handshake gates live panes. When no password is configured, behavior is unchanged; when set, the browser prompts for it on first load and the session cookie keeps the user signed in. Password is stored as a salted hash (Argon2id via `pkg/vendor/noble-hashes`); the Settings modal exposes the controls. README updated with the safe-default-binding note.
- **Kanban feature roll-ups** (`522e805`). The Kanban panel now surfaces native phi task features alongside Vikunja items — a feature roll-up row appears at the top of every column showing the count of phi-native items in that bucket, clickable to filter. New `web-src/kanban-features.ts` module owns the roll-up logic; CSS adds the roll-up chip + collapsed/expanded states. Two new test files (`kanbanFeatures.test.js`, `vikunjaContract.test.js`) lock in the roll-up math and the Vikunja shape contract.

### Fixed
- **Kanban panel black screen on first click** (`929d938`). `KanbanManager.initTabContainer` used to overwrite `termContainer.className = 'term-container kanban-panel'`, which silently dropped the `.active` class that `createTab → switchTab` had just added. The kanban container's children rendered correctly but `.kanban-panel` without `.active` is `display:none`, so the panel showed only `--bg-base` (black on dark theme). Subsequent clicks hit `switchTab`'s `activePaneId === paneId` early-return, which never re-adds `.active` — the black screen was permanent until hard-refresh. Fixed via `container.classList.add('kanban-panel')` so `.active` survives.

### Changed
- **Slash-command input routing** (`3cd9f3a`, `29c414a`). Two new primitives on `TabManager`: `sendToTab(tabInfo, payload)` (thin wrapper over `sendInput` + scroll follow-up; does **not** re-resolve the active tab) and `sendSlashCommand(tabInfo, cmd)` (one atomic bracketed-paste write carrying both the slash command and Enter — replaces a 200ms split that re-resolved active tab in the delayed callback). Three sites collapsed to atomic: desktop coder presets (`terminal.js:4023`), mobile `renderSlashDropup` (`terminal.js:4155`), and the model dropup pi branch (`terminal.js:4454`). The opencode picker chain (4-send puppet sequence) keeps its timing but now also routes through `sendToTab`. Commit 1 carries the pinning + cross-tab regression test; commit 2 carries the atomic collapse + atomicity tests.
- **Pi model dropdown routed through the picker** (`de9562e`). The previous `/model <name>` exact-match relied on pi 0.81.x's `findExactModelReferenceMatch`, which is flaky: sometimes switches, sometimes opens the picker prefiltered, sometimes filters to nothing. Manual finger-typed `/model <name>⏎` exhibits the same flakiness; the picker (search + arrows + Enter) is reliable per user report. Defensive fix: route the model dropdown through pi's picker with a 3-step sequence (open / type filter / select), pinned to the click-time tab via `sendToTab`. ~900ms total instead of the previous single atomic write. Same shape as the opencode branch above.

### Tests
- **Frontend (vitest)** — 692 tests, +32 since v0.14.3:
  - `test-js/accessAuth.test.js` (new) — 11 cases: login flow, session persistence, expired-session re-prompt, websocket handshake, password hash round-trip.
  - `test-js/accessPasswordSave.test.js` (new) — 4 cases: settings modal save/clear, password validation.
  - `test-js/kanbanFeatures.test.js` (new) — 8 cases: feature roll-up counts, filter toggles, collapse/expand states.
  - `test-js/vikunjaContract.test.js` (new) — 1 case: Vikunja shape contract pinned.
  - `test-js/kanbanTabInteraction.test.js` (extended) — +3 BUG-5 cases: first-open `.active` preservation, second-open re-init, click-tab-element preserves `.active`.
  - `test-js/sendSlashCommand.test.js` (new) — 12 cases: atomic paste+Enter, picker-routing shape, cross-tab regression, WS-drop mid-chain, default-coder unchanged, non-paste-eligible preset unchanged.
- **Backend (Go)** — `auth_test.go` (new) — 9 cases: middleware allow/deny, hash round-trip, session cookie, websocket auth handshake.

## v0.14.3 — 2026-07-24

Patch batch of three PRs from `n0mad-awx` (Franklin He) since v0.14.2: a CI/release workflow fix that builds the frontend before GoReleaser, a customizable terminal font (size + curated family + local custom-font upload via IndexedDB), and a vendored-xterm scroll-sync fix for streaming output.

### Added
- **Customizable terminal font** (`#12`). `TerminalFontSize` config field (8–32, clamped server-side; 0 is the responsive-default sentinel), curated `Terminal font` dropdown in Settings mirroring the existing UI font control — six mono families (JetBrains Mono, Fira Code, Hack, Iosevka, Cascadia Code, Source Code Pro), all with starship/powerline glyph coverage. Pre-existing free-text `terminal_font_family` values survive via a `Current: …` option so custom configs aren't lost.
- **Custom font upload (local-only).** Drag-drop or pick a `.ttf`/`.otf`; the bytes stay in IndexedDB and are registered via `@font-face`; the family becomes available in both the UI-font and terminal-font dropdowns. Never sent to the server.
- **Appearance now persists to `localStorage` too** (browser-authoritative, survives a server `config.json` reset). An inline pre-paint script applies the saved values before the first paint, so there's no flash of unstyled content on reload. New `Reset` button in the settings modal clears the browser-side overrides.
- **CI: build UI before release.** `.github/workflows/release.yml` now runs `npm ci && npm run build:web` immediately before GoReleaser, so the embedded `web/` (via `//go:embed all:web`) reflects the current `web-src/*.ts` rather than whatever compiled JS happened to be committed. Keeps release artifacts authoritative.

### Fixed
- **Vendored xterm scroll desync during streaming** (`#13`). Two related bugs surfaced under sustained PTY output: (1) the DOM scroll area went stale so wheel-up jumped to a stale coordinate and wheel-down clamped before the real bottom; (2) the public `onScroll` was suppressed for user wheel/scrollbar input so the jump-to-bottom button and follow re-engagement never heard real user scrolls. Fix: sync the scroll area after each write batch; drive the button and follow state from the DOM `scroll` event in capture phase (rAF-coalesced); add a wheel-down escape hatch for a stale-clamped viewport.

### Dev tooling
- **Advisory pre-commit hook** at `.githooks/pre-commit`. Mirrors the CI frontend checks locally so drift, type errors, and syntax slips are caught at commit time instead of at push. Runs `node --check` on staged `web/*.js`, runs `typecheck + build:web` drift guard when `web-src/*.ts` changed, and `go test ./pkg/lint` when `web/style.css` or `web/index.html` changed. Enable once per clone: `git config core.hooksPath .githooks`. Bypass with `git commit --no-verify`. CI is still the enforced backstop.

### Tests
- **Frontend (vitest)** — 657 tests, +11 since v0.14.2:
  - `test-js/settingsModal.test.js` — font dropdown change handlers, font-size clamp on input.
  - `test-js/scrollSync.test.js` (new, `#13`) — 8 cases: DOM sync during streaming, `scroll` event capture + rAF coalesce, wheel-down escape hatch.
  - `test-js/terminalActivityChrome.test.js` — write-completion callback assertion updated for the new argument.
- **Backend (Go)** — `appearance_handlers_test.go` adds `terminal_font_size` to the persist-and-read round-trip.

## v0.14.2 — 2026-07-22

Patch batch covering everything shipped between the v0.14.1 tag and now: two PRs merged directly into main by the maintainer (`n0mad-awx/#10`, `n0mad-awx/#11`), the config-pill UX fixes, the sync-board "Clear all" button, the ctrl+shift+x chip strict-subset refactor, and the git-stderr-spam fix. The version button / index.html display version is bumped by this commit.

### Added
- **fsnotify-backed markdown watcher** (`n0mad-awx/#11` — landed between v0.14.1 and v0.14.2 as a direct merge). New `pkg/fswatch` — generic, reusable directory-watching infra (debounced per-dir callbacks, a 15s rearm ticker that arms directories created after boot, pluggable per-file `Filter`) over a real OS-level watcher (`fsnotify/fsnotify`). The markdown panel is its first consumer: it watches the resolved markdown dirs of every live pane's cwd with `ExtFilter(".md")`, and on a `.md` create/remove/rename the server broadcasts a new WS frame `0x07 md-changed {"dir"}` to every connected pane. The watch set is recomputed after markdown-dir config changes and new pane spawns.
- **Attention-toast "Go to tab" action** (`n0mad-awx/#10` — landed between v0.14.1 and v0.14.2 as a direct merge). The idle-attention toast (`Session X is waiting at a prompt.` / `completed execution.`) now carries a Go to tab action button that switches to the originating pane, mirroring what the OS-level notification onclick already does. Reuses the existing `showToast`.
- **Sync "Clear all" button.** New chip in the sync panel header (next to `Add`) that confirms, then DELETEs every key on the current coordinator sequentially. No bulk-delete endpoint exists in `pkg/phi-skills/phi-sync-board`; we iterate the listed keys. Sequential DELETEs keep the coordinator modest; each failure is logged + counted but doesn't abort the rest. Final toast: `Cleared N messages` on success, `Cleared; K deletes failed (see console)` on partial. New keys landing mid-drain (from another machine) intentionally survive to the next refresh.

### Fixed
- **Markdown panel stale when clicking between same-context tabs** (`n0mad-awx/#11`). `switchTab`'s final branch (workspace/coder/cwd unchanged, e.g. two agent tabs on one repo) used to refresh nothing; now does a silent, non-flickering refresh. Root cause of the "even a forced refresh looked stale" half: `MarkdownManager` cached `lastRefreshCwd` and skipped re-fetching for an unchanged cwd even though directory *contents* change constantly — removed in favor of a content-diff silent mode (`refreshFiles({silent:true})` skips the re-render, not the fetch, when the fetched list is byte-identical to what's shown).
- **Config-pill UX** — the v0.13.0 settings-modal commit replaced the `<span class="pill-label">Config</span>` with a `<button class="pill-btn pill-label-btn">Config</button>` that forced 22×22 icon-button sizing on a text label. Restored the span; wired click on the parent `.header-config-pill` div with an early-return when the target is an export/import sub-button; `cursor: pointer` + a glassmorphism hover lift (6% white tint + 1px accent edge + outer accent-glow + inner accent-trace + `backdrop-filter: blur(8px) saturate(160%)`); unhovered state stays byte-equivalent to the v0.2.2 `ba8a290` original.
- **Settings modal layout** — `.settings-swatch-grid` had `flex: 1 1 auto` + `justify-content: flex-end`, which grew the grid to fill the row then packed its 8 swatches to the right of the grown container, leaving ~150 px of empty space between the "Highlight color" label and the swatches. Changed to `flex: 0 0 auto`; dropped the `justify-content: flex-end`. `.settings-modal` now carries `overflow: hidden` so body scrolling stays inside the rounded border.
- **Diff/status/log no longer dumps git stderr in non-git workspaces.** A 5–10 ms workspace-level `git rev-parse --is-inside-work-tree` probe (`pkg/gitutil.IsGitRepo`) short-circuits the raw and streaming git endpoints before any `git diff` / `git status` / `git log` subprocess runs. Raw endpoints emit body `NOT_GIT_REPO`, the streaming endpoint emits `{"notGitRepo":true}`, and the diff panel detects either sentinel and writes a single muted-gray line — `Not a git repository — the diff/status/log is empty for this workspace.` — instead of a giant red error toast. Other git errors (corrupt `.git`, permission denied, etc.) still surface as 500 with stderr.

### Changed
- **Ctrl+Shift+X shortcut chip is now a strict subset of preset-btn** (`web/terminal.js`, `test-js/piShortcutChip.test.js`). The chip used to carry `id="pi-shortcut-send-btn"`, a `title` attribute, and a verbose `Ctrl+Shift+X · send` label with mixed casing + separator — all properties that no other `preset-btn` in the row has. Now: bare `preset-btn` class, `innerText = 'ctrl+shift+x'` matching the existing binding convention (`ctrl+c`, `ctrl+o`, `esc` — lowercase, no separator, no action-verb suffix), no id, no title. The keyboard binding itself stays global; the chip is pure discoverability. Test was rewritten to find by content rather than by id, with a new case locking in the strict-subset invariant (`chip.id === ''`, no title, `className === 'preset-btn'`).

### Tests
- **`pkg/fswatch/watcher_test.go`** (new) — 7 cases: create/remove `.md` fires, non-`.md` filtered out, a nil `Filter` matches everything, a burst of 5 creates debounces to one event, a directory created after `Start()` gets armed by the rearm ticker, `Close()` is idempotent.
- **`pkg/ws/hub_test.go` `TestBroadcastAll`** (new) — two panes, two clients, one `BroadcastAll` call reaches both.
- **`test-js/mdChangedRefresh.test.js`** (new) — 5 cases: silent skip on identical data, silent re-render on changed data, `onExternalChange` debounce, dir-filter (ignores events outside the browser's own markdown dirs), silent refresh never shows the `Scanning...` placeholder.
- **`test-js/wsMdChangedFrame.test.js`** (new) — 2 cases: `0x07` frame decodes to `onControl({type:'md-changed', ...})`; a malformed payload logs and doesn't throw.
- **`test-js/syncClearAll.test.js`** (new) — 5 cases: renders the button, empty-list short-circuit, non-empty sweeps + refresh, cancel leaves alone, partial failures toast a warning.
- **`pkg/gitutil/repo_test.go`** (new) — 4 cases: real repo via `git init`, empty tempdir, non-existent nested path, empty-string dir.
- **`test-js/diffNotGitRepo.test.js`** (new) — 4 cases: raw-diff sentinel, raw-status sentinel, streaming JSON flag, regression guard on non-sentinel content.
- **`test-js/piShortcutChip.test.js`** — rewritten to find chip by content + new strict-subset invariant case.
- **`main_test.go` `TestHandleRawDiff_CancelledContext`** — assertion updated to "git fatal-stderr never reaches the wire" (covers both new sentinel path and old 500 + ctx-error path).
- **`test-js/attentionToastGoToTab.test.js`**, **`test-js/tabHieroPreview.test.js`**, **`test-js/nonDirectKeyRedirect.test.js`** — landed with their respective PR cherry-picks (not part of v0.14.2 specifically).

## v0.14.1 — 2026-07-22

Patch batch from `n0mad-awx`'s air-updates PR: two tab UX polish items, a terminal input regression, a Vite-based frontend dev live-reload setup, and dev-workflow docs. The batch deliberately excludes the k8s-health, tracing, and claude-detection changes already in v0.14.0; the gofmt + rename-tabs commits in the same PR were skipped because v0.14.0 already has them. Just the new five below.

### Added
- **Tab hover card with busy/idle status.** The tab hover tooltip now shows the full session title (not the truncated tab-label form) plus a small busy/idle glyph so you can see at a glance which tabs are doing work. Falls back to coder name when the title is empty, matching the existing renamer semantics.
- **Vite dev server for frontend live reload.** New `vite.config.js` proxies `/api` and `/ws` from `localhost:5173` to the Go binary on `:7070` (or `$PHI_PORT`). `npm run dev` runs the server; HMR triggers on `web/**` edits and on the `web-src/*.ts → tsc → web/*.js → reload` chain. Dev-only overlay: production remains tsc → committed `web/` → `go:embed`. `vite@^5.x` matches vitest 2.1.8's peer range. README grew an 8-line Dev Workflow section.

### Fixed
- **Tab hiero preview no longer replays on intra-tab mouse movement.** The hieroglyph glyph preview animation used to restart every time the cursor moved inside the same tab strip region, even when the cursor didn't cross a tab boundary. Now the animation only restarts when the pointer actually enters a different tab, so the hiero no longer flickers when the user is dragging the cursor along the tab bar.
- **Terminal: prevent double character on first keystroke after click.** Clicking into the xterm canvas to focus no longer causes the first keypress to be delivered twice — the focus + keydown events used to race into two separate handlers, both sending the character to the PTY. Single delivery now.

### Tests
- **`test-js/tabHieroPreview.test.js`** (new) — asserts the preview animation does NOT restart on intra-tab mouse moves and DOES restart on cross-tab boundary crossing. 194 lines, 8 cases.
- **`test-js/nonDirectKeyRedirect.test.js`** (new) — covers the keyboard-routing state machine for non-direct-mode tabs (staged input redirects the focused-tab's arrow keys to its PTY). 44 lines, 4 cases.

## v0.14.0 — 2026-07-21

Five PRs cherry-picked from `n0madsky`: a gofmt CI gate (without the `.gitattributes` CRLF-forcing), k8s-friendly liveness/readiness probes with a real graceful shutdown, inline-renameable terminal tabs (double-click), a forward-encoding fix for Claude-session discovery that closes a path-decoding lossiness bug, and a 12-commit structured-logging + opt-in OpenTelemetry tracing pass.

### Added
- **k8s-friendly health probes + graceful shutdown.** `GET /livez` (alias `/healthz`) — always-200 dependency-free liveness. `GET /readyz` — returns 503 while `shuttingDown.Load()` is true. New `Manager.BeginDrain()` / `Manager.Shutdown(grace)` reject new PTY spawns during the drain window (with a new `ErrShuttingDown` sentinel) then SIGTERM each child, wait bounded by the grace, and force-kill stragglers. The signal handler routes SIGTERM/SIGINT through a new `gracefulShutdown()` that flips readiness → sleeps the drain delay (env-tunable `PHI_SHUTDOWN_DRAIN`, default 0 so local Ctrl-C is unchanged) → flushes state → broadcasts the WS shutdown frame → terminates PTYs → `Server.Shutdown(ctx)` per listener. The README flags table grows three rows.
- **Rename live tabs by double-clicking the title.** New `Manager.SetTitle` (mirrors `SetPinned` / `SetMarked`: `m.mu` for the lookup, `inst.mu` for the field write, `scheduleSave` for disk persistence). New `POST /api/terminals/:id/title` endpoint with the same 404 / 400 / 200 contract its siblings use. Frontend `openTabRenamer` / `syncBackendTitle` in `TabManager` swap the title span for an inline input on double-click; Enter or blur commits, Escape or an empty value reverts; titles escape through `escapeHtml` at both render sites so a user-typed title can never inject HTML on re-render.
- **Structured logging + optional OpenTelemetry.** Migrates the ~30 `log.Printf` sites to stdlib `log/slog` with a `--log-level` flag (`PHI_LOG` env var) and `PHI_LOG_FORMAT=json`. WebSocket log lines carry a `pane` key; HTTP request log lines carry `route` / `status` / `duration_ms` via a `pkg/obs` façade (otelhttp under `-tags otel`, no-op otherwise). Real spans exported via `--otel-endpoint` when built with `go build -tags otel`. `ctx.Context` is threaded through PTY spawn, DB, git worktree, and clipboard paths so spans have causal attribution across boundaries. New `pkg/obs` (`obs_noop.go` / `obs_otel.go` / `obs_test.go`) and `pkg/obs/{obs_noop,obs_otel}` files compile in their build-tag lane so the shipped binary stays dependency-free. `/api/diag` grew mem/goroutine/PTY snapshots plus frame-trace alloc guard for the WS debug path.
- **gofmt + go vet CI gate.** `chore:` cherry-pick of the gofmt sweep (reformats 31 files; 4 CRLF→LF via gofmt itself) plus `gofmt` and `go vet` steps on the `test-go` job. `.gitattributes` was REVERTED locally — the user prefers no `.gitattributes` enforcement; the standardization happens once via gofmt, then relies on developer discipline and CI from there. CI enforces it for everyone else on every push.

### Fixed
- **Claude session discovery: forward-encoding cwd, not lossy decode.** `ListClaudeSessions` previously reversed `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` back into a path via `decodeClaudePath`, but the encoding is lossy (`/`, `.`, `_`, and `-` all collapse to `-`); a workspace at `/Users/me/code/dot_files` decoded to `/Users/me/code/dot/files` and the cwd filter dropped every session for that workspace. Now: forward-encode the requested cwd via the new `encodeClaudeProjectDir` (Claude's documented `[^A-Za-z0-9] → '-'` rule) and compare with `strings.EqualFold`. The transcript's own `cwd` field is the authoritative displayed path; `decodeClaudePath` is now only the last-resort fallback. Honors `$CLAUDE_CONFIG_DIR` for the new `claudeConfigDir` location.
- **Config-pill button regression.** The v0.13.0 settings-modal commit force-sized the pill label with the icon-button rule, which compressed `Config` into a 22×22 box. Restored the span, wired click on the parent `.header-config-pill`, with an early-return when the target is an export/import sub-button — primary `Config` affordance is unchanged visually, the whole pill just got a `cursor: pointer` + hover ring.
- **`/title` endpoint restored after pr5 clobber.** Each of pr5's 12 commits rewrote `main.go` and `pkg/pty/manager.go` wholesale (last-writer-wins on the file), which dropped PR #3's `/title` endpoint and PR #2's `BeginDrain` / `Shutdown` plumbing. Both were re-integrated as a follow-up commit (`feat(pty): BeginDrain + Shutdown + per-PTY cleanup`) so the k8s-health paths work and PR #3's test exercises the endpoint.
- **Gofmt fallout from the integration commit.** `main.go` and `pkg/pty/manager_test.go` were reformatted immediately after the integration commit so the new `gofmt` CI gate does not fail on this push.

### Tests
- **PR #2 coverage.** 3 tests in `pkg/pty/manager_test.go` for `BeginDrain` (rejects new spawns → returns `ErrShuttingDown`), `Shutdown` (graceful TERM + cleanup), and `Shutdown` against a SIGTERM-ignoring straggler (force-kill within the grace window).
- **PR #3 coverage.** `TestHandleFallback_Rename` covers 404 (unknown pane) / 400 (malformed body) / 200 (mutated).
- **PR #4 coverage.** `pkg/session/claude_detection_test.go` adds hermetic + property + fuzz cases for the new `encodeClaudeProjectDir` and the EqualFold match.
- **PR #5 coverage.** Logging migration smoke tests, `pkg/obs` noop vs otel-build-tag parity, diag-snapshot test, WS `frame-trace` benchmark proving the alloc-free guard stays alloc-free at Info level.
- **gofmt / vet CI gate.** New workflow steps fail the build on `gofmt -l` non-empty output or `go vet` non-clean.

## v0.13.0 — 2026-07-20

A defaults-and-discovery release: phi now binds to your local network (and Tailscale) by default instead of every interface, stores your prompt history with Alt+Up/Down recall, and surfaces everything appearance-related through a new Settings modal.

### Added
- **LAN + Tailnet default bind.** New `pkg/bindaddr.Detect()` walks `net.InterfaceAddrs`, returns loopback + every IPv4 address in RFC 1918 (10/8, 172.16/12, 192.168/16) + Tailscale CGNAT (100.64/10). Phi opens one listener per detected interface; `serveAll` runs them in parallel. The public internet is no longer reachable by default — use `--ip 0.0.0.0` to opt back in. Welcome banner prints each bound URL with a `local` / `LAN` / `Tailnet` label so you know which one to hit from your phone vs your laptop. `--ip lan` is the new default sentinel; `--ip <specific>` retains the single-bind behavior for explicit opt-in.
- **Prompt history with Alt+Up/Down.** `pkg/prompt_history` stores sent prompts to `~/.phi/prompt_history.json` (FIFO-capped at 100, filtered by cwd at recall time, atomic writes). Backend: `POST /api/prompt-history/append` and `GET /api/prompt-history/recent?cwd=…&n=…`. Frontend: `sendStagedInput` fire-and-forgets the append call before clearing the textarea; new `_initPromptHistoryKeydown` listens for Alt+ArrowUp/Down on the staged input and walks the in-memory cache, restoring the pre-cycle draft when you cycle back past the newest entry. Typing any character resets the cycle cursor.
- **Settings modal.** The header `Config` pill label is now a button that opens a centered modal with: a 22-swatch accent grid sourced from `ACCENT_COLORS` (replaces the old `#accent-color-select`), UI font selector (System / Inter / Segoe UI / Helvetica Neue / mono-stack), UI font size (10–24, clamped server-side), terminal font input (live-applied to all xterm instances via the new `applyFontToAllActiveTerminals` — no scroll-timing code touched), a "Reuse shell tab for terminal commands" toggle, and an About group showing the Φ logo + version + commit + hostname + workspace count. Settings are live-applied (no Save button); font changes persist on a 300 ms debounce to the new `POST /api/config/appearance`. Dead DOM removed: `.theme-area` div + select + both CSS blocks.

### Tests
- **bindaddr coverage.** 10 unit tests on `Detect()` and the LAN/Tailnet/public/link-local classification, plus 4 main-package tests for `serveAll` (multi-listener) and the new welcome banner.
- **prompt_history coverage.** 7 store tests (round-trip persistence, FIFO eviction, cwd filtering, n-limiting, empty-skip, missing-file, corrupt-file, concurrent append safety with 8 goroutines × 5 writes) + 5 handler tests + 12 vitest tests for the frontend cycling (Alt+Up/Down, cursor semantics, send-side append).
- **appearance coverage.** 6 Go tests for `/api/config/appearance` (persist, partial update, size clamp boundaries, method enforcement, garbage-body rejection, config-response surfacing) + 16 vitest tests for the modal (swatch count + click → `applyAccentTheme` path, live font apply + debounced persist, close via ×/Escape/overlay, version-block render from cache, dead-DOM regression guard).
- **Race-safe mutex discipline.** `Store.mu` is held across both filter+sort in `Recent()` and across the eviction+persist in `Append()`; the test concurrent-append case pins the invariant.

## v0.12.1 — 2026-07-16

Hotfix: the v0.12.0 default-to-direct focus change was too broad — AI-coder tabs (pi, claude, agy, opencode) lost their staged input bar / attachment strip / presets row, breaking the core phi workflow.

### Fixed
- **Per-coder focus default.** Shell tabs (bash, pwsh) and btop (registered with `coder: "bash"`) now default to focused/direct mode so the terminal gets keystrokes immediately. AI-coder tabs (pi, claude, agy, opencode) keep the staged-input flow as default — the input bar, attachment chip strip, presets row, and Ctrl+Shift+X chip are visible without an extra click. Click the direct-mode toggle to flip either way.

### Tests
- **Session persistence round-trip proven.** New `pkg/session/sessions_persist_test.go` round-trips a 3-entry `SessionMeta` map through `SaveSessionMetaMap` and `LoadSessionMetaMap`, asserts the file lives at `~/.phi/sessions.json`, and covers empty + corrupt file paths. Surfaces and fixes a latent bug: a corrupt `sessions.json` previously returned an empty map with no error, silently wiping the user's prior state on server restart. Now the loader returns `(empty map, error)` so the caller can surface a toast.
- **Tab restoration end-to-end proven.** New `test-js/tabsRestore.test.js` covers `restoreTabsState` against a mocked `/api/terminals` — GETs the endpoint, calls `createTab` once per server entry in order, forwards pinned/marked flags, shows the empty state when the server has zero terminals, sweeps the legacy `phi_tabs` localStorage key, calls `applySavedTabOrder` for user reorder, restores `phi_active_pane`, falls back to the first tab on missing pane, survives a non-OK server response, falls back to the coder name when the entry has no title.
- **Per-coder default pinned.** New `test-js/directModeDefault.test.js` mirrors the production predicate (`bash | pwsh → focused`) so the contract is locked and any new coder defaults correctly.

## v0.12.0 — 2026-07-16

A UI-density release. Tighter hover popovers, fewer layout-shift regressions, and clipboard round-trip for markdown files.

### Added
- **Self-state HUD on hover/focus the Φ logo.** Cartouche-shaped glass popover in the top-left showing hostname, version, sessions, busy, attention, CPU, last activity. Zero network on open or close — every field computed from local state phi already maintains. CPU-driven emphasis glows the cpu line at high load, pulses at critical. Touch users get click-to-toggle; keyboard users get Escape-to-close.
- **Markdown clipboard export/import.** 'Export' button in the markdown panel packs every .md file in the configured dirs into a tamper-detected gzip+base64 blob (PHIMD:…); 'Import' reads it from clipboard (or prompts) and writes files into the first configured markdownDir. Path-validated server-side. Click → clipboard → click.

### Changed
- **Terminal default to direct (focused) mode.** New tabs and restored tabs open with keyboard going straight to the terminal — no separate input bar, no presets row, no file-attach strip visible. Click the direct-mode toggle in the header to opt into the staged input flow. Direct mode is implicit on the workspace landing.
- **Pi Ctrl+Shift+X shortcut chip uses preset-btn shape** instead of the heavy kbd-key+glow aesthetic. Sits flush alongside /quit /resume /model /compact in the presets row.
- **Markdown file-list icon is a standard document SVG.** The 𓏛 hieroglyph that depended on a system font (and rendered as tofu on systems without one) is replaced with a 14 px lucide 'file' SVG. The decorative papyrus-scroll styling moves to the markdown VIEWER modal header where there's room for it.
- **Clipboard-image attachment sweep keeps the 20 most recent files** in `~/.phi/clipboard/` (was 50 — generous for a session's typical attachment load).
- **Rich diff viewer wraps long lines on mobile.** Forced to line-by-line layout already (mobile-only); inside the `@media (max-width: 768px)` block each `.d2h-code-line` now wraps with `white-space: pre-wrap` / `word-break: break-word` / `overflow-wrap: anywhere`. Line-number column pins to `vertical-align: top`. Desktop bit-identical.

### Fixed
- **Terminal scrollbar matches content on PTY output.** xterm's native syncScrollArea leaves the scrollbar stale when only PTY output grows (no layout reflow). A `userFollowBottom` flag now gates an explicit `term.scrollToBottom()` on each output write — the same sync the user accidentally triggered by typing in the input bar. Wheel/touch/pointerdown disengage follow; scrolling back to the bottom re-engages; the existing `Jump to bottom` button is the explicit re-engage path.
- **Paste into the input bar no longer reflows the textarea row.** The attachment chip strip had `width: 100%` inside the same flex container as the textarea, fighting it for row width. The strip is now its own row above a new `.input-bar-row` wrapper for textarea + actions.
- **Brand HUD popover escapes `.app-header`'s stacking context.** Popover reparented to `<body>`, switched to `position: fixed` + `z-index: 9999`, and top/left computed from the brand's bounding rect on every open/scroll/resize. Otherwise `.diff-panel` and `.modal-overlay` were covering it.
- **HUD closes when the cursor enters `.hostname-wrapper`.** Otherwise the HUD and the hostname tab-selector dropdown would coexist visually when the cursor drifted from the logo onto the hostname area.
- **HUD race + white-theme popover.** Click toggle on mouse-driven devices is now touch-only (gated via `(hover: none)` media query). 200ms reopen cooldown after every close — mouseenter/focus within that window is ignored, so cursor jitter doesn't flicker the HUD back open. White-theme overrides removed; popover uses theme-independent obsidian glass so it doesn't collapse into the header on light themes.
- **Drag-drop is page-wide, not just the input bar.** Drop handler moved to document level so dropping on the terminal pane (where the cursor usually is) also captures the file. Skips `.tab` elements (per-tab drop is for tab reorder). Visual feedback (input-bar glow) now shows whenever a file drag is anywhere on the page.

### Notes
- The 10 ms / 300 ms `_spamScroll` terminal stabilization loop remains unchanged. AGENTS.md canonically guards this loop; see the "Terminal scroll stabilization loop — do not infer it away" section.
- The new HUD shortcut chip placement, like all conditional UI changes, follows the "UI action and shortcut contract" section: Send ↵ remains visible for every staged-input coder; the chip is additive discoverability, never a substitute.

## v0.11.0 — 2026-07-16

A content-density release: more visual information at glance, fewer file-finding rituals before asking the agent.

### Added
- **Drag-drop and clipboard-image attachments into the staged input.** Drop a file (or paste a screenshot) onto the input bar to attach it to the next Send. Both paths converge on a single `/api/attachments` endpoint (image/* MIME allowlist, 25 MB cap, server-generated unique filenames, automatic 50-file sweep in `~/.phi/clipboard/`). Vision-capable coders receive paths in their preferred mention syntax: `@/path` for Claude / OpenCode / Antigravity, raw path for pi / bash / pwsh. Send with empty text + an attachment now works — the previous empty-guard was relaxed.
- **Self-state HUD on hover/focus the Φ logo.** Cartouche-shaped glass popover in the top-left shows hostname, version, sessions, busy, attention, CPU, and last activity. Zero network on open or close — every field is computed from local state phi already maintains. CPU-driven emphasis glows the cpu line at high load, pulses at critical. Touch users get click-to-toggle; keyboard users get Escape-to-close.

### Changed
- **btop and shell tabs no longer pin the global "working" indicator.** The curly-Phi ϕ glyph in the browser title and the ▍ indicator in the header now reflect *agent* activity, not *terminal* activity. A running btop can no longer hold the chrome lit forever. Both the global indicator (`getTerminalActivityState` in `web-src/util.ts`) and the sidebar session-row ankh/djed glyph respect the exclusion.
- **Pi Ctrl+Shift+X shortcut chip moved into the presets row.** Sits alongside /quit /resume /model /compact / ⚡ Cmds ▾ / 🤖 Models ▾ instead of crowding the primary Send ↵ button. Construction is now driven by `renderPresets()` keyed on the active tab's coder, so the chip appears exactly when the user is in a pi session.
- **Rich diff viewer wraps long lines on mobile.** Forced to `line-by-line` layout already (mobile-only); inside the `@media (max-width: 768px)` block each `.d2h-code-line` now wraps with `white-space: pre-wrap / word-break: break-word / overflow-wrap: anywhere`. The line-number column pins to `vertical-align: top` so wrapped rows stay aligned. Desktop CSS and JS untouched.

### Notes
- The 10ms / 300ms `_spamScroll` terminal stabilization loop remains unchanged. AGENTS.md canonically guards this loop; see the “Terminal scroll stabilization loop — do not infer it away” section.
- The new shortcut chip placement, like all conditional UI changes, follows the “UI action and shortcut contract” section: Send ↵ remains visible for every staged-input coder; the chip is additive discoverability, never a substitute.

## v0.10.1 — 2026-07-15

A focused terminal-control reliability release.

### Fixed
+- **User scroll wins over stale restoration.** The established 10ms/300ms terminal stabilization loop remains intact, but a real wheel, touch, or scrollbar gesture now cancels an already-pending stale line restore instead of snapping output back to an earlier position.
+- **Mobile scroll position.** Generic page scrolling no longer resets the document to its origin; only input-focus keyboard handling corrects iOS focus-scroll.
+- **Exact terminal bottom state.** A viewport one line above xterm's live bottom is no longer reported as being at bottom.
+- **Close behavior.** Intentional tab finalization no longer produces a disconnect banner, and the Undo grace after closing a tab is now three seconds.
+- **Staged input.** The visible `Send ↵` control remains available beside the pi shortcut.
+
+### Maintenance
+- CI uses the current Node 24 and matching current GitHub Actions releases.
+
+## v0.10.0 — 2026-07-14

A stability-and-signal release: phi is now clearer about live terminal output,
and the browser client has a durable TypeScript source pipeline.

### Added
- **Live terminal chrome.** The browser title and favicon use `Φ` while every terminal is quiet and `ϕ` while any live terminal is producing output. The header's former passive `—` before the hostname now becomes a subtly glowing terminal cursor (`▍`) during output. The existing leading `●` remains reserved for completion/attention, so combined states read as `● ϕ host`.
- **TypeScript source pipeline.** Seven browser modules now live in `web-src/` as strict TypeScript and emit committed browser ESM into `web/`. CI typechecks, builds, and rejects source/artifact drift, while clone-and-build users still need no Node toolchain.

### Fixed
- **Restart no longer leaves zombie tabs.** Browser-local tab references are cleared when phi detects a new server process, avoiding dead tabs after restart.

## v0.9.2 — 2026-07-14

Polished theme details for the obsidian glassmorphic and Greek-Egyptian visual style.

### Added
- **Focus breathing on input textarea.** Focus glows now pulse gently with a 4s ease-in-out breathing animation, mimicking organic torchlight rather than static digital borders.
- **Active tab inner top light.** Added a subtle radial accent glow to the inside top edge of active tabs, giving them a polished light-catching feel.
- **Header button hover beacons.** Hovering over header action buttons casts a soft radial glow underneath, adding visual depth.
- **Active coder tab accent sliver.** The active coder tab now has a thin accent-colored bottom border to unify it with the main terminal tabs.
- **Session list active indicators.** The active session dot is now the Egyptian Ankh (`☥`), U+2625, indicating "running/active" status. Active session items also receive a deeper inset highlight.
- **Tomb-wall inscription registers.** Replaced the scattered, random empty state hieroglyphs with structured top and bottom inscription registers, lowering opacity to 0.045 and disabling all fade/drift animations for a static temple-wall feel.
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