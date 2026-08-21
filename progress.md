# Pet idle dwell (seconds) — execution progress

Branch: fix/pet-overlay-corrective @ e585303
Plan: plan/2026-08-21-0956-pet-idle-dwell-seconds.md
Research: research/2026-08-21-0956-pet-idle-dwell-seconds.md
Archive (M0 step 3): /var/folders/cn/h_v605nn2pv9mz92zyfyc7z40000gn/T/tmp.feIUfpTfCJ

## M0 — baseline and archive — ✅ PASS
- root/branch/commit verified: /Users/n0mad/code/phi-worktrees/fix-pet-overlay-corrective / fix/pet-overlay-corrective / e585303
- 19 pre-existing + 4 settings files confirmed
- baseline desktop tests: 598 passing (controller, tray, pet-lifecycle, main, verify-pet-package)
- baseline pet tests: 65 passing (pet-view, pet-main, pet-preload, pet-window, pet-settings-view, pet-settings-preload)
- typecheck: desktop + pet clean

## M1 — controller (default 10, range 1–3600) — ✅ PASS
- `controller.ts`: `PET_IDLE_DWELL_VALUES`/`PET_IDLE_DWELL_DEFAULT_MS` → `PET_IDLE_DWELL_MIN_SECONDS`/`MAX_SECONDS`/`DEFAULT_SECONDS = 10`
- `isPetIdleDwellSeconds`: `Number.isInteger(v) && v >= 1 && v <= 3600`
- `petIdleDwellMs` → `petIdleDwellSeconds`; `getPetIdleDwellMs` → `getPetIdleDwellSeconds`; `setPetIdleDwellMs` → `setPetIdleDwellSeconds`; `event.dwellMs` → `event.dwellSeconds`
- `controller.test.ts`: 4 tests rewritten with 10/1/3600 boundary values; `controller.test.ts` final = 71 tests passing
- typecheck clean

## M2 — desktop host + pet handle plumbing — ✅ PASS
- `desktop.ts:417` `setPetIdleDwellFromController` no longer checks fixed list; checks integer in `[1, 3600]`
- `desktop.ts:489-496` bridge exposes `getIdleDwellSeconds`/`requestIdleDwellSeconds` returning `dwellSeconds` payloads
- `petLoader.ts:42` `setIdleDwellSeconds?(dwellSeconds)`
- `desktop.ts:1772` forwards `event.dwellSeconds` to handle
- typecheck clean

## M3 — IPC types + pet main + pet window — ✅ PASS
- `pet-bridge.ts`: `PetIdleDwellRequest`/`State`/`Result` all use `dwellSeconds`
- `pet-main.ts`: `validDwellSeconds` (integer 1..3600), `desiredDwellSeconds`/`pendingDwellSeconds` rename, URL query `petIdleDwellSeconds`, channel name unchanged
- `pet-preload.ts`: overlay listener payload carries `dwellSeconds`
- `pet-window.ts`: query key `petIdleDwellSeconds`, options field `dwellSeconds`

## M4 — settings HTML + view (number input, clamp behaviour) — ✅ PASS
- `pet-settings.html`: `<input type="number" min="1" max="3600" step="1" inputmode="numeric">`, label `Unattended rest interval (seconds)`
- `pet-settings-view.ts`: NaN → revert + error; out-of-range integer → clamp to nearest valid; success → update input; rejection → revert + error
- `pet-settings-preload.ts`: API method renamed `requestIdleDwellSeconds`
- Test: rewrote pet-settings-view test to use `<input type="number">` with clamp cases (0 → 1, 3601 → 3600)

## M5 — pet view (overlay) dwell wiring — ✅ PASS
- `pet-view.ts:204-211` queryDwell reads `?petIdleDwellSeconds`
- `let dwellSeconds = queryDwell();` (canonical seconds), setTimeout at `* 1000` → milliseconds for the existing timer machinery
- listener: validates integer 1..3600, sets `dwellSeconds` (next rest only)

## M6 — build + final integration — ✅ PASS
- `pnpm --dir desktop/pet build`: OK (`pet.html`, `pet-settings.html`, preloads copied)
- `pnpm --dir desktop/pet verify`: OK (`[verify] OK: pet-verify-ok static loaded`)
- `pnpm --dir desktop/electron test`: 29 files, 598 tests passing
- `pnpm --dir desktop/pet test`: 6 files, 66 tests passing
- `pnpm --dir desktop/electron typecheck`: clean
- `pnpm --dir desktop/pet typecheck`: clean
- `git diff --check`: silent
- `dist` diff: every change explained by source renames (`Ms → Seconds`, default `30_000 → 10`, validator `DWELL_VALUES.includes → 1..3600`)
- Final diff scope: 24 modified + 6 untracked (settings files + progress.md)

## Notes for reviewer
- Did not touch the 19 pre-existing file hunks other than the M1-M5 rename layering
- Did not hand-edit `dist/` (only `pnpm build` writes)
- No destructive git command; no commit; no push; no global install
- progress.md lives at `/Users/n0mad/code/phi-worktrees/fix-pet-overlay-corrective/progress.md` (worktree-local; not staged)
- Archive dir: `/var/folders/cn/h_v605nn2pv9mz92zyfyc7z40000gn/T/tmp.feIUfpTfCJ`
