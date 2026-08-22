# PORTING-PHI: syncing dsh-pet into phi

> Tracked in phi. The untracked upstream-side copy lives at `/Users/n0mad/code/dsh-pet/PORTING-PHI.md`. Audience: whoever ports the next
> dsh-pet version into phi. Snapshot: dsh-pet @ `52b313c`, 2026-08-22.

Phi consumes two things from this repo. Everything else is not ported.

## What phi consumes

| dsh-pet source | phi destination | how |
| --- | --- | --- |
| `dsh-pet/assets/thumb/*.webm` | `desktop/pet/assets/thumb/` | byte copy (`cp`) |
| `dsh-pet/assets/config.jsonc` VALUES | `desktop/pet/src/pet-config.ts` | manual value port |

Phi does NOT read `config.jsonc` at runtime. It embeds a typed fork
(`pet-config.ts`, checked by `satisfies PetConfig`). When dsh-pet changes the
config, port the values by hand. Tests prove the port; see below.

## Sync procedure (new dsh-pet release)

1. Copy media: `cp dsh-pet/assets/thumb/*.webm <phi>/desktop/pet/assets/thumb/`
   Also delete phi-side webm whose names no longer exist upstream. The
   manifest test prints both directions of drift.
2. Port config values into `pet-config.ts`:
   - `animations.idle`, `.turn`, `.drag`, `.clicks`, `.moves` (pool arrays)
   - `animations.categories[*]` — `id`, `weight`, `noMirror`, `actions`
   - `animationWeights` — `idle`, `turn`, `move`
3. Run the phi gates (from the phi repo root):

   ```sh
   pnpm --dir desktop/pet run typecheck && pnpm --dir desktop/pet run build \
     && pnpm --dir desktop/pet run test && pnpm --dir desktop/pet run verify
   ```

4. Fix what the tests report. Do not weaken a test to make it pass.

## Invariants phi enforces (the port contract)

- **Name coverage:** every animation name referenced by `pet-config.ts`
  (idle + turn + drag + clicks + moves + categories) equals, as a set, the
  webm filenames in `assets/thumb/`. Verified by `config-manifest.test.ts`.
- **Weight math:** `animationWeights.idle + turn + move` plus the sum of all
  category `weight`s equals 100. Verified by the same test.
- **Pool sizes:** 5 click reactions; `noMirror` only on the `文字` category.
- **License:** phi ships `desktop/pet/LICENSE-dsh-pet.txt`. If this repo's
  `dsh-pet/LICENSE` changes, copy the new text over.

## Not ported (yet) — forward hooks only

Phi keeps the config keys but ignores them: multi-pet (`pets`), turn/facing
mirror (`animations.turn`, `noMirror` gating), screen movement
(`animations.moves`), settings i18n, `assets/preview/` GIFs. Do not delete
these keys when porting.

## Gotchas from the 2026-08-22 port

- Old phi-era files with spaces in names (`点击回应 - *.webm`,
  `被吓一跳（炸毛）.webm`) are gone. Upstream names have no spaces; keep it
  that way.
- `handleClick` picks from `clicks`; `playRandomAct` rolls idle vs weighted
  category and never repeats the previous act. Both live in `pet-view.ts`.
- phi's renderer is ESM; its preloads are CJS. Never import preload-adjacent
  code across that boundary.
