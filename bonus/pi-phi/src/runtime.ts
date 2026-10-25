// Extension runtime: one claimed session_start owns one Runtime. It maps
// Pi lifecycle events to bridge edges, retains the bounded journal,
// publishes authoritative snapshots on transitions, and reconnects the
// stream with the same generation after transport failures. It never
// starts provider work and never touches the Pi session.

import { randomUUID } from 'node:crypto';
import type { ServiceError } from '@grpc/grpc-js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import {
    AgentSettled,
    AgentStarted,
    Hello,
    HistoryResponse,
    LogicalState,
    ModelSnapshot,
    ModelsResponse,
    PiToPhi,
    RunOutcome,
    SetModelAck,
    StateSnapshot,
    ThinkingLevelsResponse,
    SetThinkingAck,
} from './gen/bridge.js';
import { BridgeChannel, type ChannelCreds } from './channel.js';
import { InvalidTargetError } from './endpoint.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { CAPABILITY_HISTORY } from './protocol.js';
import { CAPABILITY_LIFECYCLE } from './protocol.js';
import { CAPABILITY_MODELS } from './protocol.js';
import { CAPABILITY_THINKING } from './protocol.js';
import { MAX_JOURNAL_RECORDS } from './protocol.js';
import { MAX_MESSAGE_BYTES } from './protocol.js';
import { MAX_MODELS_ENTRIES } from './protocol.js';
import { MAX_THINKING_LEVELS } from './protocol.js';
import { MAX_THINKING_LEVEL_BYTES } from './protocol.js';
import { MAX_THINKING_MODEL_ID_BYTES } from './protocol.js';
import { RECONNECT_BASE_MS } from './protocol.js';
import { RECONNECT_MAX_MS } from './protocol.js';
import { RECONNECT_STABLE_MS } from './protocol.js';
import { isHistoryReaderAvailable } from './history-reader.js';
import { readEditorHistory } from './history-reader.js';

/** Structural Pi session view; satisfied by both pinned host versions. */
export interface PiSessionView {
    getSessionId(): string;
    getLeafId(): string | null;
}

/** The live host model object, for provider routing. Never copied. */
export type PiModelView = NonNullable<ExtensionContext['model']>;

/** Structural Pi model-registry view; getAvailable/find suffice. */
export type PiRegistryView = Pick<
    ExtensionContext['modelRegistry'],
    'getAvailable' | 'find'
>;

/** Structural scoped-model entry; the wrapped model is what matters. */
export interface PiScopedModelView {
    readonly model: PiModelView;
}

/** Structural Pi event-context view; satisfied by both pinned versions. */
export interface PiContextView {
    readonly sessionManager: PiSessionView;
    readonly model?: PiModelView | undefined;
    readonly modelRegistry?: PiRegistryView | undefined;
    readonly scopedModels?: readonly PiScopedModelView[] | undefined;
    /**
     * Live UI surface for the history reader. Unknown-shaped by
     * design: the reader guards every access and reports
     * unavailable on hosts or modes without widget capture.
     */
    readonly ui?: unknown;
}

export type PiThinkingLevel = NonNullable<ExtensionContext['thinkingLevel']>;

export interface RuntimeOptions {
    readonly creds: ChannelCreds;
    readonly generation: bigint;
    /** Host model switch; absent in tests that never switch. */
    readonly setModel?: (model: PiModelView) => Promise<boolean>;
    /** Native thinking APIs; both are required to advertise the capability. */
    readonly getThinkingLevel?: () => PiThinkingLevel;
    readonly setThinkingLevel?: (level: PiThinkingLevel) => void;
    /** Base reconnect delay; doubles per attempt up to maxBackoffMs. */
    readonly backoffBaseMs?: number;
    readonly backoffMaxMs?: number;
    readonly makeChannel?: (
        creds: ChannelCreds,
        hooks: ChannelHooks,
    ) => RuntimeChannel;
}

export interface ChannelHooks {
    onMessage(msg: import('./gen/bridge.js').PhiToPi): void;
    onStatus(status: ServiceError | null): void;
}

/** Narrow channel surface the runtime needs; BridgeChannel satisfies it. */
export interface RuntimeChannel {
    connect(hello: PiToPhi): Promise<import('./gen/bridge.js').Accepted>;
    send(msg: PiToPhi): boolean;
    /**
     * Queue one on-demand response (history, models, set-ack). False
     * means the frame missed admission; the caller fails only that
     * request, never the stream.
     */
    sendNonfatal(msg: PiToPhi): boolean;
    close(): void;
}

interface JournalRow {
    readonly sequence: bigint;
    readonly runId: bigint;
    readonly settled: boolean;
    readonly outcome: RunOutcome;
}

const TERMINAL_STATUS_CODES = new Set([
    16, // UNAUTHENTICATED: lease revoked or never valid; retry is futile.
    7, // PERMISSION_DENIED: identity mismatch; retry cannot fix it.
    9, // FAILED_PRECONDITION: version or generation rejected; retry cannot fix it.
    1, // CANCELLED: server-side revoke or replace; retry cannot fix it.
]);

function isTerminalConnectError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: unknown }).code;
    return typeof code === 'number' && TERMINAL_STATUS_CODES.has(code);
}

/** One claimed extension runtime for one Pi session. */
export class Runtime {
    readonly runtimeId: string = randomUUID();
    private channel: RuntimeChannel | null = null;
    private running = false;
    private seq = 0n;
    private runId = 0n;
    private revision = 0n;
    private journal: JournalRow[] = [];
    private journalGap = false;
    private sessionId = '';
    private leafId = '';
    private model: PiModelView | undefined;
    private view: PiContextView | undefined;
    private registry: PiRegistryView | undefined;
    private scopedModels: readonly PiScopedModelView[] = [];
    /** Latest UI surface for history reads; refreshed on every event. */
    private ui: unknown;
    private historyAccepted = false;
    private modelsAccepted = false;
    private thinkingAccepted = false;
    /** Final assistant stop reason of the current run, if observed. */
    private lastStopReason: string | null = null;
    /** When the current stream was accepted; null while connecting. */
    private connectedAt: number | null = null;
    private shutdownRequested = false;
    private backoffMs: number;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private starting = false;

    constructor(private readonly opts: RuntimeOptions) {
        this.backoffMs = opts.backoffBaseMs ?? RECONNECT_BASE_MS;
    }

    /** Begin connecting; never throws, never blocks Pi startup. */
    start(ctx: PiContextView): void {
        if (this.channel || this.starting || this.shutdownRequested) return;
        this.starting = true;
        this.noteView(ctx);
        void this.attempt();
    }

    /** A replacement session refreshes identities and the snapshot. */
    onSessionStart(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.noteView(ctx);
        this.sendSnapshot(
            this.running
                ? LogicalState.LOGICAL_STATE_RUNNING
                : LogicalState.LOGICAL_STATE_IDLE,
        );
    }

    /** Map one agent_start edge. Extra starts continue the current run. */
    onAgentStart(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.noteView(ctx);
        if (!this.running) {
            this.running = true;
            this.runId += 1n;
            // A new logical run drops the previous run's evidence.
            this.lastStopReason = null;
        }
        const sequence = this.nextSeq();
        this.appendJournal({
            sequence,
            runId: this.runId,
            settled: false,
            outcome: RunOutcome.RUN_OUTCOME_UNSPECIFIED,
        });
        this.send({
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'agentStarted',
                value: AgentStarted.create({
                    eventSequence: sequence,
                    runId: this.runId,
                }),
            },
        });
        this.sendSnapshot(LogicalState.LOGICAL_STATE_RUNNING);
    }

    /**
     * Record the final assistant stop reason of the current attempt.
     * Retries overwrite; the last evidence before settlement wins.
     */
    onAgentEnd(stopReason: string | null): void {
        if (this.shutdownRequested || !this.running) return;
        this.lastStopReason = stopReason;
    }

    /**
     * Map one agent_settled edge. A settlement with no observed run is
     * ignored: unobserved work must not ring the bell. The outcome comes
     * from this event only; an old outcome is never reused. Without
     * abort evidence the outcome stays explicitly unknown.
     */
    onAgentSettled(ctx: PiContextView, aborted: boolean): void {
        if (this.shutdownRequested || !this.running) return;
        this.noteView(ctx);
        const sequence = this.nextSeq();
        const outcome = aborted
            ? RunOutcome.RUN_OUTCOME_ABORTED
            : this.settleOutcome();
        this.appendJournal({
            sequence,
            runId: this.runId,
            settled: true,
            outcome,
        });
        this.running = false;
        this.send({
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'agentSettled',
                value: AgentSettled.create({
                    eventSequence: sequence,
                    runId: this.runId,
                    outcome,
                }),
            },
        });
        this.sendSnapshot(LogicalState.LOGICAL_STATE_IDLE);
    }

    /**
     * Classify a non-aborted settlement from the final assistant stop
     * reason. Anything but a clean stop stays explicitly unknown or
     * error; success is never assumed.
     */
    private settleOutcome(): RunOutcome {
        switch (this.lastStopReason) {
            case 'stop':
                return RunOutcome.RUN_OUTCOME_COMPLETED;
            case 'error':
                return RunOutcome.RUN_OUTCOME_ERROR;
            case 'aborted':
                return RunOutcome.RUN_OUTCOME_ABORTED;
            default:
                return RunOutcome.RUN_OUTCOME_UNSPECIFIED;
        }
    }

    /** A model change refreshes identities and the snapshot. */
    onModelSelect(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.noteView(ctx);
        this.sendSnapshot(
            this.running
                ? LogicalState.LOGICAL_STATE_RUNNING
                : LogicalState.LOGICAL_STATE_IDLE,
        );
    }

    /** A native thinking-level change refreshes the authoritative snapshot. */
    onThinkingLevelSelect(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.noteView(ctx);
        this.sendSnapshot(
            this.running
                ? LogicalState.LOGICAL_STATE_RUNNING
                : LogicalState.LOGICAL_STATE_IDLE,
        );
    }

    /** Tree navigation refreshes identities and the snapshot. */
    onSessionTree(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.noteView(ctx);
        this.sendSnapshot(
            this.running
                ? LogicalState.LOGICAL_STATE_RUNNING
                : LogicalState.LOGICAL_STATE_IDLE,
        );
    }

    /** Compaction starts: refresh identities; the end publishes. */
    onCompactStart(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.noteView(ctx);
    }

    /** Compaction ends: publish the post-compaction snapshot. */
    onCompactEnd(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.noteView(ctx);
        this.sendSnapshot(
            this.running
                ? LogicalState.LOGICAL_STATE_RUNNING
                : LogicalState.LOGICAL_STATE_IDLE,
        );
    }

    /** Idempotent shutdown: stop retrying and release the stream. */
    shutdown(): void {
        if (this.shutdownRequested) return;
        this.shutdownRequested = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.channel?.close();
        this.channel = null;
        this.starting = false;
    }

    get isRunning(): boolean {
        return this.running;
    }

    get lastSequence(): bigint {
        return this.seq;
    }

    /** Refresh event-time identities from the live view. */
    private noteView(ctx: PiContextView): void {
        this.refreshIdentities(ctx);
    }

    private refreshIdentities(ctx: PiContextView): void {
        this.view = ctx;
        try {
            this.sessionId = ctx.sessionManager.getSessionId();
        } catch {
            // Keep the last known identity; never fail an event mapping.
        }
        try {
            this.leafId = ctx.sessionManager.getLeafId() ?? '';
        } catch {
            // Keep the last known leaf; never fail an event mapping.
        }
        this.model = ctx.model;
        this.registry = ctx.modelRegistry;
        this.scopedModels = ctx.scopedModels ?? [];
        this.ui = ctx.ui;
    }

    private nextSeq(): bigint {
        this.seq += 1n;
        return this.seq;
    }

    private appendJournal(row: JournalRow): void {
        this.journal.push(row);
        if (this.journal.length > MAX_JOURNAL_RECORDS) {
            this.journal.splice(0, this.journal.length - MAX_JOURNAL_RECORDS);
            this.journalGap = true;
        }
    }

    private liveModel(): PiModelView | undefined {
        try {
            return this.view?.model;
        } catch {
            return undefined;
        }
    }

    private modelIdentity(
        model: PiModelView | undefined,
    ): { provider: string; model: string } | null {
        try {
            const provider = model?.provider;
            const id = model?.id;
            if (
                typeof provider !== 'string' ||
                provider === '' ||
                Buffer.byteLength(provider, 'utf8') >
                    MAX_THINKING_MODEL_ID_BYTES ||
                typeof id !== 'string' ||
                id === '' ||
                Buffer.byteLength(id, 'utf8') > MAX_THINKING_MODEL_ID_BYTES
            )
                return null;
            return { provider, model: id };
        } catch {
            return null;
        }
    }

    private supportedThinkingLevels(
        model: PiModelView,
    ): PiThinkingLevel[] | null {
        try {
            const levels = getSupportedThinkingLevels(model);
            if (
                levels.length > MAX_THINKING_LEVELS ||
                new Set(levels).size !== levels.length ||
                levels.some(
                    (level) =>
                        Buffer.byteLength(level, 'utf8') >
                        MAX_THINKING_LEVEL_BYTES,
                )
            )
                return null;
            return levels as PiThinkingLevel[];
        } catch {
            return null;
        }
    }

    private currentThinkingLevel(): string {
        const model = this.liveModel();
        const identity = this.modelIdentity(model);
        if (!model || !identity || !this.opts.getThinkingLevel) return '';
        const levels = this.supportedThinkingLevels(model);
        if (!levels) return '';
        try {
            const level = this.opts.getThinkingLevel();
            return levels.includes(level) ? level : '';
        } catch {
            return '';
        }
    }

    private snapshot(state: LogicalState): StateSnapshot {
        this.revision += 1n;
        return StateSnapshot.create({
            state,
            sessionId: this.sessionId,
            leafId: this.leafId,
            model: this.model
                ? ModelSnapshot.create({
                      provider: this.model.provider,
                      model: this.model.id,
                  })
                : undefined,
            journal: this.journal.map((row) => ({
                eventSequence: row.sequence,
                runId: row.runId,
                settled: row.settled,
                outcome: row.outcome,
            })),
            journalGap: this.journalGap,
            stateRevision: this.revision,
            thinkingLevel: this.currentThinkingLevel(),
        });
    }

    /**
     * Capabilities this runtime implements right now. History is
     * advertised only while the direct reader can reach a
     * history-shaped editor; print and RPC modes stay
     * lifecycle-only. Models needs only the registry and the host
     * switch call, so it is always advertised. Re-evaluated on every
     * Hello, so reconnects follow custom-editor changes.
     */
    private capabilities(): string[] {
        const caps = [CAPABILITY_LIFECYCLE, CAPABILITY_MODELS];
        if (isHistoryReaderAvailable(this.ui)) caps.push(CAPABILITY_HISTORY);
        if (this.opts.getThinkingLevel && this.opts.setThinkingLevel)
            caps.push(CAPABILITY_THINKING);
        return caps;
    }

    private hello(): PiToPhi {
        return {
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'hello',
                value: Hello.create({
                    protocolVersion: PROTOCOL_VERSION,
                    sessionId: this.sessionId,
                    runtimeId: this.runtimeId,
                    capabilities: this.capabilities(),
                    currentState: this.snapshot(
                        this.running
                            ? LogicalState.LOGICAL_STATE_RUNNING
                            : LogicalState.LOGICAL_STATE_IDLE,
                    ),
                    journalFirstSequence:
                        this.journal.length > 0
                            ? this.journal[0]!.sequence
                            : 0n,
                    journalLastSequence: this.seq,
                }),
            },
        };
    }

    private send(msg: PiToPhi): void {
        if (!this.channel) return;
        if (!this.channel.send(msg)) {
            // Queue overflow is fatal for this attempt; reconnect for a
            // fresh baseline rather than emit a gapped event stream.
            this.channel.close();
            this.channel = null;
            this.scheduleRetry();
        }
    }

    private sendSnapshot(state: LogicalState): void {
        this.send({
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: { $case: 'stateSnapshot', value: this.snapshot(state) },
        });
    }

    private async attempt(): Promise<void> {
        if (this.shutdownRequested) {
            this.starting = false;
            return;
        }
        const make =
            this.opts.makeChannel ??
            ((creds, hooks) => new BridgeChannel(creds, hooks));
        this.historyAccepted = false;
        this.modelsAccepted = false;
        this.thinkingAccepted = false;
        const channel = make(this.opts.creds, {
            onMessage: (msg) => {
                if (this.channel === channel && !this.shutdownRequested)
                    this.onServerMessage(msg);
            },
            onStatus: (status) => {
                if (this.channel === channel && !this.shutdownRequested)
                    this.onStreamEnd(status);
            },
        });
        this.channel = channel;
        try {
            const accepted = await channel.connect(this.hello());
            if (this.channel === channel) {
                this.historyAccepted =
                    accepted.capabilities.includes(CAPABILITY_HISTORY);
                this.modelsAccepted =
                    accepted.capabilities.includes(CAPABILITY_MODELS);
                this.thinkingAccepted =
                    accepted.capabilities.includes(CAPABILITY_THINKING);
            }
        } catch (err) {
            channel.close();
            if (this.channel === channel) this.channel = null;
            // A malformed target can never become valid: stop instead
            // of reconnecting to a bad address for the session's life.
            if (err instanceof InvalidTargetError) return;
            // A terminal handshake rejection (bad token, revoked lease,
            // duplicate runtime, remote cancel) is final: the pre-Accepted
            // status already told the stream handler to stop, so the
            // rejected connect promise must not schedule a retry either.
            if (isTerminalConnectError(err)) return;
            if (!this.shutdownRequested) this.scheduleRetry();
            return;
        } finally {
            this.starting = false;
        }
        if (this.shutdownRequested) {
            // Shutdown landed mid-connect: release the stream the
            // shutdown path already passed over.
            channel.close();
            if (this.channel === channel) this.channel = null;
            return;
        }
        // Acceptance starts the stability window; only a stable
        // connection resets the backoff on its later failure.
        this.connectedAt = Date.now();
    }

    private onServerMessage(msg: import('./gen/bridge.js').PhiToPi): void {
        // Accepted is consumed by the channel; ProtocolError is
        // informational here since terminal failures arrive as the
        // stream status. On-demand requests are answered below.
        if (
            msg.paneId !== this.opts.creds.pane ||
            msg.processId !== this.opts.creds.process ||
            msg.runtimeGeneration !== this.opts.generation
        )
            return;
        if (msg.payload?.$case === 'historyRequest' && this.historyAccepted) {
            this.onHistoryRequest(msg.payload.value.requestId);
        } else if (
            msg.payload?.$case === 'modelsRequest' &&
            this.modelsAccepted
        ) {
            this.onModelsRequest(msg.payload.value.requestId);
        } else if (
            msg.payload?.$case === 'setModelRequest' &&
            this.modelsAccepted
        ) {
            const req = msg.payload.value;
            void this.onSetModelRequest(req.requestId, req.provider, req.model);
        } else if (
            msg.payload?.$case === 'thinkingLevelsRequest' &&
            this.thinkingAccepted
        ) {
            this.onThinkingLevelsRequest(msg.payload.value.requestId);
        } else if (
            msg.payload?.$case === 'setThinkingRequest' &&
            this.thinkingAccepted
        ) {
            this.onSetThinkingRequest(msg.payload.value);
        }
    }

    /**
     * Answer one history request. Best-effort: an unreachable reader
     * or an oversized snapshot answers unavailable, and admission
     * failure fails only the request. Nothing here closes the stream.
     */
    private onHistoryRequest(requestId: string): void {
        if (typeof requestId !== 'string' || requestId === '') return;
        if (!this.channel) return;
        const entries = readEditorHistory(this.ui);
        let msg = this.historyResponse(requestId, entries);
        if (PiToPhi.encode(msg).finish().length > MAX_MESSAGE_BYTES) {
            // Oversized snapshots answer unavailable; truncation
            // would present a partial history as complete.
            msg = this.historyResponse(requestId, null);
        }
        if (!this.channel.sendNonfatal(msg)) {
            // Admission failure is nonfatal: when the snapshot was
            // the frame that missed, answer unavailable instead so
            // Phi falls back promptly; otherwise let Phi time out.
            if (entries !== null) {
                this.channel.sendNonfatal(
                    this.historyResponse(requestId, null),
                );
            }
        }
    }

    private historyResponse(
        requestId: string,
        entries: string[] | null,
    ): PiToPhi {
        return {
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'historyResponse',
                value: HistoryResponse.create(
                    entries === null
                        ? { requestId, unavailable: true }
                        : { requestId, entries, unavailable: false },
                ),
            },
        };
    }

    /**
     * Answer one models request. Best-effort like history: missing
     * registry or oversized answers reply unavailable, and
     * admission failure fails only the request. A configured
     * session scope filters the catalog to selectable entries.
     */
    private onModelsRequest(requestId: string): void {
        if (typeof requestId !== 'string' || requestId === '') return;
        if (!this.channel) return;
        let refs: { provider: string; model: string }[] | null;
        try {
            // Host registry calls can throw; answer unavailable
            // rather than escaping into the stream handler.
            refs = this.selectableModels();
        } catch {
            refs = null;
        }
        let msg = this.modelsResponse(requestId, refs);
        if (PiToPhi.encode(msg).finish().length > MAX_MESSAGE_BYTES) {
            // Oversized answers reply unavailable; truncation
            // would present a partial list as complete.
            msg = this.modelsResponse(requestId, null);
        }
        if (!this.channel.sendNonfatal(msg)) {
            // Admission failure is nonfatal: when the list was
            // the frame that missed, answer unavailable instead so
            // Phi falls back promptly; otherwise let Phi time out.
            const sent = msg.payload;
            if (sent?.$case === 'modelsResponse' && !sent.value.unavailable) {
                this.channel.sendNonfatal(this.modelsResponse(requestId, null));
            }
        }
    }

    private onThinkingLevelsRequest(requestId: string): void {
        if (typeof requestId !== 'string' || requestId === '' || !this.channel)
            return;
        const model = this.liveModel();
        const identity = this.modelIdentity(model);
        const levels =
            model && identity ? this.supportedThinkingLevels(model) : null;
        let msg = this.thinkingLevelsResponse(requestId, identity, levels);
        if (PiToPhi.encode(msg).finish().length > MAX_MESSAGE_BYTES) {
            msg = this.thinkingLevelsResponse(requestId, identity, null);
        }
        if (!this.channel.sendNonfatal(msg)) {
            const sent = msg.payload;
            if (
                sent?.$case === 'thinkingLevelsResponse' &&
                !sent.value.unavailable
            ) {
                this.channel.sendNonfatal(
                    this.thinkingLevelsResponse(requestId, identity, null),
                );
            }
        }
    }

    private thinkingLevelsResponse(
        requestId: string,
        identity: { provider: string; model: string } | null,
        levels: PiThinkingLevel[] | null,
    ): PiToPhi {
        return {
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'thinkingLevelsResponse',
                value: ThinkingLevelsResponse.create({
                    requestId,
                    levels: levels ?? [],
                    provider: identity?.provider ?? '',
                    model: identity?.model ?? '',
                    unavailable: levels === null,
                }),
            },
        };
    }

    private onSetThinkingRequest(
        request: import('./gen/bridge.js').SetThinkingRequest,
    ): void {
        const { requestId, level, provider, model } = request;
        if (typeof requestId !== 'string' || requestId === '' || !this.channel)
            return;
        const ack = (ok: boolean, reason: string): void => {
            this.channel?.sendNonfatal({
                paneId: this.opts.creds.pane,
                processId: this.opts.creds.process,
                runtimeGeneration: this.opts.generation,
                payload: {
                    $case: 'setThinkingAck',
                    value: SetThinkingAck.create({ requestId, ok, reason }),
                },
            });
        };
        if (
            typeof level !== 'string' ||
            Buffer.byteLength(level, 'utf8') > MAX_THINKING_LEVEL_BYTES
        ) {
            ack(false, 'unsupported-level');
            return;
        }
        if (
            typeof provider !== 'string' ||
            typeof model !== 'string' ||
            Buffer.byteLength(provider, 'utf8') > MAX_THINKING_MODEL_ID_BYTES ||
            Buffer.byteLength(model, 'utf8') > MAX_THINKING_MODEL_ID_BYTES
        ) {
            ack(false, 'model-changed');
            return;
        }
        const matchesExpected = (
            candidate: PiModelView | undefined,
        ): boolean => {
            const identity = this.modelIdentity(candidate);
            return identity?.provider === provider && identity.model === model;
        };
        let current = this.liveModel();
        if (!matchesExpected(current)) {
            ack(false, 'model-changed');
            return;
        }
        let levels = this.supportedThinkingLevels(current!);
        if (!levels) {
            ack(false, '');
            return;
        }
        if (!levels.includes(level as PiThinkingLevel)) {
            ack(false, 'unsupported-level');
            return;
        }
        current = this.liveModel();
        if (!matchesExpected(current)) {
            ack(false, 'model-changed');
            return;
        }
        // Re-read support on the live model immediately before the native setter.
        levels = this.supportedThinkingLevels(current!);
        if (!levels) {
            ack(false, '');
            return;
        }
        if (!levels.includes(level as PiThinkingLevel)) {
            ack(false, 'unsupported-level');
            return;
        }
        try {
            if (!this.opts.getThinkingLevel || !this.opts.setThinkingLevel) {
                ack(false, '');
                return;
            }
            this.opts.setThinkingLevel(level as PiThinkingLevel);
            ack(this.opts.getThinkingLevel() === level, '');
        } catch {
            ack(false, '');
        }
    }

    /** Selectable catalog: scoped entries win when scoping is set. */
    private selectableModels(): { provider: string; model: string }[] | null {
        if (!this.registry) return null;
        const source =
            this.scopedModels.length > 0
                ? this.scopedModels.map((entry) => entry.model)
                : this.registry.getAvailable();
        const refs: { provider: string; model: string }[] = [];
        for (const m of source) {
            if (
                typeof m.provider !== 'string' ||
                m.provider === '' ||
                typeof m.id !== 'string' ||
                m.id === ''
            )
                continue;
            refs.push({ provider: m.provider, model: m.id });
        }
        return refs;
    }

    private modelsResponse(
        requestId: string,
        refs: { provider: string; model: string }[] | null,
    ): PiToPhi {
        return {
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'modelsResponse',
                value:
                    refs === null
                        ? ModelsResponse.create({
                              requestId,
                              unavailable: true,
                          })
                        : ModelsResponse.create({
                              requestId,
                              models: refs.slice(0, MAX_MODELS_ENTRIES),
                              truncated: refs.length > MAX_MODELS_ENTRIES,
                              unavailable: false,
                          }),
            },
        };
    }

    /**
     * Answer one set-model request. Unknown or out-of-scope entries
     * ack unknown-model without touching the session; an accepted
     * switch emits model_select, so the snapshot follows on its own.
     * Never throws: every path acks, and admission failure just
     * lets Phi time out into its unknown-state copy.
     */
    private async onSetModelRequest(
        requestId: string,
        provider: string,
        model: string,
    ): Promise<void> {
        if (typeof requestId !== 'string' || requestId === '') return;
        const fail = (reason: string): void => {
            this.channel?.sendNonfatal(
                this.setModelAck(requestId, false, reason),
            );
        };
        if (
            typeof provider !== 'string' ||
            provider === '' ||
            typeof model !== 'string' ||
            model === '' ||
            !this.registry ||
            !this.opts.setModel
        ) {
            fail('unknown-model');
            return;
        }
        let target: PiModelView | undefined;
        try {
            // Host registry calls can throw; ack unknown-model
            // rather than rejecting into the void caller.
            if (this.scopedModels.length > 0) {
                target = this.scopedModels
                    .map((entry) => entry.model)
                    .find((m) => m.provider === provider && m.id === model);
            } else {
                target = this.registry.find(provider, model);
            }
        } catch {
            fail('unknown-model');
            return;
        }
        if (!target) {
            fail('unknown-model');
            return;
        }
        let switched: boolean;
        try {
            switched = await this.opts.setModel(target);
        } catch {
            fail('');
            return;
        }
        if (switched) {
            this.channel?.sendNonfatal(this.setModelAck(requestId, true, ''));
        } else {
            fail('no-auth');
        }
    }

    private setModelAck(
        requestId: string,
        ok: boolean,
        reason: string,
    ): PiToPhi {
        return {
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'setModelAck',
                value: SetModelAck.create({ requestId, ok, reason }),
            },
        };
    }

    private onStreamEnd(status: ServiceError | null): void {
        this.channel?.close();
        this.channel = null;
        if (this.connectedAt !== null) {
            if (Date.now() - this.connectedAt >= RECONNECT_STABLE_MS) {
                this.backoffMs = this.opts.backoffBaseMs ?? RECONNECT_BASE_MS;
            }
            this.connectedAt = null;
        }
        if (this.shutdownRequested) return;
        if (status && TERMINAL_STATUS_CODES.has(status.code)) return;
        this.scheduleRetry();
    }

    private scheduleRetry(): void {
        if (this.shutdownRequested || this.retryTimer || this.channel) return;
        const max = this.opts.backoffMaxMs ?? RECONNECT_MAX_MS;
        const ceiling = Math.min(this.backoffMs, max);
        // Equal jitter: at least half the ceiling, decorrelated.
        const delay = ceiling / 2 + Math.random() * (ceiling / 2);
        this.backoffMs = Math.min(this.backoffMs * 2, max);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.shutdownRequested) void this.attempt();
        }, delay);
    }
}
