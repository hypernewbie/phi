# @phi/pi-phi

Phi's integration endpoint inside Pi. The extension reports explicit
Pi completion to Phi's existing bell and provides read-only editor history.
It also lists and switches models through Phi's shared model picker.
It never sends prompts, compacts a session, or edits context.

## Layout

- `proto/bridge.proto` — the canonical wire schema. Generated bindings
  (`src/gen/`, Go `internal/pibridge/pb`) must be regenerated from it,
  never hand-edited.
- `src/extension-entry.cts` — the file Pi loads: the factory as the
  module itself, callable through the host loader.
- `src/extension.ts` — the factory: credential handling, process-global
  ownership, and event subscriptions.
- `src/runtime.ts` — lifecycle mapping, history and model requests, journal, and reconnect.
- `src/history-reader.ts` — checked access to the live TUI editor history.
- `src/channel.ts` — bounded-queue gRPC transport.
- `src/test-client.ts` — the synthetic peer for interop tests.
- `test/` — interop suites driven against the Go testserver.

Only type imports reference the Pi package from the bundle, so the
bundle carries no Pi runtime code. See `PROTOCOL.md` for the wire
protocol, capabilities, and bounds.

## History recall

On a connected Pi pane with `pi.history.v1`, plain Up/Down recalls Pi editor
history into Phi's staged-input box. The reader does not replace or edit the
Pi editor. Alt+Up/Down continues to use Phi's local history.

Without the bridge or history capability, the existing key behavior remains.
An unavailable editor, failed request, or timeout also keeps that behavior.
The reader checks a private Pi editor field, so compatibility requires a host check.

## Model selection

A connected Pi pane with `pi.models.v1` uses the shared Pi RPC model picker,
including its favorites. The picker requests Pi's selectable models when it opens.
Without the bridge or capability, Models keeps the legacy static presets.
A lost connection closes the picker and clears its cached list.
A partial list keeps its usable rows. A failed, timed-out, or unavailable list
read shows a neutral row and a `Use static presets` button that opens the
legacy picker; it never switches a model by itself, and the next open requests
the live list again. Pi RPC chat keeps its own error row.
A switch timeout has an unknown outcome. Reopen the picker to check the model.

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
crash — returns to the pre-bridge experience: the PTY keeps working and
Models keeps the legacy static presets. Completion then depends on Phi's
existing output heuristic alone. That heuristic does not recognize the
current Pi editor, so a bridge-free native Pi pane can stay silent. The
bridge is the only reliable completion signal for Pi; no replacement
detector is planned.

Disabling mid-session behaves the same way. `"phiBridge": { "enabled": false }`
takes effect on the next Pi start, so run `/reload` (or restart Pi) in that
pane: the bridge disconnects, the pane stays usable, and other Pi panes keep
their bridge. Pi refuses `/reload` during a response or compaction, so disable
there after the run settles. Re-enabling needs a new Pi start; the extension
scrubs provisioned credentials on disable, so a pane restart is the reliable
recovery path.

## Commands

From the Phi checkout:

- `pnpm build:pi-phi` — build the bundle.
- `pnpm check:pi-phi-generated` — fail on binding, bundle, or notice drift.
- `pnpm --filter @phi/pi-phi typecheck` — strict typecheck.
- `pnpm --filter @phi/pi-phi test` — unit suite.
- `pnpm test:pi-phi:integration` — interop over native IPC.
- `pnpm test:pi-phi:hosts` — load the bundle and check real editor history on both pinned Pi versions.

The host check covers Pi 1.0.1 and 1.3.0 in isolated profiles. Interactive
history checks require `script(1)` on macOS or Linux. The command fails if
that proof is unavailable. These checks do not establish installed-release
behavior with an existing user profile or support for other Pi versions.
