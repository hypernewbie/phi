# React frontend parity and component inventory

## Stage 02 status

**Date:** 2026-10-20. **State:** `in-review`, not integrated.

Stage 02 implements a development-only Connection shell, two shared controls, and an isolated browser/manual-session fixture.
The user requested Playwright restoration. Unit/static/build gates and all 26 React Playwright cases passed after restoration.
The October 20 review found lost keyboard focus after Retry. The user authorized the focused fix and its execution with `gpt-6.1-sol`.
The fix now passes Chrome DevTools, 36 Playwright cases, and all unit/static/build gates.
Safari, VoiceOver, and manual 200% zoom checks remain pending.
The Go frontend remains embedded, shipped, and default. This foundation does not establish feature parity.

| Reference | Value |
| --- | --- |
| Approved parity baseline | `dd94bbf78c4cc9f23b6d77d1e695244ba175dbbb` (October 4) |
| Implementation and contract baseline | `64fdea38c410bc4d321c9b216bb7d4f32cb59c4f` |
| Branch | `stage-02-foundation` |
| Worktree | `/Users/n0mad/code/phi-worktrees/stage-02-foundation` |
| Execution brief | `/Users/n0mad/code/phi/plan/stage-02-foundation.md` (ignored, outside this worktree) |
| Master plan | `/Users/n0mad/code/phi/plan/2026-08-24_02-52-07_frontend-migration.md` (ignored) |
| Authorization | User supplied `EXECUTE`, then required direct execution in the same session without subagents. |

The user authorized the foundation commit `1acc148` and a separate reviewed Playwright restoration commit.
No integration, fetch, rebase, push, publication, or device deployment occurred.
Stage 03 requires its own authorization, reviewed Stage 02 integration, and the landed auth transition.

The revised brief includes the user-authorized Playwright restoration.
Root changes include workspace, dependency, test/typecheck/lint, ignore, and CI configuration.
All 44 legacy browser-test/configuration files match the pre-removal base byte for byte. The legacy CI job is restored.
Unit/static CI jobs retain installation of root tooling and both new packages before their combined checks.
New files occupy `packages/phi-core/`, `packages/web-react/`, and this document.
Legacy/Go/desktop runtime code and root source/build TypeScript configurations remain unchanged. The index is empty.

## Architecture and ownership

`@phi/core` exports an empty TypeScript module. Its source compiler excludes DOM and ambient Node types.
It has no runtime dependencies. Future stages introduce contracts only for actual consumers.

`@phi/web-react` is a private Vite application, not a library.
It has no production build script. Its HTML entrypoint loads package-owned fonts and `src/main.tsx`.
The bootstrap creates the root and HTTP service. `App` owns typed screen selection.
`ConnectionScreen` receives the service and owns request generations, pending state, cancellation, and conditional Retry focus restoration.
Shared controls own their markup and CSS Modules. They do not access services or feature state.

Only `src/platform/http.ts` performs browser networking and timeout work.
It requests `GET /api/auth/v2/status` with omitted credentials and rejected redirects.
Only HTTP 200 with boolean `enabled` and `authenticated` fields produces a connection result.
Enabled protection always produces the protected presentation, even with `authenticated:true`.
HTTP 404/405 means unsupported v2. Other failures mean unavailable.
Caller cancellation and obsolete generations cannot replace the current status.
The adapter aborts its owned request before every return, including errors with unread response bodies.
There is no login, v1 fallback, restored session, storage, protected operation, or automatic polling.

Vite binds `127.0.0.1:5173` with a strict port.
The validated `PHI_PORT` selects the loopback backend, with 7070 as the development default.
The fixture supplies its own backend port. It never relies on a real server at 7070.
Public proxies match only `/help.md` and `/changelog.md` and strip Authorization and Cookie headers.
API and WebSocket proxies preserve Host/Origin. The React Playwright suite checks a real Go `/ws/md-events` upgrade through Vite.
The same-origin request returns 101. A foreign-origin request returns 403.
Automatic environment-prefix exposure is disabled. Only the upstream-origin constant enters the app.

## Component inventory

Source anchors in this table refer to the implementation baseline, unless another commit appears explicitly.
The conversion uses existing Phi patterns without importing the legacy stylesheet or managers.
`R` means `packages/web-react/` in the following tables.

| Component owner | Phi source/style anchors | Props and supported states | Actual consumers | Automated and visual evidence | Manual evidence |
| --- | --- | --- | --- | --- | --- |
| `R/src/components/ui/Button.tsx`, `button.module.css` | `web/style.css`: `.btn`, `.btn-primary`, `.btn-accent`, including later overrides. `web/index.html`: New Session and workspace action buttons. | Native button props and ref. `variant: primary \| accent`, `busy:boolean`. Defaults: primary, not busy, `type=button`. Enabled, hover, focus-visible, disabled, busy. Derived disabled/busy states take precedence. | `App` Connection navigation uses primary. `ConnectionScreen` Retry uses accent. | `test/ui/button.test.tsx`, `test/app.test.tsx`, `test/e2e/connection.spec.ts`. Labels, ref, activation, disabled/busy behavior, custom-prop omission, 36 px height, 13 px text, keyboard focus, and reduced motion. Chromium desktop/narrow/320 px captures are available. | Safari keyboard, zoom, and VoiceOver pending. |
| `R/src/components/ui/StatusMessage.tsx`, `status-message.module.css` | `web/auth.js`: `showUnlockPrompt`, `.access-auth-error` construction. `web/style.css`: `.access-auth-error` and Phi status colors. | Required `kind: loading \| success \| warning \| error`, `children:ReactNode`. Stable polite atomic status container. Text plus a colored marker, no automatic focus or alert. | All five Connection presentations. | `test/ui/status-message.test.tsx`, `test/app.test.tsx`. Stable node, escaped text, no focus movement, stale results ignored. | VoiceOver announcement count and initial status pending. |
| `R/src/App.tsx`, `app.module.css` | `web/index.html`: `.brand`. `web/style.css`: `:root`, `.app-header`, and later header overrides. | Injected `ConnectionService`. Typed `connection` selection. Semantic header, named navigation, and main landmark. | Bootstrap and mounted App tests. | Strict Mode cleanup, root-only DOM changes, landmarks, and named current-page button. Chromium desktop/narrow/320 px captures are available. Safari appearance remains a manual check. | Safari landmarks and focus visibility pending. |
| `R/src/screens/ConnectionScreen.tsx`, `app.module.css` | `web/style.css`: `.access-auth-dialog` geometry. `web/auth.js`: auth-card text hierarchy. This is a new nonmodal screen, not a converted login dialog. | Injected service. Loading, disabled-protection, protected, unsupported, unavailable. Explicit Retry. Cancellation and stale-result suppression. | `App`. Reuses Button and StatusMessage. | `test/http.test.ts`, `test/app.test.tsx`. Response fixtures and state transitions. `test/e2e/connection.spec.ts` checks real unsupported-v2 behavior and mocked v2 response states. | Safari reflow/zoom and VoiceOver pending. |

Tokens live in `R/src/styles/tokens.css`. The small reset and body/font rules live in `global.css`.
The spacing scale is 4/8/12/16/24 px. Control styles remain in their component modules.
The Connection card preserves the 360 px width, 22 px padding, and 10 px radius of the existing auth card.
It is a section, not a modal dialog. No dialog containment or focus trap applies.

### Intentional accessibility differences

- Accent buttons use white text on `#5b4ec2`, not white on the lighter legacy accent.
- Card/status text uses `#e4e3e9`, not muted text on an elevated background.
- Primary buttons use a visible muted-color boundary. Accent buttons retain the purple outer boundary.
- Buttons have an authored focus-visible outline and native disabled/busy behavior.
- Statuses communicate their meaning through text, not color alone.
- The shell permits wrapping and vertical scrolling. It does not copy legacy viewport clipping.
- Nonessential button transitions stop under reduced motion.

The following ratios use sRGB token values, not antialiased screenshot pixels.
These calculations do not establish full accessibility conformance.

| Foreground or marker | Background | Contrast ratio | Use |
| --- | --- | --- | --- |
| `#e4e3e9` | `#141418` | 14.4034:1 | Card and normal button text |
| `#e4e3e9` | `#1f1f26` | 12.8393:1 | Primary hover text |
| `#ffffff` | `#5b4ec2` | 6.3375:1 | Accent text, default and hover |
| `#78768a` | `#141418` | 4.1618:1 | Primary boundary, not normal text |
| `#78768a` | `#1f1f26` | 3.7098:1 | Primary boundary on hover |
| `#7c6af7` | `#141418` | 4.6034:1 | Outer accent boundary and separated focus outline |
| `#9a8dfa` | `#141418` | 6.6180:1 | Loading/warning marker |
| `#f87171` | `#141418` | 6.6420:1 | Error marker |
| `#38bdf8` | `#141418` | 8.5763:1 | Success marker |

The card outline and header separator are decorative. They do not identify an interactive target.
The React Playwright suite checks Chromium target geometry, 320 CSS px reflow, native keyboard behavior, and reduced motion.
Manual Safari, 200% zoom, and VoiceOver checks remain pending. Chromium evidence does not establish cross-browser or screen-reader behavior.

## Dependency inventory

Versions and licenses below come from installed package metadata and `pnpm-lock.yaml`.
The lockfile contains new importers for both packages. Playwright 1.63.0 and its catalog entry are restored.
Other existing root/desktop resolutions remain unchanged.
Both root tooling and the React package declare `@playwright/test` through the existing catalog.
The install also refreshed Plyr's deprecation metadata. This stage neither introduces nor upgrades that legacy dependency.

| Package | Version | License | Owner / lockfile role |
| --- | --- | --- | --- |
| `@phi/core` | `0.0.0` | Project source | Private workspace package. React importer uses `link:../phi-core`. |
| `react` | `19.3.1` | MIT | React runtime, exact app pin |
| `react-dom` | `19.3.1` | MIT | React runtime, peer React 19.3.1 |
| `@types/react` | `19.3.0` | MIT | App development types |
| `@types/react-dom` | `19.3.0` | MIT | App development types, peer React types 19.3.0 |
| `vite` | `8.3.0` | MIT | App development server, existing resolution |
| `typescript` | `7.0.2` | Apache-2.0 | Both packages, existing catalog |
| `vitest` | `5.0.1` | MIT | Both packages, existing catalog |
| `@types/node` | `24.13.6` | MIT | Both packages' tools/tests, not core source globals |
| `jsdom` | `30.1.1` | MIT | App mounted tests, existing catalog |
| `@playwright/test` | `1.63.0` | Apache-2.0 | Root and app browser tests, restored catalog |
| `playwright` / `playwright-core` | `1.63.0` | Apache-2.0 | Restored browser-runner dependencies |
| `@vitest/coverage-v8` | `5.0.1` | MIT | Existing root coverage tool |
| `@biomejs/biome` | `2.5.14` | MIT OR Apache-2.0 | Existing root formatter/linter |
| `csstype` | `3.2.3` | MIT | Transitive React types |
| `scheduler` | `0.28.0` | MIT | Transitive React DOM runtime |

No React plugin, styled library, state store, terminal package, or additional test framework enters this foundation.

### Font provenance and hashes

Fonts and `fonts.css` match `web/vendor/fonts/` at the implementation baseline, byte for byte.
The original vendoring commit is `f21400bf157d89ba3caad678c6e106312ee0ee9c`.
Inter and JetBrains Mono use SIL OFL 1.1. All 13 Unicode-subset files remain present, including Greek.
The app loads `/fonts/fonts.css`. It needs no font CDN, host-installed font, or Go font proxy.

The package includes the following immutable upstream notices, including their copyright statements:

- [Inter notice](https://raw.githubusercontent.com/google/fonts/b0928647ba26c8d55548aa19feb2f7aeba622d4a/ofl/inter/OFL.txt) → `R/public/fonts/OFL-Inter.txt`.
- [JetBrains Mono notice](https://raw.githubusercontent.com/google/fonts/2e05c1cf00a6e4f40a4b931600a90881c26e15cd/ofl/jetbrainsmono/OFL.txt) → `R/public/fonts/OFL-JetBrainsMono.txt`.

Paths below are relative to `R/public/fonts/`.

| File | SHA-256 |
| --- | --- |
| `fonts.css` | `6d4c08c10a52391f268146a43612ade1ccc132691a1eb04059a3b8464989b25a` |
| `inter-13755630d7.woff2` | `71d5ee93cc1e9f1d520a3a8b66456de18c7879d8df09d57fcd2eaff75fef0075` |
| `inter-3b78c6fa64.woff2` | `1be3448e292fbf05ffe176fe1e43f135013d50b1e7d324ad1a558f623d3bb6f6` |
| `inter-6ab57b19c6.woff2` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `inter-a375c31d43.woff2` | `ca157063339ac4ad418f214f3abfed119b0798ab4d377386ce5c9e5a7a435ebd` |
| `inter-b6db4a06c1.woff2` | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` |
| `inter-da72a9f738.woff2` | `6e9e020a25f9b56d418f2c085b1d3c09725a4da23fe693a5b463064606732190` |
| `inter-f059b71e05.woff2` | `5c66f9e07e90c6d4ac4922cc68d60de26c17b1858e677fb5e603fce3952b3ff2` |
| `jetbrainsmono-028edbf560.woff2` | `e17cfd15fb96909d64095015f958207063a0c07191da3512df7d560a781aebdf` |
| `jetbrainsmono-0a7197f9e2.woff2` | `83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be` |
| `jetbrainsmono-acf87d8659.woff2` | `c89b9cc0bc6262bd4f8d8494b6961601f3aefa829d08c2e3635f4d501d3a47c2` |
| `jetbrainsmono-c8b23d7bdf.woff2` | `db5ff4db83e580426280e9337a58dc57d3a83784a1b03ad80914651594441d52` |
| `jetbrainsmono-d2761cb6ca.woff2` | `62213be8a78b42f1e29d1452d91e2f8b3e745572a9dd98d3941e39fa00b37d76` |
| `jetbrainsmono-db1e206703.woff2` | `0a557721b1f8b36d3f3f84442689a71ca4a744300abcb46a1953f51bfc663b66` |
| `OFL-Inter.txt` | `5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57` |
| `OFL-JetBrainsMono.txt` | `b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d` |

Manual font checks must load Latin/Greek samples through both named families and request every WOFF2 URL with a cold cache.
A computed font-family value alone does not prove that a font loaded.
The October 20 Chrome DevTools review loaded both families with Latin/Greek samples and received all 13 font files successfully.
Safari font appearance remains pending.

## Feature parity matrix

Every source anchor in this matrix refers to the approved parity baseline, not the later implementation baseline.
`missing` means that this React app does not implement the outcome. Legacy availability does not count as React implementation.
A dash means no React evidence. Later stages must replace grouped rows with detailed outcomes as necessary.
The Stage 02 foundation is a new screen and is not a claim of converted full-shell parity.

| Required outcome | Source anchor | Owner | Status | Automated evidence | Desktop result | Narrow result | Remaining gap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Connection foundation and shared controls | Implementation baseline: `web/style.css` controls/auth-card, `web/index.html` brand | 02 | partial | Package unit tests; 36 Playwright cases; October 20 DevTools evidence | Chrome geometry/fonts/Retry focus pass | Chrome 390/320 px reflow and Retry focus pass | Safari/VoiceOver and manual zoom |
| Auth entrypoints, login, expiry, server-scoped persistence | `web/auth.js`, `web/config.html` | 03 | missing | — | — | — | Landed v2 auth and complete client behavior |
| Settings, appearance, configuration save/error outcomes | `web/settings.js`, `web/config.js`, `web/config.html` | 04 | missing | — | — | — | All configuration surfaces |
| Session/coder capability and workspace service contracts | `web-src/sessions.ts`, `web-src/coders.ts` | 05 | missing | — | — | — | Shared contracts and adapters |
| Session list/spawn/rename, coder and workspace selection | `web/index.html`: `#session-list`, `#coder-selector`, `#workspace-select` | 06 | missing | — | — | — | All session/workspace UI |
| OpenCode service start/status/stop controls | `web/app.js`, `web-src/coders.ts` | 06a | missing | — | — | — | Service UI and failure states |
| Pi control codec, hydration, ordered transcript state | `web/chat-pi/`, `web-src/chat-pi/` | 07 | missing | — | — | — | DOM-free client/store |
| Pi Chat prompt/abort/compact, sessions, fleet/transcript | `web/chat-pi/`, `web/index.html`: `#fleet-panel` | 08 | missing | — | — | — | Entire Chat screen |
| Kanban boards/tasks/details/metadata and ordered moves | `web-src/kanban.ts`, `web-src/kanban-features.ts` | 09 | missing | — | — | — | Entire board UI, accessible moves, rollback |
| Diff/status/commits, context, layouts, copy/maximize | `web-src/diff.ts`, `web/index.html`: `#diff-panel`, `#diff-modal` | 10 | missing | — | — | — | Typed parser, adapters, views |
| Diff review drafts and transcript handoff | `web-src/review-transcript.ts`, `web-src/diff.ts` | 10a | missing | — | — | — | Draft lifecycle and actions |
| File tree and workspace browsing | `web-src/filetree.ts`, `web/index.html`: `#file-tree-list` | 11 | missing | — | — | — | Entire file tree |
| Path autocomplete, browse, selection, validation | `web-src/path-picker.ts`, `web/index.html`: `#ws-modal` | 11a | missing | — | — | — | Reusable path picker |
| Text/JSON/image previews and file lifecycle | `web-src/file-viewer.ts` | 11b | missing | — | — | — | Preview states and actions |
| PDF/audio/video preview and authenticated transport | `web-src/file-viewer.ts` | 11c | missing | — | — | — | Renderer/transport decisions and evidence |
| Local/remote editor actions | `web-src/vscode.ts`, `web/index.html`: `#ft-vscode-local-btn`, `#ft-vscode-remote-btn` | 11d | missing | — | — | — | Explicit editor-launch intent |
| Markdown list/view/events, edit/paste/delete/copy/export/import | `web-src/markdown.ts`, `web-src/md-view.ts`, `web/md.html` | 12 | missing | — | — | — | Entire Markdown surface |
| Safe public Help and Changelog presentation | `web/help.md`, `web/changelog.md` | 12 | missing | Proxy transport only; no presentation | — | — | Rendered safe document entrypoints |
| Rich Chat/tool/extension transcript presentation | `web-src/md-render.ts`, `web/chat-pi/` | 12a | missing | — | — | — | Safe rich renderer |
| Directional terminal wire codec | `web-src/ws.ts` | 13 | missing | — | — | — | Shared byte/envelope contracts |
| Ordered terminal stream/state/history owner | `web-src/ws.ts`, `web/terminal.js` | 13a | missing | — | — | — | DOM-free effect ordering and recovery |
| Interactive terminal rendering/reconnect/history | `web/terminal.js`, `web/index.html`: `#terminals-wrapper` | 14 | missing | — | — | — | Dedicated xterm component/adapter |
| Tabs, switch/close/restore, saved terminal handoff | `web/terminal.js` | 14a | missing | — | — | — | Tab ownership and persistence |
| Staged input, explicit send, attachments/paste | `web/input.html`, `web-src/attachments.ts`, `web/index.html`: `#input-textarea` | 14b | missing | — | — | — | Input/attachment workflows |
| Sync list/send/read and incremental event outcomes | `web-src/sync.ts`, `web/index.html`: `#sync-panel` | 14c | missing | — | — | — | Entire Sync UI |
| Shell attention/status/help/version/admin/shortcut entrypoints | `web/header-state.js`, `web/app.js`, `web/help.md` | 14d | missing | — | — | — | Shell controls and explicit action intent |
| Complete feature/component evidence and accepted differences | All preceding anchors | 15 | missing | — | — | — | Final human parity review |

### Later scope candidates

These candidates are not automatic additions to the October 4 parity scope.
Current terminal wire compatibility remains mandatory for its later owning stage.

| Later candidate | Implementation-baseline reference | Owning stage / decision |
| --- | --- | --- |
| Browser-local low-power ownership | `config.go`, `test-js/lowPower.test.js` | 04 and terminal lifecycle, scope review |
| Workspace-grouped tabs | `web/terminal.js` (workspace-grouped tab navigation) | 14a, scope review |
| Selected-terminal reload and distinct close-all behavior | `web/terminal.js` (terminal toolbar actions) | 14/14d, scope review |
| Explicit older history and return to live | `web/terminal-history.js` | 14, corrected compatibility contract applies |
| Sync completion cards | `bfeb595`, `web/help.md` | 14c, scope review |

## Verification record

The following October 19 post-restoration commands ran from the authorized worktree. No check used a user server or auth worktree.
The October 20 Retry fix has a separate acceptance record below.
The local linker required command-scoped `SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"`.
The initial baseline test failed before implementation with incompatible SDK/TAPI architecture entries.
The final regression gates passed with the compatible SDK selection. No source or global toolchain configuration changed for that correction.

| Final command | Exit | Result |
| --- | --- | --- |
| `pnpm typecheck` | 0 | Legacy source/E2E and five package source/test compiler passes. |
| `pnpm test` | 0 | 202 files passed, 1 skipped. 2,572 tests passed, 2 skipped. Package subset: 9 files, 77 tests. |
| `pnpm lint:web` | 0 | Legacy stylesheet check |
| `pnpm check:code` | 0 | Existing and new included code |
| `pnpm check:vendors` | 0 | Existing vendored bytes unchanged |
| `pnpm build:web` | 0 | Legacy TypeScript emission |
| `pnpm --dir desktop/pet build` | 0 | Required pet build, after web build |
| `pnpm exec playwright test --config packages/web-react/playwright.config.ts` | 0 | 26 Chromium cases, desktop and narrow, 37.0 seconds including cleanup |
| `pnpm exec playwright test --list` | 0 | Legacy discovery: 86 cases in 39 files. No legacy cases executed. |
| `git diff --check` | 0 | No whitespace errors |

Restoration logs remain in ignored `test-results/web-react/restore/`, with per-command logs and `results.log` for the six W commands after typecheck.
`typecheck.log`, `browser.log`, and `legacy-discovery.log` record the other passing commands above.
Earlier implementation/review/cleanup logs are historical evidence, not the current acceptance run.
Deliberate core-test, React-TSX-test, and package-E2E errors failed root typecheck before removal. All probes are absent.
The restored compiler scopes cover all three test trees.

The active restoration probe checked six changed React source/config/test files. Only the isolated server helper had primary findings.
The five errors concern `ChildProcess.once` and inferred callback parameters in `test/e2e/phi-server.ts`.
Editor definition lookup resolves cached Node types 26.6.5 instead of the workspace's pinned 24.13.6.
The React E2E compiler pass includes the restored helper, resolves pinned workspace declarations, and passes.
Its resolution log is `test-results/web-react/editor-resolution.log`.
The five findings are recorded as environment false positives. The editor declaration discrepancy remains visible.
No source casts, suppressions, or dependency changes conceal it.

Nonfatal output includes existing lint/deprecation warnings, jsdom navigation output, and macOS deployment-target linker warnings.
All seven W commands and the React browser suite passed after restoration. Workflow YAML parsing and offline frozen installation also passed.
Hosted CI did not run.

A pre-restoration nine-path scan found no primary language-server errors.
That scan reported 12 existing unpinned-action errors and 24 existing policy/security warnings through auxiliary analyzers.
These concern unchanged action tags, workflow credentials/permissions, and package-manager policy.
This restoration does not change those policies or suppress their findings. Separate hardening remains outside its scope.

### Restored browser fixture and manual-session helper

`test/e2e/phi-server.ts` starts the isolated stack for Playwright and manual comparisons. The helper itself has no browser-framework import.
Its unit tests cover sanitized environments, a local coordinator, coder stubs, startup failures, deadlines, and process-group cleanup.
They also cover idempotent stop, bounded logs, escalation, Darwin zombie handling, and preservation of foreign processes.
HTTP regression tests retain unfinished 404, 405, and 500 bodies and require actual connection closure.
The helper stores logs and owner metadata under ignored `test-results/web-react/phi-web-react-*/`.
Cleanup signals only recorded owned process groups and removes only fixture-owned temporary directories.
The browser suite includes redirect/cookie guard regressions and real WebSocket Origin checks.
Screenshots reside under `test-results/web-react/browser/`; the HTML report is under `playwright-report/web-react/`.
The restored legacy suite was collected but not run: its inherited environment and background destinations require separate isolation review.

### Chrome DevTools review — 2026-10-20, before the fix

This review used the existing isolated foundation stack and installed Chrome 155 through Chrome DevTools MCP 1.11.0.
The configured MCP connection failed because another session owned its browser profile.
A disposable local MCP client used `--isolated --headless`, without configuration changes or interference with that session.
URL restrictions allowed only the React fixture origin and its HMR socket. Telemetry and CrUX requests were disabled.
No application source changed. This review did not execute a later stage or authorize integration.

| Check | Exit/result | Evidence |
| --- | --- | --- |
| Package-local Playwright suite | 0; 26 passed in 27.1 seconds | `test-results/web-react/devtools-2026-10-20/playwright.log` |
| Chrome DevTools probe | Process exit 0; `review-findings`, not acceptance | `test-results/web-react/devtools-2026-10-20/evidence.json`, `mcp.jsonl`, `smoke.mjs` |
| Layout, fonts, and states | 1280/390/320 px without horizontal overflow; 36 px controls; 13 px text; reduced motion; 13 local font responses | `connection-1280.png`, `connection-390.png`, `connection-320.png`, `protected.png`, `invalid-fields.png` in the same directory |
| Status and transport | Real unsupported-v2 state; mocked success/protected/error states; disabled/busy Retry; omitted credentials; stable polite status node | `accessibility.txt`, `network-real.txt`, `status-request.txt`, `console-real.txt` in the same directory |
| Cleanup | Owned MCP browser and fixture stopped; no listener remained on 5173 | Probe cleanup record and post-run process/listener inspection |

The console contained the expected unsupported-v2 404 messages, Vite connection messages, and the React development notice.
No unexpected runtime exception or external resource request appeared.
The desktop and 320 px screenshots retain Phi's typography, purple controls, and density against the static legacy reference.
The previously documented contrast and focus-outline differences remain intentional. Only the default theme was checked.

**Finding, fixed below:** Tab reached Connection and Retry with a visible outline. Enter activated Retry, but focus became `BODY` after completion.
The shared Button sets native `disabled` during busy state. Before the fix, the screen did not restore the trigger's focus.
The previous Playwright keyboard case explicitly refocused Retry before its next activation and did not assert focus after completion.
Its passing result did not cover this finding.

Two initial probe setup errors concerned URL-pattern validation and page-list parsing, not application behavior.
Their records remain in `startup-error.json` and `page-parser-error.json`. The first focus failure remains in `focus-finding-first-run.json`.
Active LSP diagnostics for the disposable probe reported zero errors. Full unit/static/build gates were not repeated during this review.
Safari, actual browser 200% zoom, and VoiceOver remain separate pending checks.

### Retry focus fix — 2026-10-20

The user authorized this fix and explicitly approved the current `gpt-6.1-sol` model instead of the brief's original executor.
The user authorized a reviewed fix commit on `stage-02-foundation`. No integration or Stage 03 work is authorized.

The screen reuses the existing Button and its forwarded native ref. Busy state still disables the native button.
After completion, the screen restores focus only when Retry initiated the request with focus and the page still has focus.
Restoration also requires focus on the page body, without intervening Tab, pointer, focus, or page-blur activity.
The listeners exist only during loading and are removed when loading ends or the screen unmounts.
Initial status checks and unfocused Retry activation do not move focus. Restoration uses `preventScroll:true`.
No shared control, CSS, dependency, transport, or legacy-runtime change was necessary.
This conditional restoration is the user-approved exception to the brief's original no-focus-change rule.

| Check | Exit/result | Evidence under `test-results/web-react/retry-focus-2026-10-20/` |
| --- | --- | --- |
| Before-fix regressions | 1; five unit assertions and one delayed desktop-browser case failed on missing Retry focus | `before-unit.log`, `before-browser.log` |
| Active LSP diagnostics | Zero errors in the three changed source/test files | Active paths probe |
| Package unit tests | 0; 89 passed, including 12 new cases | `package-unit.log` |
| Package Playwright suite | 0; 36 passed in 30.3 seconds, including 10 new desktop/narrow cases | `browser.log` |
| Chrome DevTools MCP | 0; `passed`; native Retry restoration and all five pending-navigation cases | `devtools.log`, `evidence.json`, `mcp.jsonl`, `retry-focused.png` |
| Full regression gates | All exit 0: `pnpm typecheck`, `pnpm test`, `pnpm lint:web`, `pnpm check:code`, `pnpm check:vendors` | `results.log` and command-specific logs; 2,584 unit tests passed, 2 skipped |
| Required builds, in order | Both exit 0: `pnpm build:web`, then `pnpm --dir desktop/pet build` | `build-web.log`, `pet-build.log` |

The unit cases cover all completed result states, service rejection, unfocused activation, page blur, unmount, and obsolete completion.
The browser cases hold Retry pending, then retain focus or move elsewhere by focus, pointer, or Tab.
The older keyboard case now asserts completion focus instead of manually repairing it.
The repeated isolated DevTools review also passed local fonts, 1280/390/320 px reflow, reduced motion, and status/transport checks.
Screenshot inspection showed the existing visible focus outline after restoration, without layout or theme changes.
Expected unsupported-v2 404 messages remained. No unexpected runtime exception or external resource request appeared.
All owned browser/fixture processes stopped. No listener remained on 5173. The other session's Chrome browser was left untouched.
Safari, actual browser 200% zoom, and VoiceOver remain pending. This fix does not complete Stage 02 acceptance.

### Pre-commit review — 2026-10-20

The implementation review found no blocking issue in focus restoration, stale-request handling, or disposal of the four event listeners.
Active diagnostics found zero errors or warnings in the three changed source/test files.
Repeated typecheck, 2,584 unit tests, static/vendor checks, and both required builds passed. Two unit tests remained skipped.
The web build ran before the pet build. The serial browser suite passed all 36 cases in 28.3 seconds.
The uninstrumented Chrome DevTools probe also passed, including fixture cleanup.

An earlier concurrent browser run passed all 36 assertions but exited 1 during fixture teardown with `kill EPERM`.
One later DevTools run also exited 1 after successful assertions because fixture cleanup failed.
These failures concern the unchanged fixture. Their cause remains unresolved. They are not evidence of a Retry regression.
The later successful runs do not resolve this intermittent cleanup risk. No fixture code or permission checks were changed to suppress it.
No fixture listener or owned live process remained after inspection.

Review logs are under `test-results/web-react/commit-review-2026-10-20/`.
`browser-teardown-error.log` and `devtools-teardown-error.json` preserve the failed runs.
`browser.log`, `devtools.log`, `evidence.json`, and `results.log` record the passing repeat checks.
The fixture cleanup risk and pending Safari/VoiceOver/zoom checks remain open for Stage 02 acceptance.

### Pending human checks

| Check | Required evidence | Current result |
| --- | --- | --- |
| Safari visual comparison | Default Phi styling at 1280×800 and 390×844 | Pending |
| Safari reflow and text zoom | 320 CSS px and 200% zoom, no clipped controls or lost actions | Pending |
| Safari keyboard/focus | Logical order, visible/unobscured focus, disabled/pending and retry activation | Pending |
| Safari reduced motion | No nonessential button transitions | Pending |
| macOS VoiceOver with Safari | Landmarks, button names, focus, one polite announcement per changed status | Pending |

The executor did not operate Safari or VoiceOver. Unit or Chromium results cannot substitute for these manual checks.
The stage remains `in-review` until the required human evidence and implementation review are complete.

For an isolated manual session, run this command from the worktree root:

```sh
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" node --experimental-strip-types packages/web-react/test/e2e/phi-server.ts --manual
```

Use only the two printed fixture URLs. Stop the owned stack with Ctrl-C after the checks.
Manual browser sessions have no automated request guard. Keep any legacy comparison observational.
Do not save configuration, spawn a session, send a command, update software, or follow an external link.

## Separate distribution gate

Stage 02 does not authorize production React output, Go embedding, legacy retirement, or an in-shell toggle.
It does not authorize Electron integration, native deployment, publication, or a default switch.
Even complete parity at Stage 15 requires a separate human decision and plan for distribution.
Missing or partial matrix rows block a full-parity claim unless the user explicitly accepts a scope change.

**Precision note:** Paths, commands, versions, hashes, source anchors, and compact evidence tables remain exact technical data.
