# Plan: Runtime "Install Pet" for the Electron shell

Date: 2026-08-21 12:10
Branch: fix/pet-overlay-corrective (worker: use an isolated worktree off this branch)
Research: research/2026-08-21-1145-pet-install-menu.md (review-corrected)

## Locked decisions (user-approved)

1. Distribution: **GitHub release asset** — CI builds `phi-pet-<version>.tar.gz` (platform-independent, static files) and uploads it to the tag's GitHub release; the shell downloads from `https://github.com/hypernewbie/phi/releases/download/v<version>/phi-pet-<version>.tar.gz`.
2. Extraction: **pure-JS ustar reader** on `node:zlib.gunzipSync` — no subprocess, no new deps.
3. Layout: **version-stamped install dir** — `userData/pet/<appVersion>/`; fresh import URL per install (ESM module cache safe); other version dirs pruned after a successful install.
4. Post-install: **auto-start** via `controller.setPetEnabled(true)` (existing `pet-enabled-changed` → `startPet()` flow keeps the tray checkbox in sync).

## Non-goals

- No pet auto-update beyond version-stamp mismatch (missing current-version dir = absent pet).
- CI desktop packaging stays no-pet; `package:pet` local variant untouched.
- No web-UI changes; tray-only surface.

## M0 — Baseline verification (parent runs before EXECUTE)

- `pnpm --dir desktop/electron test` — confirm green baseline (research claims 598 passing; verify count).
- `pnpm --dir desktop/pet test` — green.
- `pnpm --dir desktop/electron typecheck && pnpm --dir desktop/pet typecheck` — clean.

## M1 — CI: build and upload the pet release asset

File: `.github/workflows/release.yml`

New job `pet-package` (after `goreleaser`, which creates the release):

- `runs-on: ubuntu-latest`, `permissions: contents: write`, `needs: goreleaser`.
- Steps: checkout → pnpm/action-setup → setup-node 24 (cache pnpm, `cache-dependency-path: desktop/pet/pnpm-lock.yaml`) → `pnpm --dir desktop/pet install --frozen-lockfile` → `pnpm --dir desktop/pet build` → package the tarball with exactly the `extra-pet.json` filter:

  ```bash
  version=${GITHUB_REF_NAME#v}
  tar -czf "phi-pet-${version}.tar.gz" -C desktop/pet dist assets package.json LICENSE-dsh-pet.txt
  gh release upload --repo "$GITHUB_REPOSITORY" "$GITHUB_REF_NAME" "phi-pet-${version}.tar.gz" --clobber
  ```

  (`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`; tarball entries root at `dist/`, `assets/`, `package.json`, `LICENSE-dsh-pet.txt` — no enclosing folder.)
- `desktop-release` and `npm-publish` need no changes; `pet-package` is independent of `desktop-package`.

Note: dev machines produce the same tarball via the existing `pnpm --dir desktop/pet build`; document one line in README ("Optional desktop pet" bullet) that the pet installs from the tray in released builds.

## M2 — petLoader: versioned userData candidate

File: `desktop/electron/src/petLoader.ts`

- Extend `PetAppLike`: add `getPath(name: string): string` and `getVersion(): string`.
- `discoverPetRoot(app, smoke)` new order:
  1. smoke → `null` (unchanged).
  2. packaged: candidate `path.join(app.getPath('userData'), 'pet', app.getVersion())` — return it if it contains `dist/pet-main.js` (user-installed pet wins over any bundled copy).
  3. packaged: `<resourcesPath>/pet` (unchanged; move the existing `if (app.isPackaged && !resourcesPath) return null;` guard below the new userData step).
  4. dev (!isPackaged): repo pet `desktop/pet` only (unchanged — dev never sees the install item).
- No pruning logic here (installer owns it).

Tests: **new `test/petLoader.test.ts`** (there is no existing discoverPetRoot coverage to extend — pet-lifecycle.test.ts only type-imports from petLoader): userData-version match preferred over resourcesPath; missing current-version userData dir falls through to resourcesPath/absent; dev precedence unchanged (note: depends on `desktop/pet/dist/pet-main.js` being built in the worktree — run `pnpm --dir desktop/pet build` first if dist is absent); smoke → null.

## M3 — petInstaller module (new)

File: `desktop/electron/src/petInstaller.ts` — pure TS, **no Electron import** (DI convention like petLoader/controller). Export:

```ts
export interface PetInstallerDeps {
  userDataPath: string;        // app.getPath('userData')
  appVersion: string;          // app.getVersion()
  repo: string;                // 'hypernewbie/phi' (constant, test-overridable)
  fetchBytes(url: string): Promise<Uint8Array>;  // injected; desktop.ts provides net.fetch impl
  log: (msg: string) => void;
}
export interface PetInstallResult { root: string; }  // userDataPath/pet/<version>
export async function installPet(deps: PetInstallerDeps): Promise<PetInstallResult>;
```

Behavior, in order:

1. Validate `appVersion` against `/^[0-9A-Za-z][0-9A-Za-z._+-]*$/` (no path/URL metachars) — throw on failure.
2. URL: `https://${repo}/releases/download/v${appVersion}/phi-pet-${appVersion}.tar.gz`.
3. `fetchBytes` → `zlib.gunzipSync` → parse 512-byte ustar blocks (name+prefix, octal size, typeflag). Accept regular files (`'0'`/`'\0'`) and explicit directory entries; **reject** symlink/hardlink entries (`'1'`,`'2'`), entry names that are absolute, contain `..` segments, backslashes, or NUL-terminated oddities, and duplicate entries. **Decode name/prefix fields as UTF-8** — the real tarball contains CJK filenames (e.g. `assets/thumb/点击回应 - 傲娇生气（侧身展示）.webm`); any other decoding mojibakes sprites and 404s them at runtime.
4. Write everything to staging: `userDataPath/pet/.staging-<version>-<pid>-<ts>/` (mkdir recursive for parent dirs, files via writeFileSync; umask defaults suffice — no explicit modes).
5. Verify completeness inside staging (same list as `verify-pet-package.mjs`): `dist/pet-main.js`, `dist/pet-settings.html`, `dist/pet-settings-view.js`, `dist/pet-settings-preload.js`, `assets/` (dir, non-empty), `package.json`, `LICENSE-dsh-pet.txt`. Incomplete → fail.
6. Atomic-ish swap: if final `userDataPath/pet/<version>` exists, `rmSync(final, {recursive: true, force: true})`; `renameSync(staging, final)`. (The version dir is immutable-by-convention; replace is safe. Same-path ESM staleness is not a concern because a *running* pet from that exact version means install is a no-op re-request — see step 8 guard.)
7. Prune: remove sibling entries under `userDataPath/pet/` other than `<version>` and other `.staging-*` dirs (best-effort, logged, never fatal). Also prune stale `.staging-*` dirs from prior crashed runs (best-effort).
8. Guard (idempotence pre-check, run **before** step 3): if a complete install already exists at `userDataPath/pet/<version>` (same completeness helper as step 5), return `{root: final}` immediately — never delete+rewrite a directory whose module may be currently imported.

Errors: any failure → best-effort `rmSync(staging)`, throw `Error` with a user-presentable message ( surfaced by desktop.ts via dialog).

Tests (new `test/petInstaller.test.ts`, vitest, temp dirs under `os.tmpdir()`): **happy-path fixture built with system `tar`** (available on all dev/CI platforms; runtime stays pure-JS) from a synthetic pet package — lands files at versioned root, and **includes a CJK-named entry** under `assets/thumb/` to pin UTF-8 decoding. **Malformed-entry fixtures are hand-crafted 512-byte ustar headers** (system tar normalizes or refuses `../evil`, absolute, and duplicate members): traversal rejected; absolute path rejected; symlink rejected; duplicate rejected; truncated archive rejected. Behavior cases: incomplete (missing LICENSE) rejected and staging cleaned; idempotent re-install short-circuits (no rewrite); prune removes old version dirs + stale staging; bad version string rejected; fetch error propagates and staging cleaned.

## M4 — tray + desktop wiring

### tray.ts

- New command `{kind: 'install-pet'}` in the TrayCommand union; new handler `installPet: () => void` in **`TrayMenuHandlers`** (the actual interface name — there is no `TrayHandlers`); new deps getters `getPetInstallable(): boolean` and `getPetInstalling(): boolean` (follow the `getPetAvailable` pattern). `buildTrayMenu` takes positional params — add `petInstallable: boolean, petInstalling: boolean` **immediately after** `petAvailable`.
- Menu shape: keep the existing `petAvailable` gates; add:
  - When `petInstallable && !petInstalling`: replace the disabled `Show pet` checkbox and disabled `Pet` submenu with a single enabled `Install Pet…` item (click → `ipcSend(TRAY_COMMAND_CHANNEL, {kind:'install-pet'})`).
  - When `petInstalling`: that item becomes disabled with label `Installing…`.
  - When `petAvailable`: menu exactly as today (install item never shown).
  - When neither (Linux, or smoke): keep today's disabled presentation.
- Export `isPetInstallable`-style pure helper if needed for tests; tray.ts already imports Electron at module top (`tray.ts:54`) — the actual convention is that Electron surfaces are only *used* inside `setupTray` and tests `vi.mock('electron')`.

### desktop.ts

- State: `private petInstalling = false`; deps: `getPetInstallable: () => process.platform !== 'linux' && this.petRoot === null && !SMOKE && !this.petInstalling` (tray reads via getter; desktop also re-guards on command receipt), `getPetInstalling: () => this.petInstalling`, handler `installPet: () => void this.handleInstallPet()`.
- Command case `'install-pet'` → `handleInstallPet()`:
  1. Guard: `if (this.petInstalling || this.petRoot !== null || SMOKE || process.platform === 'linux') return;`
  2. `this.petInstalling = true; this.trayHandle?.rebuildMenu();`
  3. `try { const { root } = await installPet({ userDataPath: app.getPath('userData'), appVersion: app.getVersion(), repo: 'hypernewbie/phi', fetchBytes, log }); }` where `fetchBytes` uses Electron `net` (imported where the other Electron surfaces are used): `const res = await net.fetch(url); if (!res.ok) throw ...; return new Uint8Array(await res.arrayBuffer());`
  4. Success: `this.petInstalling = false; this.petRoot = discoverPetRoot(app, SMOKE);` (re-discover — now finds the versioned dir; **reassign before enabling/starting** so `ensurePetHandle` (`desktop.ts:457`) resolves the new root) `this.trayHandle?.rebuildMenu();` then **branch, because `Controller.setPetEnabled` early-returns on no change (`controller.ts:837-838`) and would silently skip `startPet()`**: `if (!ctrl.getPetEnabled()) ctrl.setPetEnabled(true); else void this.startPet();` — both arms keep the checkbox in sync and the pet running (locked decision 4).
  5. Failure: `this.petInstalling = false; this.trayHandle?.rebuildMenu(); this.log(...); dialog.showErrorBox('Pet installation failed', String(err?.message ?? err));` (dialog import follows existing desktop.ts Electron usage).
- No changes to `startPet`/`ensurePet` themselves.

Tests: extend `test/tray.test.ts` (Install Pet… present/enabled when installable; `Installing…` disabled while installing; absent when petAvailable; unchanged on unsupported platform) and `test/pet-lifecycle.test.ts` (desktop flow with **`vi.mock('../src/petInstaller.js')`** — the established module-mock convention, matching `vi.mock('electron')` at `pet-lifecycle.test.ts:36` — fake `installPet` resolves/rejects: success reorders discovery → pet starts in both `petEnabled===false` (setPetEnabled(true) path) and `petEnabled===true` (startPet path) pre-states; failure shows error path and resets state; concurrent install command ignored; Linux/smoke/pet-present guards). **Extend the hoisted electron mock factory (`pet-lifecycle.test.ts:36-49`) with `net` (fetch) and `dialog` (showErrorBox) bindings** — the failure-path assertion on `dialog.showErrorBox` requires both. Follow the existing DI/test harness patterns in those files — desktop.ts tests drive seams without real Electron.

## M5 — verification (parent runs after EXECUTE)

1. `pnpm --dir desktop/electron typecheck && pnpm --dir desktop/pet typecheck`
2. `pnpm --dir desktop/electron test && pnpm --dir desktop/pet test`
3. Root: `pnpm typecheck && pnpm test` (must remain green — root suite untouched).
4. `node --check` not needed (tsc covers). Manual YAML sanity: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"` or actionlint if available.
5. Diff review by fresh reviewer fanout (RPE step 6) with plan + parent-generated diff.

## Milestone order & gates

M1 (CI) is independent; M2 → M3 → M4 sequential (loader seam → installer → wiring). Each milestone lands green (typecheck + tests) before the next. The worker reports per-milestone; parent verifies.

## Risks / notes for the worker

- ustar octal size fields may be space- or NUL-padded; GNU tar writes `ustar` magic with spaces — parse tolerantly, reject unknown magic.
- Long names (>100 chars) cannot occur in this package (shortest paths, `dist/pet-settings-preload.js` etc.); the parser may reject names that need pax/GNU extensions rather than implement them.
- Directory entries may be absent in some tar outputs; create parent dirs on file write (`mkdirSync recursive`).
- Windows path separators: tar entries always use `/`; normalize with path.join after sanitizing segments.
- Do not touch `package:pet`/`extra-pet.json` semantics — only CI gains the asset job.
- README: extend the existing "Optional desktop pet" bullet with one sentence about tray-install in released builds.
