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
| `PHI_PI_ATTACHMENT_ROOT`   | Absolute private handoff directory for this Pi process |

gRPC metadata carries pane, process, and token on every stream. The
extension deletes all five variables from `process.env` after reading
them at session start, so agent-spawned tools cannot inherit them. The
process owner slot retains the bridge credentials and handoff root across
extension reloads in the same process. The token never appears in logs,
persistence, argv, browser data, or result artifacts.

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
| `pi.models.v1`    | On-demand model list and switching               |
| `pi.thinking.v1`  | On-demand thinking-level reads and setting       |
| `pi.context.v1`   | Context usage telemetry in snapshots             |
| `pi.compact.v1`   | Native compaction on explicit user action        |
| `pi.reload.v1`    | Native `/reload` dispatch from an interactive editor |
| `pi.skills.v1`    | On-demand skill list and skill invocation        |
| `pi.syncboard.v1` | Direct Pi tool for the owning Phi Syncboard      |
| `pi.attachments.v3` | Explicit user-triggered attachment prompt dispatch |
| `pi.state.v2` | Read-only live identity and readiness refresh |

Context, Compact, and Reload negotiate independently on every Hello
from checked host availability: `pi.context.v1` needs `getContextUsage`;
`pi.compact.v1` needs the `compact`/`isIdle`/`hasPendingMessages` trio;
`pi.reload.v1` needs the checked interactive editor baseline plus
`isIdle`/`hasPendingMessages`. Any may be absent without disabling
lifecycle, models, or history.

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

## Model list and switching

`pi.models.v1` is two best-effort request/response pairs over the
shared stream, always advertised: the registry and the host switch
call exist in every mode. Phi sends `ModelsRequest` (field 15)
with a correlating `request_id`; the extension answers
`ModelsResponse` (field 18) echoing the id with the selectable
catalog — scoped entries when session scoping is configured,
otherwise `getAvailable()` — capped at 500 entries with `truncated`,
or `unavailable` when the answer exceeds the message bound. Phi
sends `SetModelRequest` (field 16) naming one entry; the extension
resolves it against the scope (when set) or the registry and
answers `SetModelAck` (field 19): `ok` with an empty reason, or a
refusal with `no-auth` (no provider credentials) or
`unknown-model` (unresolvable or out of scope). `ok=false` with an
empty reason means the switch attempt itself errored and its
outcome is unknown. A successful switch
emits `model_select`, so the current-model snapshot follows with no
explicit publish. Queue, admission, and drop semantics match history
reads. Model HTTP handlers allow 30 seconds for local IPC, while the
browser allows 45 seconds including network and offline queue time.
The browser retries only catalog reads, never dispatched model changes;
a change picked offline is held and sent after its session is rechecked.
Phi renders the last good catalog while a refresh runs, surfaces refresh
failures as an in-picker note, and keeps partial lists usable.

## Thinking reads and setting

`pi.thinking.v1` is two best-effort request/response pairs over the
shared stream, advertised only when the host exposes both the
thinking-level getter and setter. Phi sends `ThinkingLevelsRequest`
(field 17) with a correlating `request_id`; the extension answers
`ThinkingLevelsResponse` (field 20) echoing the id with the levels
supported by the live session model plus the source provider/model,
or `unavailable` when the model or native helper cannot be read
safely. Phi sends `SetThinkingRequest` (field 18) naming one level
with the expected provider/model; the extension answers
`SetThinkingAck` (field 21): `ok` after an effective native readback,
`unsupported-level` (no longer supported) or `model-changed` (the
live model moved). `ok=false` with an empty reason means the outcome
is unknown. The current level also rides
`StateSnapshot.thinking_level` (field 9); unrecognized names degrade
to unknown downstream and never reject a snapshot. Queue, admission,
drop, and timeout semantics match history reads; Phi surfaces list
failures inside the picker and without the capability falls back to
the native Pi picker.

## Skill list and invocation

`pi.skills.v1` is two best-effort request/response pairs over the
shared stream, advertised only when the host exposes both the skill
list and the skill dispatch call. Phi sends `SkillsRequest` (field
20) with a correlating `request_id`; the extension answers
`SkillsResponse` (field 23) echoing the id with the skills the live
session knows - name and description only - capped at 200 entries
with `truncated`, or `unavailable` when the answer cannot be
represented on the wire. The bounds are the bridge's, not Pi's: name
<= 64 UTF-8 bytes, description <= 1024 UTF-8 bytes. Pi validates
character counts and only warns, so one entry can break the byte
bounds; such a list answers `unavailable` as a whole, because entries
are never silently omitted. Phi sends `InvokeSkillRequest` (field
21) naming one skill; the extension answers `InvokeSkillAck` (field
24): `ok` with an empty reason when the request was dispatched to the
Pi host, or a refusal with `unknown-skill` (the session does not know
the name), `unavailable` (the host call is missing or failed), or
`error`. `ok=true` means dispatched, never accepted or completed:
later Pi-side failures (no model, no credentials) are not observable
here. Every invocation carries the origin of the list that produced
the row: the answering process and runtime generation. A session that
moved on refuses the request before any dispatch, so a click never
lands in a runtime that replaced the one the list came from. Queue,
admission, drop, and timeout semantics match history
reads; Phi shows the picker only while the capability is live and
shows nothing at all without it.

## Native Syncboard tool

`pi.syncboard.v1` is advertised only when the Phi extension owns the
native `syncboard` tool registration. Phi negotiates the capability only
when it has a Syncboard handler. Pi keeps the tool hidden until Phi accepts
the capability, withdraws it when the stream loses availability, and checks
availability again before each call. Without the bridge or capability, Pi
keeps its existing tools and behavior.

Pi sends `SyncboardRequest` (field 26) with a canonical positive decimal
request ID. Phi answers `SyncboardResponse` (field 23) with the same ID.
The request contains only an operation and operation data. It never names
a coordinator URL. Phi reads its own current `sync_coordinator` setting for
each call. A changed setting takes effect on the next call. An unset setting
uses the owning Phi store directly. Phi also dispatches directly when a
configured root `http` URL uses a literal IP address and port equal to the
published listener address. It does not resolve hostnames. HTTPS, hostnames,
path prefixes, wildcard listeners, other ports, and other addresses keep the
HTTP path.

The tool supports `list`, `get`, `upsert`, and `delete`. List returns board
messages. Get returns the message or `{found:false,key}` for HTTP 404. Upsert
stores the JSON value as the message value and returns the message. Delete
returns `{deleted:true,key,already_absent:false}` for HTTP 200 and
`{deleted:true,key,already_absent:true}` for HTTP 404. Phi rejects invalid
input before dispatch. The caller must not retry a mutation when the outcome
is unknown. Read the key after reconnection before deciding what to do.

A refusal before dispatch returns `NOT_SENT`. A complete HTTP response
returns `HTTP_RESPONSE`, including an HTTP error status. An internal handler
response uses the same API status and body checks. The internal handler does
not observe request cancellation. A local mutation can finish after its
caller disconnects, so a lost reply remains `UNKNOWN`. A transport failure,
invalid or oversized response, timeout, or lost reply also returns `UNKNOWN`.
Phi never replays a request after dispatch. Duplicate or older request IDs
are dropped. Requests run outside the stream reader and do not block
lifecycle messages. The worker limit is four per peer.

The value limit is 64 KiB and the response limit is 192 KiB. The Pi caller
waits up to 15 seconds. Phi's remote HTTP request deadline is 10 seconds. The
shared stream retains 16 KiB and two message slots for lifecycle traffic.

## Live state reads

`pi.state.v2` lets Phi request a fresh snapshot instead of trusting the last
lifecycle event. It is advertised with attachment support. Phi sends
`StateRequest` (field 25) with a correlating request ID. The extension reads
live session, leaf, model, and readiness, then sends a normal `StateSnapshot`
with that ID in field 13. A failed identity read sends no confirmation.
The server applies the validated snapshot before releasing the waiter.
Requests use bounded nonfatal queues and at most four waiters per peer;
timeout, disconnect, and peer replacement fail only the read. No input is sent.

The attachment context HTTP read requests this refresh when the capability is
present. Older runtimes keep their cached-context behavior. A new online send
also reads context before freezing its outbox entry: it can bind a fresh leaf
in the same process, runtime, session, and model. This covers idle extension
metadata writes, which move Pi's leaf without a lifecycle event. Saved and
offline outbox entries keep their original leaf and are never rebound or
replayed. The composer responds locally before the background read completes.

## Attachment prompt dispatch

`pi.attachments.v3` is advertised only when the provisioned absolute
`PHI_PI_ATTACHMENT_ROOT` is a checked directory and the public host exposes
`sendUserMessage`, session identity, `isIdle`, and `hasPendingMessages`.
Attachment readiness is independent of `pi.compact.v1`; it samples compact
activity and unresolved bridge work without requiring the Compact API.
If any required facility is absent, the extension does not advertise this
capability. Other capabilities and the ordinary Pi input path remain usable.

Version 3 uses request field 24, acknowledgment field 27, and snapshot
readiness field 14. Released Reload fields 22, 25, and 12 and Syncboard
request/response fields 26 and 23 keep their meanings. The incompatible
`pi.attachments.v1`, `pi.attachments.v2`, and `pi.state.v1` review protocols
are not negotiated or aliased. Live state reads require `pi.state.v2` at
request field 25. Mixed-version peers retain their other capabilities;
new attachment sends stay unavailable until both peers support version 3.

Phi sends `AttachmentPromptRequest` (field 24) only after an explicit user
Send action. It contains one complete user message: bounded text plus checked
references, not file bytes. Each reference carries a generated basename,
size, MIME type, kind, and SHA-256. The extension accepts basenames only
inside the provisioned process root; it rejects traversal, symlinks,
non-regular files, changed size, wrong digest, and unsupported image data.
`PHI_PI_ATTACHMENT_ROOT` points to
`<PhiDataDir>/attachments-v2/handoff/<process-id>/`. The host opens a checked
descriptor and reads at most 25 MiB per file. It never reads a browser path.

PNG and JPEG are the only native image formats. The host sends their bytes as
Pi image content. A file is represented by labelled text containing its
JSON-quoted absolute private snapshot path; Pi's ordinary file tools can read
that snapshot. Unknown or unsupported image types are refused and are never
silently converted to a path. Phi and the bridge allow at most eight
references and 50 MiB total, with
64 KiB of UTF-8 prompt text. No image bytes travel in the bridge message.

Before the host call, the extension rechecks runtime, session, leaf, model,
readiness, and image-input support. Image sends refuse unknown, text-only, or
`pi-virtual` models. Commands beginning with `/` or `!`, busy/queued work,
active compaction, and unresolved bridge work are also refused. No attachment
prompt enters Pi's follow-up queue. One handler may be active per Pi process;
request IDs are monotonic decimal values retained across reconnects. Duplicate
or older IDs are refused, and reconnect never replays an operation.

`AttachmentPromptAck` (field 27) echoes the request ID. `REFUSED` means a
known refusal before `sendUserMessage`. `DISPATCHED` means the public
`sendUserMessage(content, { expandPromptTemplates: false })` call returned
normally and Phi received the matching acknowledgment. It does **not** prove
that Pi accepted the input, that hooks preserved the content, that the model
received an image, or that a provider completed. A synchronous throw after
invocation begins, a lost acknowledgment, or peer loss is `UNKNOWN`; it is
never converted to refusal or retried. Later asynchronous Pi errors cannot be
correlated to this request. Phi displays “Submitted to Pi,” not “Model
received images.” Pi's input/context hooks and later model changes can still
transform the request.

The bridge envelope remains bounded to 256 KiB. The request contains only
text and references; no base64 or file contents are placed on IPC.

## Context telemetry

`pi.context.v1` carries `ContextUsageSnapshot` (field 10) inside
`StateSnapshot`: `tokens`, `context_window`, `percent`, each with
explicit presence. Absent tokens/percent means the host reports
unknown, never zero; the window stays present when known, including
right after a compaction whose token count is still unknown. An
explicit zero stays a present zero. Percent without a token count
is rejected, as are nonfinite, negative, over-magnitude, or
nonpositive-window fields. Sampling is event-driven — baseline and
reconnect, completed assistant messages, settlement, model, session
and tree changes, compaction outcome — never per token. Context-only
updates use bounded nonfatal admission; the next authoritative
snapshot carries the latest measurement when one cannot enter.

Phi republishes telemetry in terminal HTTP views, attach snapshots,
and `pi-bridge-state` frames under the same names:
`context_tokens`, `context_window`, `context_percent`. Absent
fields mean unknown. Consumers fence on generation and
`telemetry_revision`; equal revisions compare the telemetry fields
and conflicting equal revisions never refresh stale data.

## Native Compact

`pi.compact.v1` runs one native compaction per Pi process with no
server-side waiting queue, only on an explicit user action through the
existing control. Phi's browser may hold one press until the current
turn settles, then dispatch it after a fresh readiness check; the
bridge itself still sees one immediate request or a refusal. A held
press is cancelled if a newer turn starts, messages queue, or another
compaction starts, and is never replayed after dispatch. Phi sends
`CompactRequest` (field 19) with a server-allocated monotonic decimal
ID (opaque to browsers) and the expected session/leaf/model captured
from the lease under the admission fence. Server admission needs a
live peer, the negotiated capability, matching generation/publication
stamps, and a snapshot showing an idle host with no queued messages,
no active compaction, and no unresolved bridge work. Anything else
is refused before start or unavailable, and the host is never invoked.

The extension rechecks live identity, idleness, queued messages,
and local compaction state immediately before invocation, and
rejects duplicate or older IDs against a process high-water mark.
Invocation uses the public `compact({ onComplete, onError })`
without summary overrides. Only the completion callback
establishes success. The extension answers `CompactResult`
(field 22) echoing the ID verbatim with one terminal outcome —
`COMPLETED`, `REFUSED`, `FAILED`, `CANCELLED`, `UNSPECIFIED` — and
a fixed safe reason: empty, `duplicate`, `stale`, `busy`, `queued`,
`compaction-active`, `pending`, `unavailable`, `cancelled`,
`already-compacted`, `error`, or `uncertain`. Foreign reasons
coerce to empty. Results with an empty, unknown, unsolicited,
duplicate, or old-generation ID are dropped, never protocol
errors.

Uncertainty never replays. A caller wait that expires or aborts, a
peer disconnect, or a runtime replacement leaves the process-owned
operation unresolved: no second invocation starts while native work
may still run, and reconnects never resend the request. A late
callback releases only its matching operation. `UNSPECIFIED` keeps
the latch on both sides. A new generation clears request state;
unresolved native work still reports through the fresh authoritative
readiness, and a pending-to-released readiness transition on the
current runtime retires the record. After dispatch, an expired or
interrupted wait reports unknown, never success and never a
terminal-command retry.

## Native Reload

`pi.reload.v1` is negotiated independently from Compact. It requires the
checked stock interactive editor baseline and the host's `isIdle` and
`hasPendingMessages` readers; print-mode Pi does not advertise it. Phi sends
`ReloadRequest` (field 22) with a monotonic decimal ID plus the admitted
session, leaf, model, run, and context fences. The extension rereads these
values and host readiness immediately before entering the editor's fixed
`/reload` callback. It never sends `/reload` through the PTY.

`ReloadAck` (field 25) reports callback entry only: `DISPATCHED` is not
reload completion. A refusal reports one safe reason: `duplicate`, `stale`,
`busy`, `queued`, `compaction-active`, `pending`, or `unavailable`. Pi keeps a
process-owned latch until the callback settles and publishes fresh readiness.
Phi keeps the operation unresolved until a same-process readiness snapshot
covers its ID and explicitly clears `reload_pending`. Reload, Compact, and
attachment preparation are mutually exclusive while an operation is unresolved.
Attachment dispatch also rechecks the process-owned Reload latch immediately
before the host call. A timeout, lost
receipt, disconnect, or runtime replacement does not permit replay. When
shutdown follows dispatch, the extension drains and half-closes the receipt
stream, then waits for server status before a replacement runtime sends Hello.
If an admitted request never reaches Pi, the server cannot prove release; it
stays pending until the Pi process exits.

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
| Pending compact per process    | 1, no waiting queue            |
| Pending Syncboard requests per peer | 4                         |
| Syncboard value JSON            | 64 KiB                          |
| Syncboard response body         | 192 KiB                         |
| Syncboard caller wait           | 15 s                            |
| Syncboard coordinator request   | 10 s                            |
| Pending attachment prompt per process | 1, no waiting queue      |
| Attachment references in one bridge request | 8 max, 50 MiB total |
| Attachment prompt text         | 64 KiB UTF-8 max               |
| Attachment handoff file        | 25 MiB max                     |
| Compact caller wait            | 120 s server, 125 s browser; expiry reports unknown |
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
  `ReadonlySessionManager` identity readers, `ctx.model`, and interactive
  attachment dispatch with native image content.
- The `aborted` bit on `agent_settled` exists on 1.3.0 only. Code must
  read it defensively and behave on 1.0.1 without it. Both hosts
  emit `agent_end` with assistant stop reasons for classification.
- History checks use real interactive editors on both pinned hosts.
  The reader also depends on a checked private `history` array, reached
  through the live TUI widget factory. An incompatible editor returns
  unavailable instead of changing Pi behavior.
- Both pinned hosts expose the context and compact host APIs in print
  and interactive modes: print runs advertise `pi.compact.v1`,
  `pi.context.v1`, `pi.lifecycle.v1`, `pi.models.v1`; interactive runs
  add `pi.history.v1` and advertise `pi.reload.v1` when the checked stock
  editor baseline is available. They add `pi.attachments.v3` when the
  private handoff root and attachment host APIs are available.
- The Reload desktop/mobile browser flow also passed on Pi 1.4.0 in
  isolated state. Other Pi versions and installed-release behavior with
  existing user profiles remain unverified.

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
