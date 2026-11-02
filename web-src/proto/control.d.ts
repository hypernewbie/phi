import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
export declare const protobufPackage = "phi.websocket.control.v1";
export declare const protobufFileName = "control.proto";
/**
 * Control is the chat endpoint. One WebSocket binary message carries one
 * ControlClientFrame or one ControlServerFrame. Request ids and session ids
 * stay inside the typed call/response/event payloads.
 */
export interface ControlClientFrame {
    payload: {
        $case: "hello";
        value: ControlHello;
    } | {
        $case: "call";
        value: ControlCall;
    } | undefined;
}
export interface ControlServerFrame {
    payload: {
        $case: "welcome";
        value: ControlWelcome;
    } | {
        $case: "response";
        value: ControlResponse;
    } | {
        $case: "event";
        value: ControlEvent;
    } | undefined;
}
export interface ControlHello {
    version: number;
}
export interface ControlWelcome {
    version: number;
}
/**
 * ControlCall is one request. The variant names the operation, so the server
 * checks the expected result variant against the pending call instead of a
 * generic success flag.
 */
export interface ControlCall {
    id: string;
    call: {
        $case: "spawn";
        value: SpawnCall;
    } | {
        $case: "listSessions";
        value: ListSessionsCall;
    } | {
        $case: "getState";
        value: GetStateCall;
    } | {
        $case: "hydrate";
        value: HydrateCall;
    } | {
        $case: "getMessages";
        value: GetMessagesCall;
    } | {
        $case: "prompt";
        value: PromptCall;
    } | {
        $case: "getAvailableModels";
        value: GetAvailableModelsCall;
    } | {
        $case: "setModel";
        value: SetModelCall;
    } | {
        $case: "getAvailableThinkingLevels";
        value: GetAvailableThinkingLevelsCall;
    } | {
        $case: "setThinking";
        value: SetThinkingCall;
    } | {
        $case: "newSession";
        value: NewSessionCall;
    } | {
        $case: "abort";
        value: AbortCall;
    } | {
        $case: "compact";
        value: CompactCall;
    } | {
        $case: "setSessionName";
        value: SetSessionNameCall;
    } | {
        $case: "subagentTranscript";
        value: SubagentTranscriptCall;
    } | {
        $case: "viewReady";
        value: ViewReadyCall;
    } | {
        $case: "setCapabilities";
        value: SetCapabilitiesCall;
    } | {
        $case: "waitViewReady";
        value: WaitViewReadyCall;
    } | {
        $case: "dlg";
        value: DlgCall;
    } | {
        $case: "dlgClosed";
        value: DlgClosedCall;
    } | {
        $case: "activateTab";
        value: ActivateTabCall;
    } | {
        $case: "queueSubmit";
        value: QueueSubmitCall;
    } | {
        $case: "queueRestore";
        value: QueueRestoreCall;
    } | {
        $case: "queueCopy";
        value: QueueCopyCall;
    } | {
        $case: "queueDiscard";
        value: QueueDiscardCall;
    } | {
        $case: "extensionUiResponse";
        value: ExtensionUIResponseCall;
    } | {
        $case: "extensionUiCancel";
        value: ExtensionUICancelCall;
    } | undefined;
}
/**
 * ControlResponse correlates one reply with one call id. Exactly one result
 * variant is set; error carries a fixed reason without source payloads.
 */
export interface ControlResponse {
    id: string;
    result: {
        $case: "error";
        value: ControlError;
    } | {
        $case: "spawn";
        value: SpawnResult;
    } | {
        $case: "listSessions";
        value: ListSessionsResult;
    } | {
        $case: "getState";
        value: StateResult;
    } | {
        $case: "hydrate";
        value: TranscriptResult;
    } | {
        $case: "getMessages";
        value: TranscriptResult;
    } | {
        $case: "prompt";
        value: PromptResult;
    } | {
        $case: "getAvailableModels";
        value: ModelsResult;
    } | {
        $case: "setModel";
        value: StateResult;
    } | {
        $case: "getAvailableThinkingLevels";
        value: ThinkingLevelsResult;
    } | {
        $case: "setThinking";
        value: StateResult;
    } | {
        $case: "newSession";
        value: NewSessionResult;
    } | {
        $case: "abort";
        value: AbortResult;
    } | {
        $case: "compact";
        value: CompactResult;
    } | {
        $case: "setSessionName";
        value: StateResult;
    } | {
        $case: "subagentTranscript";
        value: SubagentTranscriptResult;
    } | {
        $case: "viewReady";
        value: StubResult;
    } | {
        $case: "setCapabilities";
        value: StubResult;
    } | {
        $case: "waitViewReady";
        value: StubResult;
    } | {
        $case: "dlg";
        value: StubResult;
    } | {
        $case: "dlgClosed";
        value: StubResult;
    } | {
        $case: "activateTab";
        value: StubResult;
    } | {
        $case: "queueSubmit";
        value: QueueItemResult;
    } | {
        $case: "queueRestore";
        value: QueueRestoreResult;
    } | {
        $case: "queueCopy";
        value: QueueCopyResult;
    } | {
        $case: "queueDiscard";
        value: QueueDiscardResult;
    } | {
        $case: "extensionUiResponse";
        value: ExtensionUIResponseResult;
    } | {
        $case: "extensionUiCancel";
        value: ExtensionUICancelResult;
    } | undefined;
}
export interface ControlError {
    reason: string;
}
/** ControlEvent is one sequenced session event. A gap in seq forces rehydrate. */
export interface ControlEvent {
    sid: string;
    seq: bigint;
    event: {
        $case: "stateChanged";
        value: StateChangedEvent;
    } | {
        $case: "messageStart";
        value: MessageStartEvent;
    } | {
        $case: "messageUpdate";
        value: MessageUpdateEvent;
    } | {
        $case: "messageEnd";
        value: MessageEndEvent;
    } | {
        $case: "transcriptReset";
        value: TranscriptResetEvent;
    } | {
        $case: "rpcExited";
        value: RpcExitedEvent;
    } | {
        $case: "subagentFleet";
        value: SubagentFleetEvent;
    } | {
        $case: "autoRetryStart";
        value: AutoRetryStartEvent;
    } | {
        $case: "autoRetryEnd";
        value: AutoRetryEndEvent;
    } | {
        $case: "summarizationRetryScheduled";
        value: SummarizationRetryScheduledEvent;
    } | {
        $case: "summarizationRetryFinished";
        value: SummarizationRetryFinishedEvent;
    } | {
        $case: "compactionEnd";
        value: CompactionEndEvent;
    } | {
        $case: "extensionError";
        value: ExtensionErrorEvent;
    } | {
        $case: "queueChanged";
        value: QueueChangedEvent;
    } | {
        $case: "extensionUiRequest";
        value: ExtensionUIRequestEvent;
    } | {
        $case: "extensionUiClosed";
        value: ExtensionUIClosedEvent;
    } | {
        $case: "toolExecutionUpdate";
        value: ToolExecutionUpdateEvent;
    } | undefined;
}
/**
 * ControlState is the known Phi-owned session state. Nullable counters stay
 * optional: an absent counter maps to the UI's null, not to zero. Status
 * keeps the existing "live"/"exited" values. session_path is the published
 * resume path and must not be erased by an update that omits it.
 */
export interface ControlState {
    sid: string;
    title: string;
    cwd: string;
    model?: string | undefined;
    thinking?: string | undefined;
    inputTokens?: bigint | undefined;
    outputTokens?: bigint | undefined;
    contextUsedTokens?: bigint | undefined;
    contextWindowTokens?: bigint | undefined;
    cacheReadTokens?: bigint | undefined;
    cacheWriteTokens?: bigint | undefined;
    skills: string[];
    busy: boolean;
    status: string;
    queueDepth: number;
    sessionPath?: string | undefined;
    /**
     * cost is the session's accumulated spend as Pi reports it. Absent until
     * the first get_session_stats response carries a value.
     */
    cost?: number | undefined;
}
/**
 * Message is one transcript entry. message_end carries the authoritative
 * copy. Content and details are external Pi data; the remaining fields are
 * Phi-owned pairing and status metadata.
 */
export interface Message {
    role: string;
    content: ExternalValue | undefined;
    details: ExternalValue | undefined;
    toolCallId?: string | undefined;
    toolName?: string | undefined;
    isError?: boolean | undefined;
    ts?: bigint | undefined;
    stopReason?: string | undefined;
    errorMessage?: string | undefined;
}
export interface SessionSummary {
    sid: string;
    title: string;
    cwd: string;
    status: string;
}
export interface TranscriptSnapshot {
    messages: Message[];
    lastSeq: bigint;
    state: ControlState | undefined;
}
/**
 * sid scopes one call to one live session. Operations that resolve a session
 * by identity (spawn, listSessions, subagentTranscript) do not carry one.
 */
export interface SpawnCall {
    cwd?: string | undefined;
    sessionPath?: string | undefined;
    /**
     * spawn_id makes a retried spawn idempotent: the same id with the same
     * arguments reuses the existing child instead of starting a second one.
     */
    spawnId?: string | undefined;
}
export interface ListSessionsCall {
}
export interface GetStateCall {
    sid: string;
}
export interface HydrateCall {
    sid: string;
}
export interface GetMessagesCall {
    sid: string;
}
export interface PromptCall {
    sid: string;
    message: string;
    streamingBehavior?: string | undefined;
}
export interface GetAvailableModelsCall {
    sid: string;
}
export interface SetModelCall {
    sid: string;
    provider: string;
    modelId: string;
}
export interface GetAvailableThinkingLevelsCall {
    sid: string;
}
export interface SetThinkingCall {
    sid: string;
    level: string;
}
export interface NewSessionCall {
    sid: string;
}
export interface AbortCall {
    sid: string;
}
export interface CompactCall {
    sid: string;
}
export interface SetSessionNameCall {
    sid: string;
    name: string;
}
export interface SubagentTranscriptCall {
    runId: string;
}
/** The six accepted no-ops keep explicit variants instead of an untyped tunnel. */
export interface ViewReadyCall {
    sid?: string | undefined;
}
export interface SetCapabilitiesCall {
    sid?: string | undefined;
}
export interface WaitViewReadyCall {
    sid?: string | undefined;
}
export interface DlgCall {
    sid?: string | undefined;
}
export interface DlgClosedCall {
    sid?: string | undefined;
}
export interface ActivateTabCall {
    sid?: string | undefined;
}
/**
 * QueueAttachment is one opaque browser-owned attachment bound to a queued
 * message. The bytes stay process-local; only this metadata crosses the wire.
 */
export interface QueueAttachment {
    ref: string;
    name: string;
    mimeType: string;
    sizeBytes: bigint;
}
/**
 * QueueItem is one process-local delivery record. state keeps the ledger
 * vocabulary: local, sending, accepted, uncertain, consumed, cancelled,
 * promoted. error is present only for a failed or uncertain delivery.
 */
export interface QueueItem {
    id: string;
    sid: string;
    sessionEpoch: string;
    message: string;
    delivery: string;
    attachments: QueueAttachment[];
    state: string;
    error?: string | undefined;
    createdAt: bigint;
}
/** QueueSnapshot is the hydrate, state, and queue_changed queue payload. */
export interface QueueSnapshot {
    sessionEpoch: string;
    items: QueueItem[];
}
export interface QueueSubmitCall {
    sid: string;
    itemId: string;
    sessionEpoch: string;
    message: string;
    delivery: string;
    attachmentRefs: string[];
}
export interface QueueRestoreCall {
    sid: string;
    itemId: string;
    sessionEpoch: string;
}
export interface QueueCopyCall {
    sid: string;
    itemId: string;
    sessionEpoch: string;
}
export interface QueueDiscardCall {
    sid: string;
    itemId: string;
    sessionEpoch: string;
}
export interface QueueItemResult {
    item: QueueItem | undefined;
}
/** QueueRestoreResult reports draft recovery for a Phi-owned local item. */
export interface QueueRestoreResult {
    restored: boolean;
    item: QueueItem | undefined;
    reason?: string | undefined;
}
/**
 * QueueCopyResult returns a fresh unsent draft for an uncertain item. The
 * copied message is never resubmitted by the server.
 */
export interface QueueCopyResult {
    copied: boolean;
    message?: string | undefined;
    attachmentRefs: string[];
    attachments: QueueAttachment[];
    reason?: string | undefined;
}
export interface QueueDiscardResult {
    discarded: boolean;
    item: QueueItem | undefined;
    reason?: string | undefined;
}
/**
 * ExtensionUIDialog is one retained blocking Pi dialog. Optional fields are
 * populated only for the matching method: options for select, message for
 * confirm, placeholder for input, prefill for editor.
 */
export interface ExtensionUIDialog {
    id: string;
    method: string;
    title: string;
    options: string[];
    message?: string | undefined;
    placeholder?: string | undefined;
    prefill?: string | undefined;
    timeout: number;
    createdAt: bigint;
}
export interface ExtensionUIResponseCall {
    sid: string;
    requestId: string;
    value?: string | undefined;
    confirmed?: boolean | undefined;
    cancelled: boolean;
}
export interface ExtensionUIResponseResult {
    resolved: boolean;
}
export interface ExtensionUICancelCall {
    sid: string;
    /** reason keeps the existing tabClosed/server vocabulary. */
    reason: string;
}
export interface ExtensionUICancelResult {
    cancelled: number;
}
export interface SpawnResult {
    sid: string;
    title: string;
    cwd: string;
    session: TranscriptSnapshot | undefined;
    state: ControlState | undefined;
}
export interface ListSessionsResult {
    sessions: SessionSummary[];
}
export interface StateResult {
    state: ControlState | undefined;
    queue: QueueSnapshot | undefined;
    dialogs: ExtensionUIDialog[];
}
export interface TranscriptResult {
    session: TranscriptSnapshot | undefined;
    queue: QueueSnapshot | undefined;
    dialogs: ExtensionUIDialog[];
}
export interface PromptResult {
    accepted: boolean;
}
export interface ModelInfo {
    provider: string;
    id: string;
    name?: string | undefined;
}
export interface ModelsResult {
    models: ModelInfo[];
}
export interface ThinkingLevelsResult {
    levels: string[];
}
/**
 * NewSessionResult splits the cancelled case from the reset case. state is
 * absent when the refresh after a reset failed; state_warning then carries
 * the reason and the reset itself still counts as complete.
 */
export interface NewSessionResult {
    cancelled: boolean;
    reset?: boolean | undefined;
    state?: ControlState | undefined;
    stateWarning?: string | undefined;
}
export interface AbortResult {
    aborted: boolean;
}
/**
 * CompactResult keeps a completed compaction visible even when the state
 * refresh failed: state_warning explains the stale view.
 */
export interface CompactResult {
    state: ControlState | undefined;
    stateWarning?: string | undefined;
}
export interface SubagentRunStep {
    label: string;
    sessionFile: string;
    messages: Message[];
}
export interface SubagentTranscriptResult {
    runId: string;
    steps: SubagentRunStep[];
}
export interface StubResult {
    stubbed: boolean;
}
/**
 * StateChangedEvent carries either a complete state or an error-only update.
 * An error-only update must not reset model, busy state, counters, title, or
 * the published session path.
 */
export interface StateChangedEvent {
    change: {
        $case: "state";
        value: ControlState;
    } | {
        $case: "error";
        value: ControlError;
    } | undefined;
}
/**
 * MessageStartEvent announces a Pi message that is still streaming. Pi's
 * message object is external; the role is the field the UI reads from it.
 */
export interface MessageStartEvent {
    role?: string | undefined;
    message?: ExternalValue | undefined;
}
/**
 * MessageUpdateEvent is one assistant delta. type is Pi's value, for example
 * "text_delta"; only that type appends to the visible partial text.
 */
export interface MessageUpdateEvent {
    type?: string | undefined;
    contentIndex?: bigint | undefined;
    delta?: string | undefined;
}
export interface MessageEndEvent {
    message: Message | undefined;
}
export interface TranscriptResetEvent {
}
export interface RpcExitedEvent {
    reason?: string | undefined;
}
/**
 * SubagentFleetEvent carries the extension's open-ended fleet data. An empty
 * event clears the fleet widget.
 */
export interface SubagentFleetEvent {
    fleet?: ExternalValue | undefined;
}
export interface AutoRetryStartEvent {
    attempt?: bigint | undefined;
    maxAttempts?: bigint | undefined;
    delayMs?: bigint | undefined;
    errorMessage?: string | undefined;
}
export interface AutoRetryEndEvent {
    success?: boolean | undefined;
    attempt?: bigint | undefined;
    finalError?: string | undefined;
}
export interface SummarizationRetryScheduledEvent {
    attempt?: bigint | undefined;
    maxAttempts?: bigint | undefined;
    delayMs?: bigint | undefined;
    errorMessage?: string | undefined;
}
export interface SummarizationRetryFinishedEvent {
    success?: boolean | undefined;
    attempt?: bigint | undefined;
    finalError?: string | undefined;
}
/**
 * CompactionEndEvent reports a finished or cancelled compaction. reason keeps
 * the existing "manual"/automatic values; result is Pi's compaction summary
 * data when present.
 */
export interface CompactionEndEvent {
    aborted?: boolean | undefined;
    reason?: string | undefined;
    errorMessage?: string | undefined;
    result?: ExternalValue | undefined;
}
export interface ExtensionErrorEvent {
    error?: string | undefined;
}
/**
 * QueueChangedEvent carries the whole delivery ledger after a change. Clients
 * replace their ledger with this snapshot rather than patching item by item.
 */
export interface QueueChangedEvent {
    queue: QueueSnapshot | undefined;
}
/**
 * ExtensionUIRequestEvent carries Pi's blocking dialog request verbatim so the
 * browser keeps the existing method-specific shape.
 */
export interface ExtensionUIRequestEvent {
    request?: ExternalValue | undefined;
}
/**
 * ExtensionUIClosedEvent retires one retained dialog. reason keeps the
 * timeout, childExit, tabClosed, server, and unsupported values.
 */
export interface ExtensionUIClosedEvent {
    id: string;
    reason?: string | undefined;
}
/**
 * ToolExecutionUpdateEvent is Pi's tool progress payload, passed through as
 * external data because its shape is owned by Pi.
 */
export interface ToolExecutionUpdateEvent {
    payload?: ExternalValue | undefined;
}
/**
 * ExternalValue represents open-ended Pi, tool, provider, or extension data.
 * Objects use repeated key/value entries rather than a protobuf map so
 * arbitrary keys, including reserved ones such as __proto__, survive a
 * round trip with their original order.
 */
export interface ExternalValue {
    kind: {
        $case: "nullValue";
        value: ExternalNull;
    } | {
        $case: "boolValue";
        value: boolean;
    } | {
        $case: "numberValue";
        value: number;
    } | {
        $case: "intValue";
        value: bigint;
    } | {
        $case: "stringValue";
        value: string;
    } | {
        $case: "listValue";
        value: ExternalList;
    } | {
        $case: "objectValue";
        value: ExternalObject;
    } | undefined;
}
export interface ExternalNull {
}
export interface ExternalList {
    values: ExternalValue[];
}
export interface ExternalObject {
    entries: ExternalEntry[];
}
export interface ExternalEntry {
    key: string;
    value: ExternalValue | undefined;
}
export declare const ControlClientFrame: MessageFns<ControlClientFrame>;
export declare const ControlServerFrame: MessageFns<ControlServerFrame>;
export declare const ControlHello: MessageFns<ControlHello>;
export declare const ControlWelcome: MessageFns<ControlWelcome>;
export declare const ControlCall: MessageFns<ControlCall>;
export declare const ControlResponse: MessageFns<ControlResponse>;
export declare const ControlError: MessageFns<ControlError>;
export declare const ControlEvent: MessageFns<ControlEvent>;
export declare const ControlState: MessageFns<ControlState>;
export declare const Message: MessageFns<Message>;
export declare const SessionSummary: MessageFns<SessionSummary>;
export declare const TranscriptSnapshot: MessageFns<TranscriptSnapshot>;
export declare const SpawnCall: MessageFns<SpawnCall>;
export declare const ListSessionsCall: MessageFns<ListSessionsCall>;
export declare const GetStateCall: MessageFns<GetStateCall>;
export declare const HydrateCall: MessageFns<HydrateCall>;
export declare const GetMessagesCall: MessageFns<GetMessagesCall>;
export declare const PromptCall: MessageFns<PromptCall>;
export declare const GetAvailableModelsCall: MessageFns<GetAvailableModelsCall>;
export declare const SetModelCall: MessageFns<SetModelCall>;
export declare const GetAvailableThinkingLevelsCall: MessageFns<GetAvailableThinkingLevelsCall>;
export declare const SetThinkingCall: MessageFns<SetThinkingCall>;
export declare const NewSessionCall: MessageFns<NewSessionCall>;
export declare const AbortCall: MessageFns<AbortCall>;
export declare const CompactCall: MessageFns<CompactCall>;
export declare const SetSessionNameCall: MessageFns<SetSessionNameCall>;
export declare const SubagentTranscriptCall: MessageFns<SubagentTranscriptCall>;
export declare const ViewReadyCall: MessageFns<ViewReadyCall>;
export declare const SetCapabilitiesCall: MessageFns<SetCapabilitiesCall>;
export declare const WaitViewReadyCall: MessageFns<WaitViewReadyCall>;
export declare const DlgCall: MessageFns<DlgCall>;
export declare const DlgClosedCall: MessageFns<DlgClosedCall>;
export declare const ActivateTabCall: MessageFns<ActivateTabCall>;
export declare const QueueAttachment: MessageFns<QueueAttachment>;
export declare const QueueItem: MessageFns<QueueItem>;
export declare const QueueSnapshot: MessageFns<QueueSnapshot>;
export declare const QueueSubmitCall: MessageFns<QueueSubmitCall>;
export declare const QueueRestoreCall: MessageFns<QueueRestoreCall>;
export declare const QueueCopyCall: MessageFns<QueueCopyCall>;
export declare const QueueDiscardCall: MessageFns<QueueDiscardCall>;
export declare const QueueItemResult: MessageFns<QueueItemResult>;
export declare const QueueRestoreResult: MessageFns<QueueRestoreResult>;
export declare const QueueCopyResult: MessageFns<QueueCopyResult>;
export declare const QueueDiscardResult: MessageFns<QueueDiscardResult>;
export declare const ExtensionUIDialog: MessageFns<ExtensionUIDialog>;
export declare const ExtensionUIResponseCall: MessageFns<ExtensionUIResponseCall>;
export declare const ExtensionUIResponseResult: MessageFns<ExtensionUIResponseResult>;
export declare const ExtensionUICancelCall: MessageFns<ExtensionUICancelCall>;
export declare const ExtensionUICancelResult: MessageFns<ExtensionUICancelResult>;
export declare const SpawnResult: MessageFns<SpawnResult>;
export declare const ListSessionsResult: MessageFns<ListSessionsResult>;
export declare const StateResult: MessageFns<StateResult>;
export declare const TranscriptResult: MessageFns<TranscriptResult>;
export declare const PromptResult: MessageFns<PromptResult>;
export declare const ModelInfo: MessageFns<ModelInfo>;
export declare const ModelsResult: MessageFns<ModelsResult>;
export declare const ThinkingLevelsResult: MessageFns<ThinkingLevelsResult>;
export declare const NewSessionResult: MessageFns<NewSessionResult>;
export declare const AbortResult: MessageFns<AbortResult>;
export declare const CompactResult: MessageFns<CompactResult>;
export declare const SubagentRunStep: MessageFns<SubagentRunStep>;
export declare const SubagentTranscriptResult: MessageFns<SubagentTranscriptResult>;
export declare const StubResult: MessageFns<StubResult>;
export declare const StateChangedEvent: MessageFns<StateChangedEvent>;
export declare const MessageStartEvent: MessageFns<MessageStartEvent>;
export declare const MessageUpdateEvent: MessageFns<MessageUpdateEvent>;
export declare const MessageEndEvent: MessageFns<MessageEndEvent>;
export declare const TranscriptResetEvent: MessageFns<TranscriptResetEvent>;
export declare const RpcExitedEvent: MessageFns<RpcExitedEvent>;
export declare const SubagentFleetEvent: MessageFns<SubagentFleetEvent>;
export declare const AutoRetryStartEvent: MessageFns<AutoRetryStartEvent>;
export declare const AutoRetryEndEvent: MessageFns<AutoRetryEndEvent>;
export declare const SummarizationRetryScheduledEvent: MessageFns<SummarizationRetryScheduledEvent>;
export declare const SummarizationRetryFinishedEvent: MessageFns<SummarizationRetryFinishedEvent>;
export declare const CompactionEndEvent: MessageFns<CompactionEndEvent>;
export declare const ExtensionErrorEvent: MessageFns<ExtensionErrorEvent>;
export declare const QueueChangedEvent: MessageFns<QueueChangedEvent>;
export declare const ExtensionUIRequestEvent: MessageFns<ExtensionUIRequestEvent>;
export declare const ExtensionUIClosedEvent: MessageFns<ExtensionUIClosedEvent>;
export declare const ToolExecutionUpdateEvent: MessageFns<ToolExecutionUpdateEvent>;
export declare const ExternalValue: MessageFns<ExternalValue>;
export declare const ExternalNull: MessageFns<ExternalNull>;
export declare const ExternalList: MessageFns<ExternalList>;
export declare const ExternalObject: MessageFns<ExternalObject>;
export declare const ExternalEntry: MessageFns<ExternalEntry>;
type Builtin = Date | Function | Uint8Array | string | number | boolean | bigint | undefined;
export type DeepPartial<T> = T extends bigint ? string | number | bigint : T extends Builtin ? T : T extends globalThis.Array<infer U> ? globalThis.Array<DeepPartial<U>> : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>> : T extends {
    $case: string;
    value: unknown;
} ? {
    $case: T["$case"];
    value?: DeepPartial<T["value"]>;
} : T extends {} ? {
    [K in keyof T]?: DeepPartial<T[K]>;
} : Partial<T>;
type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P : P & {
    [K in keyof P]: Exact<P[K], I[K]>;
} & {
    [K in Exclude<keyof I, KeysOfUnion<P>>]: never;
};
export interface MessageFns<T> {
    encode(message: T, writer?: BinaryWriter): BinaryWriter;
    decode(input: BinaryReader | Uint8Array, length?: number): T;
    create<I extends Exact<DeepPartial<T>, I>>(base?: I): T;
    fromPartial<I extends Exact<DeepPartial<T>, I>>(object: I): T;
}
export {};
