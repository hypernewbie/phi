// Extension runtime: one claimed session_start owns one Runtime. It maps
// Pi lifecycle events to bridge edges, retains the bounded journal,
// publishes authoritative snapshots on transitions, and reconnects the
// stream with the same generation after transport failures. It never
// starts provider work and never touches the Pi session.

import { randomUUID } from 'node:crypto';
import type { ServiceError } from '@grpc/grpc-js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
    AgentSettled,
    AgentStarted,
    Hello,
    LogicalState,
    ModelSnapshot,
    type PiToPhi,
    RunOutcome,
    StateSnapshot,
} from './gen/bridge.js';
import { BridgeChannel, type ChannelCreds } from './channel.js';
import { InvalidTargetError } from './endpoint.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { CAPABILITY_LIFECYCLE } from './protocol.js';
import { MAX_JOURNAL_RECORDS } from './protocol.js';
import { RECONNECT_BASE_MS } from './protocol.js';
import { RECONNECT_MAX_MS } from './protocol.js';
import { RECONNECT_STABLE_MS } from './protocol.js';

/** Structural Pi session view; satisfied by both pinned host versions. */
export interface PiSessionView {
    getSessionId(): string;
    getLeafId(): string | null;
}

/** The live host model object, for provider routing. Never copied. */
export type PiModelView = NonNullable<ExtensionContext['model']>;

/** Structural Pi event-context view; satisfied by both pinned versions. */
export interface PiContextView {
    readonly sessionManager: PiSessionView;
    readonly model?: PiModelView | undefined;
}

export interface RuntimeOptions {
    readonly creds: ChannelCreds;
    readonly generation: bigint;
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
        });
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
                    capabilities: [CAPABILITY_LIFECYCLE],
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
        const channel = make(this.opts.creds, {
            onMessage: (msg) => this.onServerMessage(msg),
            onStatus: (status) => this.onStreamEnd(status),
        });
        this.channel = channel;
        try {
            await channel.connect(this.hello());
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

    private onServerMessage(_msg: import('./gen/bridge.js').PhiToPi): void {
        // The lifecycle runtime issues no commands, so Phi sends only
        // Accepted and ProtocolError. Terminal failures arrive as the
        // stream status, not messages. Everything here is informational.
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
