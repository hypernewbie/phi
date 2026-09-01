# phi-desktop-electron

The Electron desktop shell for Phi — the migration target for the current
Wails v2.13 shell (`desktop/`). This package is a **sibling** of the Wails
desktop module: it has its own `package.json`, its own lockfile, and its
own TypeScript build. It is not a member of the repo-root pnpm workspace,
and the Wails module (`desktop/go.mod`, `desktop/main.go`,
`desktop/internal/*`) stays untouched until the migration's final step
(see `docs/ELECTRON_MIGRATION.md` for the full 10-step plan and status).

## Phase 2 scope (this slice)

Phase-1 inert scaffold + the single-instance gate and `phi://` argv routing:

- `app.requestSingleInstanceLock()` first; a second launch classifies its
  positional `phi://` and `http(s)://` args and quits (Electron delivers the
  args to the running instance automatically);
- the primary installs the `second-instance` listener, which posts one
  `ForwardPayload` per forwardable arg on `phi:single-instance-forward` to
  the main window's renderer and foregrounds the window
  (restore()+focus()); the primary also routes its own positional URL args
  the same way;
- `phi://` deep links are parsed (`src/deeplink.ts`, mirroring the Wails
  `desktop/internal/deeplink` grammar) and dispatched on `phi:deeplink`;
- a typed, sandboxed preload (`src/preload.ts`, CJS via
  `tsconfig.preload.json`) exposes `window.electron.onDeeplink(cb)` and
  `window.electron.onForwardPayload(cb)`;
- **security defaults** stay in place: `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and the
  renderer is loaded via `loadFile` — never `loadURL` to an external
  origin;
- unit tests (vitest + jsdom) + the headless smoke harness (also
  asserting argv routing for the harness test arg).

## Phase 3 scope (this slice)

`phi://` OS protocol registration (parity with
`desktop/internal/registry`), implemented with the **public Electron
`app.setAsDefaultProtocolClient(protocol, execPath, args)` API only** (no
native registry calls):

- `src/protocol.ts` — `installProtocol` / `uninstallProtocol` over a
  `Platform` interface (`realPlatform` for production, a recording fake in
  tests), the `[<main.js>, '--']` argv builder, and the Linux XDG
  desktop-file helpers;
- `--register-protocol` / `--unregister-protocol` one-shot CLI flags in
  `src/main.ts`, parsed before the single-instance gate (they win over
  every other flag and exit 0);
- macOS bundle config in `electron-builder.json` (`mac.extendInfo`);
- tests: `test/protocol.test.ts` + `test/protocol-json.test.ts` + CLI-flag
  and smoke-payload guards.

Deliberately **not** implemented yet (later migration slices): multi-server
views, retained per-profile `WebContentsView`s, popups, packaging.

## Phase 4 scope (this slice)

Native system tray (parity with `desktop/internal/tray`), public Electron
`Tray` + `Menu` + `nativeImage` API only (no native Win32 calls, no
NSStatusItem/StatusNotifierItem code paths):

- `src/tray.ts` — `setupTray(deps)` builds the tray on
  `app.whenReady()` **after** the main window and **before** the
  second-instance listener (order: gate -> window -> tray ->
  second-instance listener). The context menu is `Show Phi` /
  `Profiles > {id} {name}` (one entry per saved profile) / `Quit`;
  right-click shows it everywhere, left-click also on macOS (the platform
  convention). Menu intents are posted on the typed `phi:tray-command`
  channel: `{kind:'show'}`, `{kind:'select-profile', id}`,
  `{kind:'quit'}`; the host loop in `main.ts` is the bridge (Show Phi ->
  `restore()+focus()`; select-profile -> the step-5 controller's
  `setActive`; quit -> log, notify the main window, then `app.quit()` —
  the host loop owns the quit since step 5, the tray only posts the
  intent);
- tooltip contract: `Phi — <name> (<host:port>)` for the active profile
  with ` (N unread)` appended when it has unread — driven by
  `TrayHandle.setActiveProfile(p)` / `TrayHandle.setUnread(profileId, n)`
  (only the active profile's tooltip changes);
- the tray icon is `assets/tray.png` (16x16, with `@2x`/`@4x` variants)
  resolved via `TRAY_ICON_PATH` at production load time; a missing icon
  is logged once and the tray continues with the default empty icon (the
  Wails missing-icon convention). A real icon belongs in step 10
  (packaging);
- teardown: the tray is closed on `before-quit` (and on non-macOS
  `window-all-closed`, which quits) — the Wails `OnShutdown` equivalent
  (no MessageBox, log-only);
- the smoke harness never instantiates a real `Tray` (the smoke path
  returns before `startTray()`; `trayNotExercised` is asserted). Tests
  stub the `electron` module with recording fakes — no real
  `Tray`/`Menu`/`nativeImage`/`app` is ever constructed (see
  `test/tray.test.ts`).

Deliberately **not** implemented yet: click-to-open (left-click shows the
app), menu rebuild on profile-set changes (creation-time snapshot),
unread badges in the menu, native balloon/toast notifications (use
`Notification.isSupported()` when they land), animations — all deferred to
later slices (see `docs/ELECTRON_MIGRATION.md` step 4).

## Phase 5 scope (this slice)

Profile controller + global hotkey (parity with `desktop/internal/
controller` + the `profile` store + `endpoint.Parse` validation, and
`desktop/internal/hotkeys`):

- `src/controller.ts` — the host-loop profile controller, **pure
  TypeScript with zero Electron imports**:
  - a persisted, non-secret profile store at `app.getPath('userData') +
    '/profiles.json'` — atomic writes (temp file + fsync + rename), a
    `.bak` copy of the previous good state before every save, and
    corruption recovery that moves the corrupt file aside
    (`.corrupt-<ts>`, never deleted) before falling back to the backup
    (mirroring the Wails `internal/profile` pattern);
  - CRUD: `add(rawUrl)` (strict `endpoint.Parse`-equivalent validation
    + the same-host rule — a new origin sharing a hostname with an
    existing profile is refused with a typed `SameHostConflictError`;
    re-adding the same origin returns the existing profile),
    `remove(id)`, `rename(id, name)`, `setLastUsed(id)`,
    `setActive(id)`, `setUnread(id, n)` (clamps negatives to 0);
  - `state()` (deep-copy snapshot with Maps) + `subscribe(fn)`
    (notify-on-mutation, fire-and-forget) + `updateHealth(checker?)`
    (injected checker — the slice ships an `unknownHealthChecker`
    placeholder; the real HTTP liveness checker lands in step 8);
  - typed errors: `InvalidUrlError`, `SameHostConflictError`,
    `UnknownProfileError`, `InvalidNameError`.
- the tray receiver (`src/main.ts`): the controller is built after the
  tray and the second-instance listener; its events drive the tray
  tooltip (`active-changed` -> `setActiveProfile`, `unread-changed` ->
  `setUnread`); the tray's `select-profile` intent calls
  `controller.setActive(id)`; the `quit` intent is owned by the host
  loop (log, notify the main window, `app.quit()`); `--server <url>`
  adds the server as a profile when unmatched and activates it (window
  navigation stays step 6);
- `src/hotkeys.ts` — the global hotkey via the public Electron
  `globalShortcut` API: default `CommandOrControl+Shift+L` (Ctrl on
  Windows/Linux, Cmd on macOS — the same 'L' VK the Wails slice chose),
  override via `PHI_DESKTOP_HOTKEY`; `registerHotkey` returns
  `'registered' | 'busy' | 'error'` — a taken accelerator is logged and
  skipped (never a MessageBox); registered after the tray, unregistered
  on `before-quit`; the trigger restores()+focuses the main window.

Deliberately **not** implemented yet: the real HTTP health checker
(step 8), the tray menu rebuild hook (step 6), health-aware tray menu
(step 8), multi-server retained views (step 6), popups (step 7),
packaging (step 10).

## Controller

`src/controller.ts` is the host-loop brain (Wails `desktop/internal/
controller` parity) — a persisted profile store plus active/unread/
health state, with zero Electron imports so it runs directly under
vitest:

- `ControllerState`: `{ profiles: {id,name,origin}[], activeId,
  health: Map<id,'up'|'down'|'unknown'>, unread: Map<id, number> }`;
  `state()` returns a deep-copy snapshot; `subscribe(fn)` returns an
  unsubscribe and notifies on every mutation (fire-and-forget).
- Persistence: one JSON file (`{ profiles: [...] }`) at `persistPath`;
  atomic save = backup the current file to `.bak`, write a temp file,
  fsync, rename over the final path; corrupt files are moved aside to
  `.corrupt-<ts>` (never deleted) and the `.bak` is tried before
  starting empty — recovery actions are logged through `opts.log`.
- `add(rawUrl)` validates with the strict `endpoint.Parse`-equivalent
  rules (root path only; no userinfo, query or fragment; http/https;
  port 1-65535; lowercase host) and applies the same-host rule: a new
  origin sharing a hostname with an existing profile is refused with
  `SameHostConflictError` (Wails `ErrSameHostConflict` parity);
  re-adding the exact same origin is allowed and returns the existing
  profile. Profile ids derive from the sanitized host[:port]
  (`IDForOrigin` parity).
- `setActive(id)` emits `{kind:'active-changed', id}` (and stamps
  last-used); `setUnread(id, n)` clamps negatives to 0 and emits
  `{kind:'unread-changed', id, n}`; the active profile's unread shows in
  the tray tooltip suffix via the receiver wiring.
- `updateHealth(checker?)` runs the injected checker once per profile
  (`'up'|'down'|'unknown'`); the slice ships `unknownHealthChecker`
  (reports unknown — no HTTP anywhere). The real liveness checker lands
  in step 8.

## Global hotkey

`src/hotkeys.ts` registers `CommandOrControl+Shift+L` (Ctrl on
Windows/Linux, Cmd on macOS — the same 'L' VK the Wails slice chose)
through the public Electron `globalShortcut` API:

- `PHI_DESKTOP_HOTKEY` overrides the accelerator;
- `registerHotkey(accelerator, action, deps?)` returns
  `{ unregister(), status }` with `status: 'registered' | 'busy' |
  'error'` — `busy` when the OS already has the accelerator (logged,
  the app continues — never a MessageBox, Wails parity), `error` on any
  other failure; `unregister()` is idempotent and safe on every status;
- the trigger restores()+focuses the main window (Show Phi parity);
- lifecycle: registered after the tray; `before-quit` unregisters every
  active registration;
- platform note: `globalShortcut` is unavailable on macOS for the system
  media keys but available for arbitrary accelerators.

## Multi-server shell

This is the **milestone slice** (step 6 of `docs/ELECTRON_MIGRATION.md`):
the rail is now a **real CSS sidebar inside the main window** — not the
Wails GDI overlay — with one **retained `WebContentsView` per saved
profile**, real multi-server switching, and per-profile storage
isolation.

- **Profiles** are non-secret desktop metadata stored at
  `app.getPath('userData')/profiles.json` (atomic writes,
  `profiles.json.bak` corruption recovery, corrupt files moved aside,
  never deleted — the Wails `internal/profile` pattern). A profile is
  `{id, name, origin, lastUsed}` — no passwords, verifiers, cookies or
  access tokens. Ids derive from the normalized origin (`127-0-0-1-7070`
  style) so they are stable and safe in paths and `phi://` links.
- **CSS server rail** — a 72 px fixed sidebar rendered by the shell
  renderer (`src/renderer.html` + `src/rail.css` + `src/renderer.ts`,
  loaded into a never-hidden `WebContentsView` child of the main
  window): one monogram per saved profile in insertion order (40 px
  circle, 1-2 rune uppercase glyph, active ring, health dot, unread
  badge capped at "9+", hover tooltip with name + origin), plus an add
  button pinned to the bottom. The rail is a plain DOM surface — the
  main process pushes `phi:rail-state` snapshots on every controller
  event and the renderer re-renders the list (no virtual DOM, no web
  framework). Clicking a monogram posts `phi:select-profile`; the add
  button posts `phi:open-picker` (log-and-echo until the picker slice).
- **Retained per-profile views** — `src/views.ts` (`ProfileViewManager`)
  owns one `WebContentsView` per profile: created lazily on first
  activation, **hidden on switch (never destroyed, never navigated)**,
  shown + brought to the front on return — switching preserves live
  page state (the Discord-like behavior the Wails navigation-replace
  saga could not deliver). The active view sits at `{x: 72, y: 0,
  width: contentWidth - 72, height: contentHeight}`; a single window
  `resize` listener re-bounds the active view synchronously, hidden
  views keep their last bounds until reactivation. The most recently
  used profile is restored at startup (its view loads immediately).
- **Per-profile storage isolation** — each profile's view runs on its
  own session partition `persist:phi-<sanitized-id>`
  (`session.fromPartition(partition, { cache: true })`), so cookies /
  localStorage / IndexedDB are isolated per server (the WebView2
  same-host cookie-jar conflict is gone). Partitions are closed on
  `before-quit` alongside the view teardown. The rail renderer itself
  uses the default session.
- **View-host** — the main window is the host: its own webContents is a
  covered blank container; the rail view (left 72 px) and the active
  server view (the pane) are `contentView` children. The Phi page is
  loaded as a top-level page with the non-negotiable security defaults
  (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `webSecurity: true`) — permissions default-deny except for the narrowly
  scoped Clipboard API permission used by Phi profile pages; popups from the
  active page are step 7.
- **Deep links / single instance / tray / hotkeys / protocol** — steps
  2-5 behavior is unchanged; deep links and forwarded argv now reach
  the rail renderer's preload bridge (`window.electron`).

## Install / build / run

```sh
cd desktop/electron
pnpm install        # downloads the pinned Electron binary (approved via
                    # pnpm-workspace.yaml allowBuilds)
pnpm run build      # tsc -> dist/main.js + copies shell.html/shell.css to dist/
pnpm run typecheck  # strict type check of src/ and test/
pnpm run dev        # electron . — opens the phase-1 shell window
pnpm test           # vitest run (unit tests; the e2e smoke test spawns the
                    # real Electron binary and skips on documented
                    # no-display/not-built preconditions — never fails on
                    # those)
pnpm run smoke      # vitest run test/smoke.test.ts — the same e2e harness
pnpm run package    # electron-builder placeholder (real packaging is a
                    # later slice; out/ is gitignored)
```

Order matters for the e2e smoke test: it spawns the built bundle, so run
`pnpm run build` before `pnpm test` / `pnpm run smoke` (CI does the same).
In headless Linux environments (no `DISPLAY`/`WAYLAND_DISPLAY`, or a
sandbox that cannot start), the smoke test **skips** with a documented
reason and fails only on real errors — matching the desktop Go native-test
convention. The smoke harness sets `ELECTRON_DISABLE_SANDBOX=1` for the
harness run only; the app's renderer security defaults are untouched.

## Registering the phi:// protocol

Deep links (`phi://profile/<id>[/session/<n>|/worktree/<ref>]`) are
handled by `src/protocol.ts`, which wraps the public Electron
`app.setAsDefaultProtocolClient(protocol, execPath, args)` API (no native
registry calls, no advapi32). The one-shot CLI flags (parsed before the
single-instance gate; they win over every other flag and exit 0; when
both are given, `--register-protocol` wins):

```sh
pnpm run build
pnpm exec electron . --register-protocol     # install the handler, log, exit 0
pnpm exec electron . --unregister-protocol   # remove it (idempotent), exit 0
```

- **Windows**: `app.setAsDefaultProtocolClient('phi', process.execPath,
  [<appPath>/dist/main.js, '--'])` — the trailing `--` keeps phi:// URL
  values from being parsed as Electron flags. Unregistration uses
  `app.removeAsDefaultProtocolClient` with the same path/args.
- **macOS**: registration is the **app bundle's** responsibility —
  `CFBundleURLTypes` is baked into `Info.plist` at packaging time via the
  `mac.extendInfo` block in `electron-builder.json`
  (`CFBundleURLSchemes: ["phi"]`). The runtime writes nothing (install
  reports the bundle path with `exe: 'app'`); a re-packaged bundle is the
  only way to change the registration.
- **Linux**: writes (or removes) the XDG desktop file
  `~/.local/share/applications/phi-desktop.desktop` with
  `MimeType=x-scheme-handler/phi;` — written directly, no shelling out —
  then asks Electron to make it the default handler.

Tests never touch a real registry key or desktop file: the Linux writer
is exercised against a temp dir only, and the real Electron
`setAsDefaultProtocolClient` is reachable only through `realPlatform`,
which only the production CLI path uses.

## Layout

```
package.json          manifest (type: module, main: dist/main.js)
pnpm-workspace.yaml   own workspace root + electron postinstall approval
tsconfig.json         strict typecheck config (noEmit)
tsconfig.build.json   build config -> dist/ (ESM main + modules)
tsconfig.preload.json build config for the CJS preload -> dist/preload.js
vitest.config.ts      vitest: jsdom default env, long timeout for the smoke test
electron-builder.json minimal packaging placeholder (real packaging later)
src/main.ts           Electron entry (CLI flags + gate + argv routing + host window + tray host loop + controller receiver + rail/view wiring + global hotkey + smoke self-check)
src/single-instance.ts  single-instance gate + ForwardPayload argv classification (listener installed after window+tray)
src/deeplink.ts         phi:// deep-link parser + dispatcher (Wails deeplink parity)
src/protocol.ts         phi:// OS protocol registration (Platform + install/uninstall + Linux desktop file)
src/tray.ts             system tray (TrayDeps DI + menu builder + tooltip/unread + event wiring)
src/controller.ts       profile controller (pure TS: store persistence, CRUD, same-host rule, MRU, unread/health, subscribe/emit)
src/hotkeys.ts          global hotkey (globalShortcut + PHI_DESKTOP_HOTKEY override)
src/views.ts            ProfileViewManager: one retained WebContentsView per profile (pure TS, recording-fake testable)
src/renderer.ts         rail renderer module (ESM -> dist/renderer.js; monogram list rebuild from phi:rail-state)
src/renderer.html       the rail renderer page (72 px fixed sidebar + monogram list + add button)
src/rail.css            rail styles (Phi palette mirrored from web/style.css)
src/preload.ts          sandboxed preload: window.electron.onDeeplink / onForwardPayload / onRailState / postSelectProfile / postOpenPicker
src/electron.d.ts       typed window.electron surface + the RailState payload types
src/shell.html        host window's covered placeholder page (phase-1 shell)
src/shell.css         Phi design tokens + shell styles
assets/tray.png       tray icon placeholder (16x16 + @2x/@4x; real art belongs in step 10 packaging)
test/                 vitest unit tests + e2e smoke test
scripts/copy-assets.mjs  copies shell/renderer assets into dist/ at build time
```

See `docs/ELECTRON_MIGRATION.md` for the architectural decision, the
trade-off matrix, the 10-step migration plan, and current status.
