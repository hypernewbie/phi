// Extension runtime: one claimed session_start owns one Runtime. It maps
// Pi lifecycle events to bridge edges, retains the bounded journal,
// publishes authoritative snapshots on transitions, and reconnects the
// stream with the same generation after transport failures. It never
// starts provider work and never touches the Pi session.

import { randomUUID } from 'node:crypto';
import type { ServiceError } from '@grpc/grpc-js';
import type {
    CompactOptions,
    ContextUsage,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import {
    AgentSettled,
    AgentStarted,
    CompactOutcome,
    CompactReadiness,
    CompactResult,
    ContextUsageSnapshot,
    Hello,
    HistoryResponse,
    InvokeSkillAck,
    LogicalState,
    ModelSnapshot,
    ModelsResponse,
    PiToPhi,
    RunOutcome,
    SetModelAck,
    SkillsResponse,
    StateSnapshot,
    ThinkingLevelsResponse,
    SetThinkingAck,
} from './gen/bridge.js';
import { BridgeChannel, type ChannelCreds } from './channel.js';
import { InvalidTargetError } from './endpoint.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { CAPABILITY_COMPACT } from './protocol.js';
import { CAPABILITY_CONTEXT } from './protocol.js';
import { CAPABILITY_HISTORY } from './protocol.js';
import { CAPABILITY_LIFECYCLE } from './protocol.js';
import { CAPABILITY_MODELS } from './protocol.js';
import { CAPABILITY_SKILLS } from './protocol.js';
import { CAPABILITY_THINKING } from './protocol.js';
import { MAX_COMPACT_IDENTITY_CHARS } from './protocol.js';
import { MAX_JOURNAL_RECORDS } from './protocol.js';
import { MAX_MESSAGE_BYTES } from './protocol.js';
import { MAX_MODELS_ENTRIES } from './protocol.js';
import { MAX_SKILL_DESCRIPTION_BYTES } from './protocol.js';
import { MAX_SKILL_ENTRIES } from './protocol.js';
import { MAX_SKILL_NAME_BYTES } from './protocol.js';
import { isAddressableSkillName } from './protocol.js';
import { MAX_THINKING_LEVELS } from './protocol.js';
import { MAX_THINKING_LEVEL_BYTES } from './protocol.js';
import { MAX_THINKING_MODEL_ID_BYTES } from './protocol.js';
import { RECONNECT_BASE_MS } from './protocol.js';
import { SHUTDOWN_DRAIN_MS } from './protocol.js';
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

/**
 * One skill the host session knows. name is the bare skill name
 * without the "skill:" command prefix; description is the host's
 * frontmatter text. The host may hand out entries that break the
 * bridge wire bounds, so both sides validate.
 */
export interface PiSkillView {
    readonly name: string;
    readonly description: string;
}

/**
 * One skill entry when it fits the wire bounds, else null. The bounds
 * are UTF-8 byte limits: Pi checks character counts and only warns, so
 * a loaded skill can be unrepresentable here.
 */
function representableSkill(
    skill: PiSkillView | undefined,
): { name: string; description: string } | null {
    if (!skill || typeof skill.name !== 'string' || skill.name === '')
        return null;
    if (!isAddressableSkillName(skill.name)) return null;
    if (typeof skill.description !== 'string') return null;
    if (Buffer.byteLength(skill.name, 'utf8') > MAX_SKILL_NAME_BYTES)
        return null;
    if (
        Buffer.byteLength(skill.description, 'utf8') >
        MAX_SKILL_DESCRIPTION_BYTES
    )
        return null;
    return { name: skill.name, description: skill.description };
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
    /**
     * Optional host telemetry APIs. Each is present only when the
     * host exposes it as a function; context availability depends
     * on getContextUsage alone, independently of the compaction
     * trio (compact/isIdle/hasPendingMessages). Any of them may
     * throw; sampling fails closed and never breaks Pi.
     */
    readonly getContextUsage?: (() => ContextUsage | undefined) | undefined;
    readonly isIdle?: (() => boolean) | undefined;
    readonly hasPendingMessages?: (() => boolean) | undefined;
    readonly compact?: ((options?: CompactOptions) => void) | undefined;
}

/**
 * Process-owned compaction single-flight and duplicate protection.
 * Lives on the extension owner slot and is shared by every runtime
 * in the process, so reconnect, caller timeout, and runtime
 * replacement never release unresolved native work or reset the ID
 * high-water mark. Identity and status only: never transcripts,
 * summaries, prompts, or costs.
 */
export interface CompactLatchState {
    /** The one unresolved bridge compaction, if any. */
    pending: {
        requestId: string;
        runtimeId: string;
        sessionId: string;
        /** A terminal result was already emitted (uncertain path). */
        reported: boolean;
    } | null;
    /** Highest recognized Compact request ID; older/duplicates refuse. */
    highWater: bigint | null;
    /** Currently active runtime, refreshed on foreign release. */
    active: { runtimeId: string; notify: () => void } | null;
}

/** Fresh latch for tests; production uses the process owner slot copy. */
export function freshCompactLatch(): CompactLatchState {
    return { pending: null, highWater: null, active: null };
}

/** Identity of one accepted Compact operation, captured at dispatch. */
interface CompactOp {
    readonly requestId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

/** Latest validated context sample; null means no current measurement. */
interface ContextSample {
    readonly tokens?: number | undefined;
    readonly contextWindow?: number | undefined;
    readonly percent?: number | undefined;
}

export type PiThinkingLevel = NonNullable<ExtensionContext['thinkingLevel']>;

export interface RuntimeOptions {
    readonly creds: ChannelCreds;
    readonly generation: bigint;
    /**
     * Process-owned compaction latch from the extension owner slot.
     * Shared by every runtime in the process; never a per-runtime copy.
     */
    readonly compactState: CompactLatchState;
    /** Host model switch; absent in tests that never switch. */
    readonly setModel?: (model: PiModelView) => Promise<boolean>;
    /** Native thinking APIs; both are required to advertise the capability. */
    readonly getThinkingLevel?: () => PiThinkingLevel;
    readonly setThinkingLevel?: (level: PiThinkingLevel) => void;
    /**
     * Live skill list from the host session. Present only when the
     * host exposes it; the capability needs this and invokeSkill
     * together.
     */
    readonly getSkills?: (() => readonly PiSkillView[]) | undefined;
    /**
     * Host skill invocation. Present only when the host exposes it.
     * Fire-and-forget: a later host-side failure is not observable
     * through the bridge.
     */
    readonly invokeSkill?: ((name: string) => void) | undefined;
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
    /**
     * Best-effort bounded drain, then close. The runtime
     * fire-and-forgets this on shutdown so queued settlement
     * edges flush instead of dropping; never rejects.
     */
    drainAndClose(timeoutMs: number): Promise<void>;
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

const COMPACT_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Parse a Compact request ID: positive canonical decimal uint64
 * syntax, no leading zeroes, within uint64 range. Null means
 * malformed; the caller drops it without touching the high-water mark.
 */
function parseCompactId(id: string): bigint | null {
    if (typeof id !== 'string' || !COMPACT_ID_PATTERN.test(id)) return null;
    const value = BigInt(id);
    return value <= MAX_UINT64 ? value : null;
}

/** Expected session/leaf/model identity bounds for Compact dispatch. */
function isValidCompactIdentity(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length >= 1 &&
        value.length <= MAX_COMPACT_IDENTITY_CHARS
    );
}

const INVALID_SAMPLE = Symbol('invalid');

/**
 * Validate one host usage field. Null/undefined means unknown;
 * anything else must be a finite number in range, else the whole
 * sampling is invalid and clears the current measurement.
 */
function usageField(
    value: unknown,
    positive: boolean,
): number | undefined | typeof INVALID_SAMPLE {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return INVALID_SAMPLE;
    }
    if (value < 0 || value > Number.MAX_SAFE_INTEGER) return INVALID_SAMPLE;
    if (positive && value <= 0) return INVALID_SAMPLE;
    return value;
}

/**
 * Normalize one getContextUsage result. Undefined/invalid input
 * yields null (clear the measurement); explicit host nulls yield
 * absent fields. Unknown is never zero: a zero token count stays
 * a present zero. Percent without a token count contradicts the
 * unknown-value contract, so it is omitted while a known window
 * is kept.
 */
function normalizeContextUsage(value: unknown): ContextSample | null {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const tokens = usageField(record['tokens'], false);
    const contextWindow = usageField(record['contextWindow'], true);
    const percent = usageField(record['percent'], false);
    if (
        tokens === INVALID_SAMPLE ||
        contextWindow === INVALID_SAMPLE ||
        percent === INVALID_SAMPLE
    ) {
        return null;
    }
    const knownPercent = tokens === undefined ? undefined : percent;
    if (
        tokens === undefined &&
        contextWindow === undefined &&
        knownPercent === undefined
    ) {
        return null;
    }
    return {
        ...(tokens !== undefined ? { tokens } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(knownPercent !== undefined ? { percent: knownPercent } : {}),
    };
}

/**
 * Map a host onError to the fixed safe outcome/reason vocabulary.
 * Never throws: hostile message getters or String coercions fall
 * back to a bare error, keeping the callback boundary nonthrowing.
 */
function mapCompactError(error: unknown): {
    outcome: CompactOutcome;
    reason: string;
} {
    let message: string;
    let aborted = false;
    try {
        // Convert inside the guard: the annotation cannot promise
        // a runtime string (a message getter may return a Symbol),
        // and the regex below must never receive a non-string.
        message = String(error instanceof Error ? error.message : error);
        // An aborted host work is a cancellation even when its message
        // never says so (Node's abort text is "aborted"). The name is
        // read without an instanceof test so a plain or foreign-realm
        // abort shape classifies the same way.
        aborted =
            String((error as { name?: unknown } | null)?.name ?? '') ===
            'AbortError';
    } catch {
        message = '';
    }
    if (/already compacted/i.test(message)) {
        return {
            outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
            reason: 'already-compacted',
        };
    }
    if (aborted || /cancel/i.test(message)) {
        return {
            outcome: CompactOutcome.COMPACT_OUTCOME_CANCELLED,
            reason: 'cancelled',
        };
    }
    return {
        outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
        reason: 'error',
    };
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
    /** Latest event context; sampling reads live host state through it. */
    private lastCtx: PiContextView | null = null;
    private historyAccepted = false;
    private modelsAccepted = false;
    private thinkingAccepted = false;
    private compactAccepted = false;
    private skillsAccepted = false;
    /** getContextUsage present on the latest event context. */
    private contextApi = false;
    /** compact/isIdle/hasPendingMessages present on the latest context. */
    private compactApi = false;
    /** Latest validated context measurement; null means none. */
    private contextSample: ContextSample | null = null;
    /** Latest idle/queued sample; null when the trio is unavailable. */
    private readinessSample: {
        readonly idle: boolean;
        readonly hasPendingMessages: boolean;
    } | null = null;
    /** Native compaction start observed without its end. */
    private compactionActive = false;
    /** Final assistant stop reason of the current run, if observed. */
    private lastStopReason: string | null = null;
    /** When the current stream was accepted; null while connecting. */
    private connectedAt: number | null = null;
    private shutdownRequested = false;
    private backoffMs: number;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private compactSettleTimer: ReturnType<typeof setTimeout> | null = null;
    private starting = false;

    constructor(private readonly opts: RuntimeOptions) {
        this.backoffMs = opts.backoffBaseMs ?? RECONNECT_BASE_MS;
    }

    /** Process-owned compaction latch, shared across runtimes. */
    private get compact(): CompactLatchState {
        return this.opts.compactState;
    }

    /** Begin connecting; never throws, never blocks Pi startup. */
    start(ctx: PiContextView): void {
        if (this.channel || this.starting || this.shutdownRequested) return;
        this.starting = true;
        this.compact.active = {
            runtimeId: this.runtimeId,
            notify: () => {
                try {
                    this.refreshFromLive();
                    this.sendSnapshot(
                        this.running
                            ? LogicalState.LOGICAL_STATE_RUNNING
                            : LogicalState.LOGICAL_STATE_IDLE,
                    );
                } catch {
                    // Release notifications never throw.
                }
            },
        };
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
     * A finalized assistant message also establishes a new context
     * measurement, published as a context-only snapshot.
     */
    onAgentEnd(stopReason: string | null): void {
        if (this.shutdownRequested || !this.running) return;
        this.lastStopReason = stopReason;
        this.publishContextOnly();
    }

    /**
     * A turn ended after its assistant message and every tool
     * result was persisted: resample and publish context-only
     * telemetry so a multi-turn tool run refreshes context per
     * turn. message_end is not sufficient: Pi emits it to
     * extensions before persistence. No lifecycle edge: running
     * state is untouched.
     */
    onTurnEnd(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.noteView(ctx);
        this.publishContextOnly();
    }

    /**
     * Publish the newest sample outside a lifecycle transition.
     * Bounded nonfatal admission: a miss keeps the newest sample
     * for the next authoritative baseline or transition. Sends
     * nothing when neither telemetry API is available. Never
     * throws: a publish failure is an admission miss, so the
     * stream receiver and event handlers stay nonthrowing.
     */
    private publishContextOnly(): void {
        if (this.lastCtx) this.sampleTelemetry(this.lastCtx);
        if (!this.contextApi && !this.compactApi) return;
        if (!this.channel) return;
        try {
            this.channel.sendNonfatal({
                paneId: this.opts.creds.pane,
                processId: this.opts.creds.process,
                runtimeGeneration: this.opts.generation,
                payload: {
                    $case: 'stateSnapshot',
                    value: this.snapshot(
                        this.running
                            ? LogicalState.LOGICAL_STATE_RUNNING
                            : LogicalState.LOGICAL_STATE_IDLE,
                    ),
                },
            });
        } catch {
            // The newest sample stays for the next authoritative
            // baseline or transition.
        }
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

    /**
     * Compaction starts: mark native work active, resample, and
     * publish the active state immediately through bounded
     * nonfatal admission. No lifecycle edge: dispatch guards and
     * the end event read the flag.
     */
    onCompactStart(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.compactionActive = true;
        this.noteView(ctx);
        this.publishContextOnly();
    }

    /**
     * Compaction ends: publish the post-compaction snapshot. Pi emits
     * session_compact before it clears its manual-compaction state,
     * so idle here may still read busy; bridge callbacks resample
     * again once that state has cleared.
     */
    onCompactEnd(ctx: PiContextView): void {
        if (this.shutdownRequested) return;
        this.compactionActive = false;
        this.noteView(ctx);
        this.sendSnapshot(
            this.running
                ? LogicalState.LOGICAL_STATE_RUNNING
                : LogicalState.LOGICAL_STATE_IDLE,
        );
        this.scheduleCompactSettle();
    }

    /**
     * Pi clears its manual-compaction state after session_compact, so
     * the sample taken at the event can still read busy. Bridge-owned
     * compaction refreshes from its completion callback; a compaction
     * started anywhere else (typed in the TUI) has no callback, so
     * publish one bounded refresh once that state has cleared. Never
     * sends a lifecycle edge and never throws.
     */
    private scheduleCompactSettle(attempt = 0): void {
        if (this.compactSettleTimer) clearTimeout(this.compactSettleTimer);
        this.compactSettleTimer = setTimeout(
            () => {
                this.compactSettleTimer = null;
                if (this.shutdownRequested) return;
                const idleBefore = this.readinessSample?.idle === true;
                this.refreshFromLive();
                if (this.readinessSample?.idle === true) {
                    if (!idleBefore) this.publishContextOnly();
                    return;
                }
                if (attempt < 2) this.scheduleCompactSettle(attempt + 1);
            },
            attempt === 0 ? 0 : 150,
        );
    }

    /** Idempotent shutdown: stop retrying and drain the stream. */
    shutdown(): void {
        if (this.shutdownRequested) return;
        this.shutdownRequested = true;
        // Shutdown releases active status, never unresolved native
        // work or duplicate protection: those stay process-owned.
        if (this.compact.active?.runtimeId === this.runtimeId) {
            this.compact.active = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.compactSettleTimer) {
            clearTimeout(this.compactSettleTimer);
            this.compactSettleTimer = null;
        }
        // Drain, don't drop: session_shutdown lands milliseconds
        // after agent_settled, and the settlement edge queued behind
        // context-only snapshots must flush before the stream dies.
        // Detach first so no later event can send; the bounded drain
        // closes the old channel even across session replacement.
        const channel = this.channel;
        this.channel = null;
        this.starting = false;
        if (channel) void channel.drainAndClose(SHUTDOWN_DRAIN_MS);
    }

    get isRunning(): boolean {
        return this.running;
    }

    get lastSequence(): bigint {
        return this.seq;
    }

    /** Refresh event-time identities and telemetry from the live view. */
    private noteView(ctx: PiContextView): void {
        this.lastCtx = ctx;
        this.refreshIdentities(ctx);
        this.sampleTelemetry(ctx);
    }

    /** Re-read identities and telemetry through the latest context. */
    private refreshFromLive(): void {
        if (this.lastCtx) this.noteView(this.lastCtx);
    }

    /**
     * Sample context and readiness from the host. Missing APIs
     * clear their sample; throwing APIs fail closed (unknown
     * context, not idle, messages pending). Never throws.
     */
    private sampleTelemetry(ctx: PiContextView): void {
        this.contextApi = typeof ctx.getContextUsage === 'function';
        this.compactApi =
            typeof ctx.compact === 'function' &&
            typeof ctx.isIdle === 'function' &&
            typeof ctx.hasPendingMessages === 'function';
        if (this.contextApi) {
            try {
                this.contextSample = normalizeContextUsage(
                    ctx.getContextUsage!(),
                );
            } catch {
                // Invalid/throwing sampling clears the measurement
                // rather than retaining an obsolete known value.
                this.contextSample = null;
            }
        } else {
            this.contextSample = null;
        }
        if (this.compactApi) {
            let idle = false;
            let hasPendingMessages = true;
            try {
                idle = ctx.isIdle!() === true;
            } catch {
                idle = false;
            }
            try {
                hasPendingMessages = ctx.hasPendingMessages!() !== false;
            } catch {
                hasPendingMessages = true;
            }
            this.readinessSample = { idle, hasPendingMessages };
        } else {
            this.readinessSample = null;
        }
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
        try {
            this.model = ctx.model;
            this.registry = ctx.modelRegistry;
            this.scopedModels = ctx.scopedModels ?? [];
            this.ui = ctx.ui;
        } catch {
            // Keep the last known views; a throwing host accessor
            // must not break Pi or unrelated bridge features.
        }
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
            contextUsage: this.contextSample
                ? ContextUsageSnapshot.create({
                      tokens: this.contextSample.tokens ?? undefined,
                      contextWindow:
                          this.contextSample.contextWindow ?? undefined,
                      percent: this.contextSample.percent ?? undefined,
                  })
                : undefined,
            compactReadiness: this.readinessSample
                ? CompactReadiness.create({
                      idle: this.readinessSample.idle,
                      hasPendingMessages:
                          this.readinessSample.hasPendingMessages,
                      compactionActive: this.compactionActive,
                      bridgePending: this.compact.pending !== null,
                  })
                : undefined,
        });
    }

    /**
     * Capabilities this runtime implements right now. History is
     * advertised only while the direct reader can reach a
     * history-shaped editor; print and RPC modes stay
     * lifecycle-only. Models needs only the registry and the host
     * switch call, so it is always advertised. Context needs
     * getContextUsage; compact needs the compact/isIdle/
     * hasPendingMessages trio; each is independent of the other.
     * Re-evaluated on every Hello, so reconnects follow API changes.
     */
    private capabilities(): string[] {
        const caps = [CAPABILITY_LIFECYCLE, CAPABILITY_MODELS];
        if (this.contextApi) caps.push(CAPABILITY_CONTEXT);
        if (this.compactApi) caps.push(CAPABILITY_COMPACT);
        if (isHistoryReaderAvailable(this.ui)) caps.push(CAPABILITY_HISTORY);
        if (this.opts.getThinkingLevel && this.opts.setThinkingLevel)
            caps.push(CAPABILITY_THINKING);
        // Skills need both host calls: the list and the invocation.
        if (this.opts.getSkills && this.opts.invokeSkill)
            caps.push(CAPABILITY_SKILLS);
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
        this.compactAccepted = false;
        this.skillsAccepted = false;
        // Reconnect carries a fresh baseline: resample through the
        // latest context so the Hello never replays a stale reading.
        if (this.lastCtx) this.sampleTelemetry(this.lastCtx);
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
                this.compactAccepted =
                    accepted.capabilities.includes(CAPABILITY_COMPACT);
                this.skillsAccepted =
                    accepted.capabilities.includes(CAPABILITY_SKILLS);
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
        } else if (
            msg.payload?.$case === 'compactRequest' &&
            this.compactAccepted
        ) {
            this.onCompactRequest(msg.payload.value);
        } else if (
            msg.payload?.$case === 'skillsRequest' &&
            this.skillsAccepted
        ) {
            this.onSkillsRequest(msg.payload.value.requestId);
        } else if (
            msg.payload?.$case === 'invokeSkillRequest' &&
            this.skillsAccepted
        ) {
            this.onInvokeSkillRequest(
                msg.payload.value.requestId,
                msg.payload.value.name,
            );
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

    /**
     * Answer one skills request with the session's live skill list.
     * Best-effort like models: a host failure, an entry that breaks
     * the wire bounds, or an oversized answer replies unavailable.
     * Entries are never silently dropped, so a partial list is never
     * shown as complete. Nothing here closes the stream.
     */
    private onSkillsRequest(requestId: string): void {
        if (typeof requestId !== 'string' || requestId === '') return;
        if (!this.channel) return;
        const getSkills = this.opts.getSkills;
        if (!getSkills) {
            this.channel.sendNonfatal(this.skillsResponse(requestId, null));
            return;
        }
        let raw: readonly PiSkillView[];
        try {
            raw = getSkills();
        } catch {
            this.channel.sendNonfatal(this.skillsResponse(requestId, null));
            return;
        }
        if (!Array.isArray(raw)) {
            this.channel.sendNonfatal(this.skillsResponse(requestId, null));
            return;
        }
        const entries: { name: string; description: string }[] = [];
        for (const skill of raw) {
            const entry = representableSkill(skill);
            if (!entry) {
                // One unrepresentable entry makes the whole list
                // unavailable; omitting it would show a partial list
                // as the session's complete skill set.
                this.channel.sendNonfatal(this.skillsResponse(requestId, null));
                return;
            }
            entries.push(entry);
        }
        let msg = this.skillsResponse(requestId, entries);
        if (PiToPhi.encode(msg).finish().length > MAX_MESSAGE_BYTES) {
            msg = this.skillsResponse(requestId, null);
        }
        if (!this.channel.sendNonfatal(msg)) {
            // Admission failure is nonfatal: answer unavailable so
            // Phi falls back promptly instead of waiting for a
            // reply that will never come.
            const sent = msg.payload;
            if (sent?.$case === 'skillsResponse' && !sent.value.unavailable) {
                this.channel.sendNonfatal(this.skillsResponse(requestId, null));
            }
        }
    }

    /**
     * Answer one skill invocation. The name must be known to the live
     * session; an unknown name acks unknown-skill without touching
     * the host. ok means the request was dispatched, never that the
     * agent accepted or completed it.
     */
    private onInvokeSkillRequest(requestId: string, name: string): void {
        if (typeof requestId !== 'string' || requestId === '') return;
        const fail = (reason: string): void => {
            this.channel?.sendNonfatal(
                this.invokeSkillAck(requestId, false, reason),
            );
        };
        const getSkills = this.opts.getSkills;
        const invokeSkill = this.opts.invokeSkill;
        if (!getSkills || !invokeSkill) {
            fail('unavailable');
            return;
        }
        if (
            typeof name !== 'string' ||
            name === '' ||
            Buffer.byteLength(name, 'utf8') > MAX_SKILL_NAME_BYTES
        ) {
            fail('unknown-skill');
            return;
        }
        if (!isAddressableSkillName(name)) {
            // The name cannot address one skill: "/skill:<name>"
            // would split at the first space and expand another one.
            fail('unavailable');
            return;
        }
        let known = false;
        try {
            const raw = getSkills();
            known =
                Array.isArray(raw) &&
                raw.some(
                    (skill) =>
                        typeof skill?.name === 'string' && skill.name === name,
                );
        } catch {
            fail('unavailable');
            return;
        }
        if (!known) {
            fail('unknown-skill');
            return;
        }
        try {
            invokeSkill(name);
        } catch {
            // A synchronous host failure is a refusal; a later
            // asynchronous host failure stays outside this ack.
            fail('unavailable');
            return;
        }
        this.channel?.sendNonfatal(this.invokeSkillAck(requestId, true, ''));
    }

    private skillsResponse(
        requestId: string,
        entries: { name: string; description: string }[] | null,
    ): PiToPhi {
        return {
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'skillsResponse',
                value:
                    entries === null
                        ? SkillsResponse.create({
                              requestId,
                              unavailable: true,
                          })
                        : SkillsResponse.create({
                              requestId,
                              skills: entries.slice(0, MAX_SKILL_ENTRIES),
                              truncated: entries.length > MAX_SKILL_ENTRIES,
                              unavailable: false,
                          }),
            },
        };
    }

    private invokeSkillAck(
        requestId: string,
        ok: boolean,
        reason: string,
    ): PiToPhi {
        return {
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'invokeSkillAck',
                value: InvokeSkillAck.create({ requestId, ok, reason }),
            },
        };
    }

    /**
     * Answer one Compact request. Every guard runs before invoking
     * the host; any failure refuses with a terminal result. Only a
     * well-formed ID newer than the process high-water mark can
     * reach the host, and every recognized ID is consumed so a
     * refused ID cannot later replay into a mutation. Synchronous
     * and nonblocking: the host call returns undefined at once and
     * the callbacks below settle the operation.
     */
    private onCompactRequest(req: {
        readonly requestId: string;
        readonly expectedSessionId: string;
        readonly expectedLeafId: string;
        readonly expectedModel?:
            | { readonly provider: string; readonly model: string }
            | undefined;
    }): void {
        const id = parseCompactId(req.requestId);
        // Malformed IDs drop silently, like other empty request ids.
        if (id === null || !this.channel) return;
        const highWater = this.compact.highWater;
        if (highWater !== null && id <= highWater) {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'duplicate',
            );
            return;
        }
        this.compact.highWater = id;
        if (this.compact.pending !== null) {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'pending',
            );
            return;
        }
        if (
            !isValidCompactIdentity(req.expectedSessionId) ||
            !isValidCompactIdentity(req.expectedLeafId) ||
            (req.expectedModel !== undefined &&
                (!isValidCompactIdentity(req.expectedModel.provider) ||
                    !isValidCompactIdentity(req.expectedModel.model)))
        ) {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'stale',
            );
            return;
        }
        const ctx = this.lastCtx;
        if (
            !ctx ||
            typeof ctx.compact !== 'function' ||
            typeof ctx.isIdle !== 'function' ||
            typeof ctx.hasPendingMessages !== 'function'
        ) {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'unavailable',
            );
            return;
        }
        // Admission fences use a live host read. A throwing getter
        // fails closed; cached identity is never evidence. An absent
        // expected model expects an absent live model.
        let liveSession: string;
        let liveLeaf: string;
        let liveHasModel: boolean;
        let liveProvider: unknown;
        let liveModelId: unknown;
        try {
            liveSession = ctx.sessionManager.getSessionId();
            liveLeaf = ctx.sessionManager.getLeafId() ?? '';
            const liveModel = ctx.model;
            liveHasModel = liveModel !== undefined && liveModel !== null;
            liveProvider = liveModel?.provider;
            liveModelId = liveModel?.id;
        } catch {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'stale',
            );
            return;
        }
        const modelFence =
            req.expectedModel !== undefined
                ? liveHasModel &&
                  liveProvider === req.expectedModel.provider &&
                  liveModelId === req.expectedModel.model
                : !liveHasModel;
        if (
            liveSession !== req.expectedSessionId ||
            liveLeaf !== req.expectedLeafId ||
            !modelFence
        ) {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'stale',
            );
            return;
        }
        let idle: boolean;
        try {
            idle = ctx.isIdle() === true;
        } catch {
            idle = false;
        }
        if (!idle) {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'busy',
            );
            return;
        }
        let queued: boolean;
        try {
            queued = ctx.hasPendingMessages() !== false;
        } catch {
            queued = true;
        }
        if (queued) {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'queued',
            );
            return;
        }
        if (this.compactionActive) {
            this.sendCompactResult(
                req.requestId,
                CompactOutcome.COMPACT_OUTCOME_REFUSED,
                'compaction-active',
            );
            return;
        }
        const op: CompactOp = {
            requestId: req.requestId,
            runtimeId: this.runtimeId,
            sessionId: liveSession,
        };
        this.compact.pending = { ...op, reported: false };
        // Publish bridge-pending readiness immediately, before
        // host invocation: even a synchronously settling host
        // leaves an observable pending frame for waiters.
        this.publishContextOnly();
        try {
            // Public API only, no instructions or summary overrides.
            // The undefined return is not success; only the
            // completion callback below establishes the outcome.
            ctx.compact({
                onComplete: () =>
                    this.settleCompactCallback(
                        op,
                        CompactOutcome.COMPACT_OUTCOME_COMPLETED,
                        '',
                    ),
                onError: (error) => {
                    const mapped = mapCompactError(error);
                    this.settleCompactCallback(
                        op,
                        mapped.outcome,
                        mapped.reason,
                    );
                },
            });
        } catch {
            // A synchronous callback may already have settled and
            // reported this operation before the throw: only the
            // matching unresolved, unreported operation turns
            // uncertain. Anything else already terminated, so a
            // second result must not follow.
            const pending = this.compact.pending;
            if (
                pending === null ||
                pending.requestId !== op.requestId ||
                pending.reported
            ) {
                return;
            }
            // A callbackless synchronous throw is uncertain, not
            // proof that work stopped: report unknown but retain the
            // unresolved latch rather than permit an automatic retry.
            pending.reported = true;
            this.refreshFromLive();
            this.sendCompactResult(
                op.requestId,
                CompactOutcome.COMPACT_OUTCOME_UNSPECIFIED,
                'uncertain',
            );
            this.sendSnapshot(
                this.running
                    ? LogicalState.LOGICAL_STATE_RUNNING
                    : LogicalState.LOGICAL_STATE_IDLE,
            );
        }
    }

    /**
     * Settle one native compaction callback. Releases only the
     * matching operation and terminates at most once; publishes the
     * terminal result only when this runtime still owns the current
     * session. Old callbacks never publish old-session state, but
     * their release refreshes the active runtime's readiness using
     * its current context. Never throws.
     */
    private settleCompactCallback(
        op: CompactOp,
        outcome: CompactOutcome,
        reason: string,
    ): void {
        try {
            const pending = this.compact.pending;
            if (pending === null || pending.requestId !== op.requestId) {
                return;
            }
            this.compact.pending = null;
            if (pending.reported) {
                // Already terminated on the uncertain path: release
                // only, without a second result.
                this.refreshAfterRelease();
                return;
            }
            if (this.ownsCurrentSession(op)) {
                // Native success changes the leaf: refresh, never
                // fence completion on the old leaf.
                this.refreshFromLive();
                this.sendCompactResult(op.requestId, outcome, reason);
                this.sendSnapshot(
                    this.running
                        ? LogicalState.LOGICAL_STATE_RUNNING
                        : LogicalState.LOGICAL_STATE_IDLE,
                );
                return;
            }
            this.refreshAfterRelease();
        } catch {
            // The operation was already released above, so a
            // bookkeeping or publish error here cannot cause a
            // second failure result.
        }
    }

    /**
     * True when this runtime is still active and the live session
     * still matches the operation. A throwing read fails closed.
     */
    private ownsCurrentSession(op: CompactOp): boolean {
        if (this.compact.active?.runtimeId !== this.runtimeId) return false;
        try {
            return this.lastCtx?.sessionManager.getSessionId() === op.sessionId;
        } catch {
            return false;
        }
    }

    /**
     * Refresh the active runtime's readiness after a foreign
     * release, using that runtime's current context. Never throws.
     */
    private refreshAfterRelease(): void {
        try {
            const active = this.compact.active;
            if (active === null) return;
            if (active.runtimeId === this.runtimeId) {
                this.refreshFromLive();
                this.sendSnapshot(
                    this.running
                        ? LogicalState.LOGICAL_STATE_RUNNING
                        : LogicalState.LOGICAL_STATE_IDLE,
                );
                return;
            }
            active.notify();
        } catch {
            // Release notifications never throw.
        }
    }

    /**
     * Send one terminal Compact result. Nonfatal response-class
     * admission, like history and model answers: an admission miss
     * lets the waiter expire into unknown instead of disturbing
     * lifecycle traffic.
     */
    private sendCompactResult(
        requestId: string,
        outcome: CompactOutcome,
        reason: string,
    ): void {
        this.channel?.sendNonfatal({
            paneId: this.opts.creds.pane,
            processId: this.opts.creds.process,
            runtimeGeneration: this.opts.generation,
            payload: {
                $case: 'compactResult',
                value: CompactResult.create({ requestId, outcome, reason }),
            },
        });
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
