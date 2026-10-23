# Phi ↔ Pi bridge protocol

Wire contract between Phi (Go gRPC server) and the Phi-maintained Pi
extension (TypeScript client). Canonical schema:
`bonus/pi-phi/proto/bridge.proto`. This document explains the contract;
the schema defines it.

## Roles and transport

- Phi owns one local-IPC gRPC server per Phi process. One bidirectional
  `Connect` stream per provisioned Pi process. The extension dials;
  Phi answers with `Accepted` or a terminal `ProtocolError`.
- Unix-domain socket on macOS/Linux (`unix:` + absolute path, no
  authority, no percent encoding). Local named pipe on Windows
  (`unix:` + literal `\\.\pipe\phi-pi-<hex>`).
- No TCP listener, no TCP fallback, no per-event connections. Proxies
  are disabled on the bridge client.
- Binary Protobuf with generated bindings in both languages. Field
  numbers are stable; deleted numbers stay reserved.

## Provisioning and identity

Phi provisions before spawn; nothing is published or connected earlier.

1. Phi registers a pending lease: pane ID (Phi tab), process nonce,
   32-byte token (hex in the child environment only).
2. Phi spawns Pi with credentials in the child environment and
   `--extension <runtime artifact>` before any `--` terminator.
3. On spawn success the lease goes live. Spawn failure, process exit,
   kill, or shutdown revokes the lease and closes the stream.

Child environment (exact names):

| Variable        | Content                                  |
| --------------- | ---------------------------------------- |
| `PHI_PI_BRIDGE_ENDPOINT`   | Dial target, server-generated shape only |
| `PHI_PI_BRIDGE_PANE_ID`    | Pane ID                                  |
| `PHI_PI_BRIDGE_PROCESS_ID` | Process nonce                            |
| `PHI_PI_BRIDGE_TOKEN`      | 64 lowercase hex chars, 32 bytes         |

gRPC metadata carries pane, process, and token on every stream. The
extension deletes all four variables from `process.env` after reading
them at session start, so agent-spawned tools cannot inherit them. A
copy stays in the process owner slot so a reload in the same process
can reconnect. The token never appears in logs, persistence, argv,
browser data, or result artifacts.

## Handshake

First message must be `Hello` within 5 seconds of admission:

- `protocol_version` must equal 1 (separate from package version).
- `runtime_id` and `session_id` are required.
- `capabilities` advertises what this runtime implements. Phi accepts
  the known subset and confirms it in `Accepted`. Unknown names are
  ignored, never an error.
- `current_state` carries the authoritative baseline (state, session,
  leaf, model, retained journal, revision).

Runtime identity binds `(generation, runtime_id, session_id)`:

- The first claimed runtime in a Pi process uses generation 1. Each
  later runtime (reload, session replacement) increments it.
- A lower generation is stale and rejected. The same generation with
  different IDs is a conflicting runtime and rejected. The same
  generation with the same IDs replaces the old stream atomically.
- Transport reconnects reuse the generation; only a new runtime
  increments it.

## Capabilities

| Name              | Meaning                                          |
| ----------------- | ------------------------------------------------ |
| `pi.lifecycle.v1` | Lifecycle edges, snapshots, settlement           |
| `pi.history.v1`   | On-demand live editor-history reads              |

## History reads

`pi.history.v1` is a best-effort request/response pair over the
shared stream. Phi sends `HistoryRequest` (field 14) with a
correlating `request_id`; the extension answers `HistoryResponse`
(field 17) echoing the id with the newest-first snapshot, or
`unavailable` when no history-shaped editor is readable or the
snapshot exceeds the message bound. Unknown, duplicate, and late
responses are dropped, never protocol errors.

History responses share the bounded send queue with lifecycle
edges, so admission keeps explicit lifecycle headroom (16 KiB and two
message slots). A history frame admits only while the queue retains that headroom
after admission. Admission failure fails only the request — it
never closes the stream — and Phi falls back to pre-bridge
behavior on any failure or a 1 s timeout.

## Lifecycle events

The extension maps Pi events to bridge edges with a monotonic
`event_sequence` (starts at 1, never reused) and a `run_id` that opens
on the first `agent_start` while idle and continues across retries,
compaction recovery, and queued work until settlement:

- `agent_start` while idle opens a run and emits `AgentStarted`.
  Further starts before settlement continue the same run.
- `agent_settled` for an observed run emits `AgentSettled` and returns
  to idle. A settlement with no observed run is ignored: unobserved
  work must not ring the bell.
- Outcome comes from the settling event plus the final assistant
  stop reason (`agent_end`): an abort flag or `aborted` evidence maps
  to `ABORTED`; a clean `stop` maps to `COMPLETED`, meaning settled
  without observed cancellation, not success; `error` maps to `ERROR`;
  anything else stays explicitly `UNSPECIFIED`. An old outcome is
  never reused for a later run. Pi 1.0.1 reports no abort bit, so
  its settlements classify from stop evidence alone.

`StateSnapshot` is authoritative current state, sent on hello,
reconnect, and every transition. It carries the retained journal (at
most 64 rows, oldest dropped first with `journal_gap` latched) and
the state revision.

Phi numbers every publication of that state with a server-owned
`telemetry_revision`: a process-monotonic uint64 allocated at lease
creation and at each accepted Hello/state change, published as a
decimal string in HTTP/attach/WS `pi-bridge-state` views. It is not
the Pi `state_revision` and needs no schema change. A same-generation
Hello without a snapshot republishes the retained state at a new
revision; a new generation without state publishes unknown
model/usage. Consumers accept only newer revisions and treat equal
revisions as idempotent, so delayed callbacks can never show stale
model text.

## Bounds

| Bound                        | Value                      |
| ---------------------------- | -------------------------- |
| Hello                        | 16 KiB                     |
| gRPC metadata                | 8 KiB                      |
| Message                      | 256 KiB                    |
| Send queue per peer          | 16 messages and 256 KiB    |
| Pending history reads per peer | 4 (including awaiting replies) |
| Blocked send                 | 5 s, then the stream ends  |
| Journal rows retained        | 64, then gap latches       |

Lifecycle queue overflow and blocked sends end only the affected stream
with an explicit status. History admission failure does not end the stream.
Lease, journal, and last state survive for reconnect.

## Status mapping

| Condition                                        | Code                  |
| ------------------------------------------------ | --------------------- |
| Missing/bad credentials, unknown process         | `Unauthenticated`     |
| Pane or identity mismatch                        | `PermissionDenied`    |
| Wrong protocol version, stale/conflicting runtime| `FailedPrecondition` |
| Oversized hello                                  | `ResourceExhausted`   |
| Lifecycle queue overflow     | `ResourceExhausted`   |
| Malformed or out-of-bound payload                | `InvalidArgument`     |
| Revoke, replace, client cancel                   | `Cancelled`           |
| Send failure or blocked send                     | `Unavailable`         |
| Hello after the deadline                         | `DeadlineExceeded`    |

`Cancelled` on a stream the runtime did not close means the lease is
gone; the runtime must not retry. `Unauthenticated`,
`PermissionDenied`, and `FailedPrecondition` are likewise terminal.
Other failures retry with bounded backoff on the same generation.

## Supported hosts

- The packaged-host check covers pinned Pi 1.0.1 and 1.3.0: extension factory,
  `session_start`, `agent_start`, `agent_settled`, `session_shutdown`,
  `ReadonlySessionManager` identity readers, `ctx.model`.
- The `aborted` bit on `agent_settled` exists on 1.3.0 only. Code must
  read it defensively and behave on 1.0.1 without it. Both hosts
  emit `agent_end` with assistant stop reasons for classification.
- History checks use real interactive editors on both pinned hosts.
  The reader also depends on a checked private `history` array, reached
  through the live TUI widget factory. An incompatible editor returns
  unavailable instead of changing Pi behavior.
- Other Pi versions and installed-release behavior with existing user
  profiles remain unverified.

## Installation

Phi provisions the canonical `dist/pi-phi-extension.cjs` bundle
privately per launch with explicit `--extension` pointing at the
bundle; no global install, no settings change, no preinstalled
package. If provisioning fails before spawn,
Phi launches Pi normally without Phi-owned arguments or credentials.
If the plugin fails later, integration features disable themselves
without killing or restarting Pi. Duplicate loads (user package plus
Phi injection) yield one owner; the rest stay inert.

## Adding a capability

1. Extend `bridge.proto` with new messages and `oneof` alternatives.
   Never renumber or reuse field numbers.
2. Regenerate with `pnpm gen:pi-phi` and confirm
   `pnpm check:pi-phi-generated` passes.
3. Add a named capability string, a validated handler on each side,
   capability-gated tests, and a row in this document.
4. Never add reflection, shell execution, or a raw SDK gateway.
