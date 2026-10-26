# Pane, events, and control WebSocket protobuf schemas

`terminal.proto` and `events.proto` define the pane and listen-only events endpoints. `control.proto` defines the chat endpoint and its bounded external-value type. One WebSocket binary message contains one generated frame. No byte-prefix or extra message-length header is added.

The terminal client frame has raw-byte input (`input=1`), checked resize geometry (`resize=2`), and message-based application ping (`ping=3`). The terminal server frame has attach (`attach=16`), raw sequenced output (`output=17`), message-based pong (`pong=18`), signed exit (`exit=19`), slow-client drop notice (`drop_notice=20`), Pi session title (`title=21`), Pi-bridge view (`bridge_state=22`), Pi-run settlement (`settlement=23`), and shared notification (`notification=24`). The bridge view retains the HTTP projection's optional thinking level, context tokens/window/percent, and compact readiness fields, along with exact uint64 identity/revision fields and presence-aware booleans. Attach preserves uint64 epoch/oldest/head frontiers, an optional replay frontier, and an optional checkpoint with kind, through sequence, geometry, opaque bytes, and optional resize-event cursor. The old WebSocket-only checkpoint byte length is omitted; consumers check the decoded byte count against the bytes field directly. Scalar fields whose absence differs from zero are proto3 `optional`.

`events.proto` defines `Notification`, the whole message of the listen-only `/ws/md-events` socket: markdown change (`markdown_changed=32`), sync change (`sync_changed=33`), and server shutdown (`shutdown=34`). Pane clients receive the same `Notification` wrapped in `TerminalServerFrame.notification`, so both endpoints share the payload type without sharing an envelope. The hub encodes each required envelope once per broadcast and routes by pane: the synthetic `@events` group receives the bare `Notification`, every other group receives the terminal frame.

`control.proto` carries the chat endpoint. `ControlClientFrame` has `hello=64` and `call=65`; `ControlServerFrame` has `welcome=80`, `response=81`, and sequenced `event=82`. Request ids and session ids live inside the typed payloads, and the result variant repeats the call variant's field number so the client checks the expected variant against its pending call instead of a generic success flag. `ControlError.error=40` carries a fixed reason and never source payloads.

| Call (field) | Required arguments | Result variant |
| --- | --- | --- |
| `spawn` (10) | optional `cwd`, optional `session_path` | `SpawnResult`: sid, title, cwd, transcript snapshot, state |
| `list_sessions` (11) | none | `ListSessionsResult`: session summaries |
| `get_state` (12) | `sid` | `StateResult` |
| `hydrate` (13), `get_messages` (14) | `sid` | `TranscriptResult`: messages, `last_seq`, state |
| `prompt` (15) | `sid`, `message`, optional `streaming_behavior` | `PromptResult`: accepted |
| `get_available_models` (16) | `sid` | `ModelsResult`: provider, id, optional name |
| `set_model` (17) | `sid`, `provider`, `model_id` | `StateResult` |
| `get_available_thinking_levels` (18) | `sid` | `ThinkingLevelsResult` |
| `set_thinking` (19) | `sid`, `level` | `StateResult` |
| `new_session` (20) | `sid` | `NewSessionResult`: cancelled, optional reset, optional state, optional state warning |
| `abort` (21) | `sid` | `AbortResult`: aborted |
| `compact` (22) | `sid` | `CompactResult`: state, optional state warning |
| `set_session_name` (23) | `sid`, `name` | `StateResult` |
| `subagent_transcript` (24) | `run_id` | `SubagentTranscriptResult`: run id, steps with label, session file, messages |
| `view_ready` (25), `set_capabilities` (26), `wait_view_ready` (27), `dlg` (28), `dlg_closed` (29), `activate_tab` (30) | optional `sid` | `StubResult`: stubbed |

`ControlState` keeps the six nullable token counters optional, so an absent counter maps to the UI's null rather than zero. `status` keeps the existing `live`/`exited` values, and `session_path` is optional so an update that omits it cannot erase an already-published path. `StateChangedEvent` is a oneof: a complete `ControlState` or an error-only update that must not reset model, busy, counters, title, or session path. `NewSessionResult` and `CompactResult` keep a completed operation visible with `state_warning` when only the follow-up state refresh failed.

The 13 sequenced events are `state_changed` (10), `message_start` (11), `message_update` (12), `message_end` (13), `transcript_reset` (14), `rpc_exited` (15), `subagent_fleet` (16), `auto_retry_start` (17), `auto_retry_end` (18), `summarization_retry_scheduled` (19), `summarization_retry_finished` (20), `compaction_end` (21), and `extension_error` (22).

`ExternalValue` carries open-ended Pi, tool, provider, and extension data as null, bool, number, int, string, list, or object. Objects use repeated `ExternalEntry` key/value pairs rather than a protobuf map so reserved keys such as `__proto__` survive a round trip. It never substitutes for a known Phi-owned payload and never carries a serialized JSON string. Conversion limits are depth 24 and 100,000 nodes, with duplicate keys, missing variants, cycles, and nonfinite numbers rejected.

Old wire mapping, for fixture migration: `0x02` session-title JSON became `TerminalTitle`; `0x02` bridge/settlement JSON became `TerminalBridgeState`/`TerminalSettlement`; `0x02` output-dropped JSON became `TerminalDropNotice`; `0x05` shutdown JSON became `Notification.shutdown`; `0x07` md-changed JSON became `Notification.markdown_changed`; `0x0a` sync JSON became `Notification.sync_changed`. String vocabularies shared with HTTP JSON (bridge state, outcome, sync action) stay typed string fields with their existing values; bridge identifiers stay exact uint64 on the wire and convert to decimal strings where the UI expects them.

## Generate, build, check, and watch

The root package pins the local Buf, ts-proto, protobuf runtime, and esbuild tools. The Go plugin is built from the repository's pinned Go module into ignored `.tools/websocket/`; generation never uploads schemas.

- `pnpm gen:websocket` generates Go bindings in `pkg/ws/pb/`, ts-proto source in `proto/websocket/gen-ts/`, declaration-only types in `web-src/proto/`, and browser ESM assets in `web/proto/`.
- `pnpm build:web` retains the application TypeScript build and then bundles the browser codec entries/runtime for ES2022. Application source imports resolve to declarations; the raw generated TS is not emitted into `web/`.
- `pnpm check:websocket-generated` regenerates all four output trees in a temporary directory and compares complete relative file sets and bytes. It does not use Git status and does not overwrite checked outputs.
- `pnpm watch:web` watches only the application TypeScript build. It does not rebuild or overwrite `web/proto/`. After editing a schema, run generation and the normal build again.

Only the owned generated output trees are replaced during generation; the rest of `web/` is left intact. Browser assets contain bundled ESM and `NOTICES.txt`, without source maps, declarations, test files, metadata dumps, or bare Node/gRPC/package imports. The notice includes the protobuf runtime's license text.

## Rollout

The terminal schema is an intermediate migration state, not a deployable compatibility release. A full cutover requires coordinated server and frontend builds, a server restart, a frontend reload, and a matching `phic` client replacement. Old byte-prefix clients do not have a fallback and will not interoperate with protobuf frames.
