# @phi/pi-phi

Phi's integration endpoint inside Pi. The extension reports explicit
Pi completion to Phi's existing bell. It never changes the Pi
conversation: no prompts, no compaction, no context edits.

## Layout

- `proto/bridge.proto` — the canonical wire schema. Generated bindings
  (`src/gen/`, Go `internal/pibridge/pb`) must be regenerated from it,
  never hand-edited.
- `src/extension-entry.cts` — the file Pi loads: the factory as the
  module itself, callable through the host loader.
- `src/extension.ts` — the factory: credential handling, process-global
  ownership, and event subscriptions.
- `src/runtime.ts` — lifecycle mapping, journal, and reconnect.
- `src/channel.ts` — bounded-queue gRPC transport.
- `src/test-client.ts` — the synthetic peer for interop tests.
- `test/` — interop suites driven against the Go testserver.

Only type imports reference the Pi package from the bundle, so the
bundle carries no Pi runtime code. See `PROTOCOL.md` for the wire
protocol, capabilities, and bounds.

## Toggles and manual install

Two switches, one per side. Defaults bridge every phi-spawned Pi.

- Phi side: Settings → "Skip Phi bridge injection for pi". Phi
  still provisions the lease and child credentials, but omits
  `--extension`. For users who install the extension themselves.
- Pi side: `"phiBridge": { "enabled": false }` in Pi settings.
  The extension scrubs provisioned credentials and stays inert,
  injected or installed. Takes effect on next Pi start.

Manual install: phi keeps a stable copy at
`~/.phi/pi-bridge/pi-phi-extension.cjs` (rewritten when the bundled
build differs, and never when the installed copy is newer). With Phi's
`--data-dir`, use `<data-dir>/pi-bridge/pi-phi-extension.cjs` instead. Add this
file path to Pi settings `packages` yourself; phi never edits Pi
settings, it only keeps the copy current:

```json
{
  "packages": ["/Users/you/.phi/pi-bridge/pi-phi-extension.cjs"]
}
```

(An explicit file path loads `.cjs`; only the extensions-directory
scan is limited to `.js`/`.ts`.) A managed pane whose bridge never
connects — disabled in Pi, manual install missing, or a pre-hello
crash — keeps the output heuristic, so a silent bridge never means
no completion signal at all.

## Commands

From the Phi checkout:

- `pnpm build:pi-phi` — build the bundle.
- `pnpm check:pi-phi-generated` — fail on binding drift.
- `pnpm --filter @phi/pi-phi typecheck` — strict typecheck.
- `pnpm --filter @phi/pi-phi test` — unit suite.
- `pnpm test:pi-phi:integration` — interop over native IPC.
- `pnpm test:pi-phi:hosts` — both pinned Pi versions load the bundle.
