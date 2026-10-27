# React frontend parity and component inventory

## Stage 02 status

**Date:** 2026-10-19. **State:** `in-review`, not integrated.

Stage 02 implements a development-only Connection shell, two shared controls, and an isolated browser/manual-session fixture.
The user requested Playwright restoration. Unit/static/build gates and all 26 React Playwright cases passed after restoration.
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
`ConnectionScreen` receives the service and owns request generations, pending state, and cancellation.
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
A computed font-family value alone does not prove that a font loaded. This browser evidence remains pending.

## Feature parity matrix

Every source anchor in this matrix refers to the approved parity baseline, not the later implementation baseline.
`missing` means that this React app does not implement the outcome. Legacy availability does not count as React implementation.
A dash means no React evidence. Later stages must replace grouped rows with detailed outcomes as necessary.
The Stage 02 foundation is a new screen and is not a claim of converted full-shell parity.

| Required outcome | Source anchor | Owner | Status | Automated evidence | Desktop result | Narrow result | Remaining gap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Connection foundation and shared controls | Implementation baseline: `web/style.css` controls/auth-card, `web/index.html` brand | 02 | partial | Package unit tests | Manual checks pending | Manual checks pending | Safari/VoiceOver, font loading, geometry, reflow, and zoom |
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

The following post-restoration commands ran from the authorized worktree. No check used a user server or auth worktree.
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

Current logs remain in ignored `test-results/web-react/restore/`, with per-command logs and `results.log` for the six W commands after typecheck.
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
The current 26-case browser run includes redirect/cookie guard regressions and real WebSocket Origin checks.
Screenshots reside under `test-results/web-react/browser/`; the HTML report is under `playwright-report/web-react/`.
The restored legacy suite was collected but not run: its inherited environment and background destinations require separate isolation review.

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
