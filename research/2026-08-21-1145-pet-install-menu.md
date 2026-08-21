# Research: Runtime "Install Pet" for the Electron shell

Date: 2026-08-21 11:45
Branch: fix/pet-overlay-corrective @ 4aff667
Goal: when the optional pet package is absent, offer an "Install Pet" tray
menu item that downloads and installs it; when present, show the current pet
menu items.

## 1. Current release process (how things ship today)

Pipeline on tag `v*` (`.github/workflows/release.yml`):

1. **goreleaser** job — Go server → GitHub release assets
   `phi_{version}_{os}_{arch}.tar.gz|zip` (`.goreleaser.yaml`).
2. **desktop-package** job (ubuntu/windows/macos matrix) — builds
   `desktop/electron` and packages with
   `electron-builder --config electron-builder.json --publish never`
   (release.yml:100-105). **This is the plain config — the pet is NOT
   included.** The pet-bundling variant exists locally
   (`desktop/electron/package.json` script `package:pet` →
   `electron-builder -c extra-pet.json`, which copies `../pet` →
   `extraResources` `pet/`), but **no CI job ever runs it**. Every released
   desktop build therefore ships without the pet.
3. **desktop-release** job — attaches the packaged installers
   (`phi-client-*.{exe,dmg,zip,AppImage,deb,rpm,tar.gz}`) to the same
   GitHub release via `gh release upload`.
4. **npm-publish** job — publishes `@hypernewbie/phi-code` (the `npm/`
   wrapper). Its `scripts/install.js` downloads the Go binary from
   `https://github.com/hypernewbie/phi/releases/download/v{version}/…`
   at npm-install time, extracting with system `tar` (PowerShell
   `Expand-Archive` on Windows).

Precedent: **GitHub release assets are already the distribution spine** for
both the Go binary (direct download) and desktop installers (attached by
`desktop-release`). Nothing downloads anything from npm at runtime.

## 2. How pet presence is detected (runtime)

`desktop/electron/src/petLoader.ts:65` `discoverPetRoot(app, smoke)`:

- smoke mode → `null`
- packaged: `<resourcesPath>/pet` containing `dist/pet-main.js`
- dev: `desktop/electron/dist/../../pet` = `desktop/pet`

`desktop/electron/src/desktop.ts`:

- line 108 `isPetAvailable(root)` — platform guard: Linux has no supported
  click-through pet → always false there; otherwise `root !== null`.
- line 1693 `this.petRoot = discoverPetRoot(app, SMOKE)` — assigned **once**
  at startup; no re-discovery path exists today.
- line 315 `getPetAvailable: () => isPetAvailable(this.petRoot)` feeds the tray.

`desktop/electron/src/tray.ts`:

- line 284: `Show pet` checkbox, `enabled: petAvailable` (greyed out when
  absent).
- line 287: `petActionsEnabled = petAvailable` gates the whole `Pet` submenu
  (zoom in/out/reset, settings).
- `TrayHandle.rebuildMenu()` (tray.ts:409) rebuilds the Menu on demand;
  desktop.ts already calls it on pet preference/zoom changes
  (desktop.ts:413, 507, 1791).

## 3. Install destination constraint (forced, not a choice)

Installing into `<resourcesPath>/pet` is not viable at runtime:

- Windows: `Program Files\phi-client\resources` — requires elevation.
- Linux: `.deb`/`.rpm` installs under `/usr/lib`; **AppImage mounts its
  squashfs read-only**.
- macOS: inside the `.app` bundle; may be translocated/owned by admin.

The only reliable writable location is **`app.getPath('userData')/pet`**
(per-user, always writable; desktop.ts already stores `profiles.json` and
credentials there, desktop.ts:269, 1699). Consequence:
`discoverPetRoot` gains a userData candidate (checked **before**
resourcesPath, so a fresh user install overrides a stale bundled copy —
bundled variant never shows the install item anyway, making collisions
rare).

## 4. What the pet package actually is

`extra-pet.json` filter = the complete runtime surface:
`dist/**` (pet-main.js, pet-view.js, pet.html, preloads, settings html/js/css,
maps) + `assets/**` (sprites) + `package.json` + `LICENSE-dsh-pet.txt`.
Pure static files — **platform-independent** (the platform gate is the
shell's Linux click-through limitation, not the package).
`desktop/pet/package.json`: name `@phi-desktop/pet`, private, version 0.1.0
(independent version stream from the shell's 0.19.2).
`verify-pet-package.mjs` defines "complete" = dist/pet-main.js +
dist/pet-settings.html + dist/pet-settings-view.js +
dist/pet-settings-preload.js + assets/ + package.json + LICENSE-dsh-pet.txt.

## 5. Distribution options

**A. GitHub release asset (recommended).** CI builds the pet package once,
tars it with the `extra-pet.json` filter, and `desktop-release` uploads
`phi-pet-{version}.tar.gz` alongside the installers. The shell's install
item downloads
`https://github.com/hypernewbie/phi/releases/download/v{version}/phi-pet-{version}.tar.gz`.

- Matches the existing release spine exactly (install.js precedent).
- One platform-independent asset; no npm publish machinery, no registry
  availability/rate-limit failure mode.
- Versioned asset ⇒ install is inherently pinned to the shell's version.

**B. npm package (`@hypernewbie/phi-pet`).** Publish desktop/pet, fetch the
registry tarball at runtime.

- Needs trusted-publisher/OIDC setup per package, version-sync discipline,
  registry tarball has a `package/` prefix to strip.
- No advantage: nothing else in the app resolves packages at runtime, and
  GitHub releases are already a hard dependency.

**C. Floated `releases/latest/download/phi-pet.tar.gz`.** Decouples
versioning but risks shell/pet IPC-contract drift after shell updates —
rejected in favor of the pinned A.

## 6. Version pinning

The pet and shell share an IPC/factory contract (`PetDeps`/`PetHandle`,
petLoader.ts:37-57), so a downloaded pet must match the running shell.
Pinned asset name (option A) solves this at download time, but the shell
must know its own version: `app.getVersion()` reads
`desktop/electron/package.json` (0.19.2). Release tag `v{X}` must equal that
version. After a shell upgrade, a stale userData pet (older than the new shell) is a
hazard; note that release CI already stamps the tag version into
`desktop/electron/package.json` before packaging (`release.yml:91-94`,
"Set release version" via `pnpm version`), so `app.getVersion()` equals the
release tag in every shipped build by construction — no extra CI guard is
needed for pinning to be sound (dev builds never show the install item).
Mitigation for the stale-pet case: write an install marker
(`userData/pet/<version>/.installed-by.json` or equivalent) and treat a
version-mismatched userData pet as absent (menu shows Install Pet again).

## 6a. ESM module cache on reinstall (review finding — planning-relevant)

`desktop.ts:441` loads the pet factory via
`await import(pathToFileURL(path.join(root, 'dist', 'pet-main.js')).href)`.
Node's ESM loader caches modules per resolved URL for the life of the main
process; the `petGeneration` counter invalidates handles, not the module
cache. A reinstall over the SAME path would re-import the cached old
module — the shell reports success while running stale pet code until app
restart. Two resolutions:

- **Version-stamped install dir** (`userData/pet/<version>/`): every fresh
  install gets a fresh import URL; no restart ever needed; the mismatch
  marker lives beside it. Stale version dirs are pruned after a successful
  newer install.
- **Flat dir + restart requirement**: simpler layout but the install flow
  must end with "restart the app" UX (dialog), which is clunky for a tray
  action.

Recommendation: version-stamped dir.

- **Download**: Electron main `net.fetch` (Chromium stack, follows GitHub's
  302 → S3 redirect). No new deps. (`install.js` hand-rolls redirects with
  node https; net.fetch is the Electron-native equivalent.)
- **Extraction**: Node has zlib but no tar.
  - (a) System `tar` — present on macOS/Linux; Windows 10 1803+ ships
    bsdtar as `System32\tar.exe`. Exact precedent: npm install.js uses
    system tar / PowerShell today. Subprocess spawn from the packaged app.
  - (b) Pure-JS minimal ustar reader on `zlib.gunzipSync` (~100 lines, no
    subprocess, fully unit-testable; must sanitize entry names against
    `../` traversal, absolute paths, symlinks — same rules for (a)'s output
    validation either way).
  - The pet tarball is small, flat, and self-produced (trusted producer),
    so both are viable; (b) avoids per-platform subprocess behavior
    differences and keeps everything testable in vitest without mocks of
    `spawn`.
- **Integrity**: HTTPS-only, no checksum (matches install.js convention;
  goreleaser's checksums.txt doesn't cover separately-uploaded assets).

### ASAR / quarantine / signing (review-confirmed non-issues)

- ASAR: the pet is loaded from `<resourcesPath>/pet` outside `app.asar`
  today (extraResources); `userData/pet` is equally outside asar; the
  file-URL dynamic import behaves identically. No restriction applies.
- macOS quarantine: `net.fetch` + Node `fs` writes do not set the
  `com.apple.quarantine` xattr (LaunchServices download paths only), and
  quarantine would not block JS imports regardless.
- macOS bundle-writability: the decisive reason `userData` is required is
  that mutating the `.app` bundle invalidates its code signature and
  Gatekeeper kills the app on next launch.

## 7b. Post-install auto-start must route through the controller

The `Show pet` checkbox reflects `petEnabled` controller state; the
enabled→start flow is `pet-enabled-changed` → `startPet()`
(desktop.ts:1766-1769). Auto-start after install must call
`controller.setPetEnabled(true)`, never `handle.start()` directly, or the
tray checkbox desyncs.

## 8. Tray menu shape

- Pet absent: replace the disabled `Show pet` checkbox + disabled `Pet`
  submenu with one enabled `Install Pet…` item → new tray command
  `{kind: 'install-pet'}`. During download: label flips to a disabled
  `Installing…` + `rebuildMenu()`; on completion desktop.ts re-runs
  discovery (`petRoot` refresh), rebuilds the tray, and (open question)
  optionally auto-enables/starts the pet. On failure: `dialog.showErrorBox`
  (or notification) + revert label.
- Pet present (incl. Linux-with-package edge: `isPetAvailable` is false on
  Linux regardless — install item must stay hidden on Linux; simplest is to
  keep the whole pet tray section gated on `isPetAvailable(root) && !
  isLinux`, matching today's behavior where Linux logs
  "pet unavailable" once, desktop.ts:450).
- Dev builds always discover the repo pet → install item never appears in
  dev (smoke returns null but smoke also disables everything else already).

## 9. Test seams (existing coverage to extend)

- `desktop/electron/test/` — 598 passing incl. pet-lifecycle, tray, controller.
- tray tests: menu-item presence/enabled-state assertions per state.
- petLoader: discoverPetRoot is pure TS with DI'd `app` — extend
  `PetAppLike` with `getPath()` to test userData precedence without
  Electron.
- New: installer module (download→extract→marker) testable with a local
  fixture tarball + file:// or injected fetch; no real network in tests.

## 10. Open decisions (user)

1. Distribution channel: **A (GitHub release asset)** vs B (npm) —
   recommendation A.
2. Extraction: system tar subprocess vs pure-JS ustar reader —
   recommendation pure-JS (testable, no spawn).
3. Reinstall/upgrade handling: version-stamped install dir
   (`userData/pet/<version>/`) vs flat dir + restart requirement —
   recommendation version-stamped (new import URL each install; no
   restart UX ever needed; stale dirs pruned after successful install).
4. Post-install behavior: auto-start via `controller.setPetEnabled(true)`
   (keeps tray checkbox in sync) vs just refresh the menu — recommendation
   auto-start through the controller.

## 11. Non-goals

- No pet auto-update machinery beyond the version marker.
- No bundling-variant changes (CI stays no-pet; `package:pet` remains a
  local/escape-hatch variant).
- No web-UI involvement (tray-only, matching current pet surface).
