// M1 interop fixture: a synthetic Pi runtime over the generated client.
// It enforces the bounded queue, metadata shape, and proxy-off dial
// options the product extension reuses. Not shipped; integration tests
// own its lifecycle.

import {
    ChannelCredentials,
    type ClientDuplexStream,
    Metadata,
    type ServiceError,
} from '@grpc/grpc-js';
import {
    type Accepted,
    AgentSettled,
    AgentStarted,
    type CompactOutcome,
    type CompactRequest,
    CompactResult,
    ReloadAck,
    type ReloadDispatchOutcome,
    type ReloadRequest,
    IntegrationClient,
    type PhiToPi,
    PiToPhi,
    SyncboardOperation,
    SyncboardRequest,
    type SyncboardResponse,
    type StateSnapshot,
} from './gen/bridge.js';
import { parseTarget } from './endpoint.js';
import {
    BLOCKED_SEND_TIMEOUT_MS,
    CAPABILITY_LIFECYCLE,
    HELLO_DEADLINE_MS,
    MAX_MESSAGE_BYTES,
    SYNCBOARD_CALL_TIMEOUT_MS,
    METADATA_PANE_KEY,
    METADATA_PROCESS_KEY,
    METADATA_TOKEN_KEY,
    PROTOCOL_VERSION,
} from './protocol.js';
import { BoundedQueue } from './queue.js';

export interface TestClientOptions {
    target: string;
    pane: string;
    process: string;
    token: string;
    generation?: bigint | undefined;
    runtimeId?: string | undefined;
    sessionId?: string | undefined;
    capabilities?: string[] | undefined;
    state?: StateSnapshot | undefined;
}

interface QueuedFrame {
    readonly byteSize: number;
    readonly msg: PiToPhi;
}

/** Synthetic runtime with queue and explicit stream status. */
export class BridgeTestClient {
    readonly pane: string;
    readonly process: string;
    readonly generation: bigint;
    readonly runtimeId: string;
    readonly sessionId: string;

    private client: IntegrationClient;
    private stream: ClientDuplexStream<PiToPhi, PhiToPi> | null = null;
    private queue = new BoundedQueue<QueuedFrame>();
    private writerActive = false;
    private writerError: Error | null = null;
    private statusPromise: Promise<ServiceError | null> | null = null;
    private statusResolve: ((e: ServiceError | null) => void) | null = null;
    private token: string;
    private capabilities: string[];
    private state: StateSnapshot | undefined;
    private syncboardSequence = 0n;
    private syncboardWaiters = new Map<
        string,
        {
            resolve: (value: SyncboardResponse) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();

    constructor(opts: TestClientOptions) {
        const parsed = parseTarget(opts.target);
        if (parsed.kind !== 'unix' && process.platform !== 'win32') {
            throw new Error(
                `unsupported target kind ${parsed.kind} on ${process.platform}`,
            );
        }
        this.pane = opts.pane;
        this.process = opts.process;
        this.token = opts.token;
        this.generation = opts.generation ?? 1n;
        this.runtimeId = opts.runtimeId ?? `rt-${opts.pane}`;
        this.sessionId = opts.sessionId ?? `sess-${opts.pane}`;
        this.capabilities = opts.capabilities ?? [CAPABILITY_LIFECYCLE];
        this.state = opts.state;

        this.client = new IntegrationClient(
            opts.target,
            ChannelCredentials.createInsecure(),
            {
                'grpc.use_local_subchannel_pool': 1,
                'grpc.enable_retries': 0,
                'grpc.enable_http_proxy': 0,
                'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
                'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
            },
        );
    }

    /** Override the hello identity for negative tests. */
    withHelloOverride(over: {
        protocolVersion?: number;
        sessionId?: string;
        runtimeId?: string;
    }): this {
        this.helloOverride = over;
        return this;
    }
    private helloOverride: {
        protocolVersion?: number;
        sessionId?: string;
        runtimeId?: string;
    } = {};

    /** Open the stream, send Hello, and await Accepted or a status. */
    async connect(): Promise<Accepted> {
        const md = new Metadata();
        md.set(METADATA_PANE_KEY, this.pane);
        md.set(METADATA_PROCESS_KEY, this.process);
        md.set(METADATA_TOKEN_KEY, this.token);
        const stream = this.client.connect(md);
        this.stream = stream;
        this.statusPromise = new Promise((resolve) => {
            this.statusResolve = resolve;
        });
        stream.on('status', (status: ServiceError) => {
            this.statusResolve?.(status.code === 0 ? null : status);
            this.failSyncboardWaiters(
                new Error(status.details || 'bridge stream ended'),
            );
        });
        stream.on('error', () => {
            // Status carries the terminal code; error avoids unhandled throws.
        });
        stream.on('data', (msg: PhiToPi) => {
            void this.handleServerMessage(msg);
        });
        const hello: PiToPhi = {
            paneId: this.pane,
            processId: this.process,
            runtimeGeneration: this.generation,
            payload: {
                $case: 'hello',
                value: {
                    protocolVersion:
                        this.helloOverride.protocolVersion ?? PROTOCOL_VERSION,
                    sessionId: this.helloOverride.sessionId ?? this.sessionId,
                    runtimeId: this.helloOverride.runtimeId ?? this.runtimeId,
                    capabilities: this.capabilities,
                    currentState: this.state,
                    journalFirstSequence: 0n,
                    journalLastSequence: 0n,
                },
            },
        };
        this.enqueueFrame(hello);
        void this.pumpWriter();
        const accepted = await this.awaitAccepted();
        return accepted;
    }

    private acceptedQueue: Accepted[] = [];
    private acceptedWaiters: Array<{
        resolve: (a: Accepted) => void;
        reject: (e: Error) => void;
    }> = [];

    private async awaitAccepted(): Promise<Accepted> {
        const accepted = this.acceptedQueue.shift();
        if (accepted !== undefined) return accepted;
        return new Promise<Accepted>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('accepted deadline')),
                HELLO_DEADLINE_MS,
            );
            this.acceptedWaiters.push({
                resolve: (a: Accepted) => {
                    clearTimeout(timer);
                    resolve(a);
                },
                reject: (e: Error) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            void this.statusPromise?.then((status) => {
                if (status) {
                    const waiter = this.acceptedWaiters.shift();
                    waiter?.reject(
                        Object.assign(
                            new Error(status.details || 'connect failed'),
                            { code: status.code },
                        ),
                    );
                }
            });
        });
    }

    private async handleServerMessage(msg: PhiToPi): Promise<void> {
        const payload = msg.payload;
        if (payload?.$case === 'accepted') {
            const waiter = this.acceptedWaiters.shift();
            if (waiter) waiter.resolve(payload.value);
            else this.acceptedQueue.push(payload.value);
            return;
        }
        if (payload?.$case === 'syncboardResponse') {
            const waiter = this.syncboardWaiters.get(payload.value.requestId);
            if (waiter) {
                clearTimeout(waiter.timer);
                this.syncboardWaiters.delete(payload.value.requestId);
                waiter.resolve(payload.value);
            }
            return;
        }
        if (payload?.$case === 'compactRequest') {
            const waiter = this.compactRequestWaiters.shift();
            if (waiter) waiter(payload.value);
            else this.compactRequestQueue.push(payload.value);
            this.compactRequestTotal += 1;
            return;
        }
        if (payload?.$case === 'reloadRequest') {
            const waiter = this.reloadRequestWaiters.shift();
            if (waiter) waiter(payload.value);
            else this.reloadRequestQueue.push(payload.value);
            this.reloadRequestTotal += 1;
            return;
        }
        // ProtocolError and unknown oneofs are informational; stream status
        // carries terminal failures.
    }

    private compactRequestQueue: CompactRequest[] = [];
    private compactRequestWaiters: Array<(r: CompactRequest) => void> = [];
    private compactRequestTotal = 0;

    /** Send one request and await its matching Go bridge response. */
    requestSyncboard(
        operation: SyncboardOperation,
        key: string,
        valueJson?: Uint8Array,
    ): Promise<SyncboardResponse> {
        const requestId = (++this.syncboardSequence).toString();
        const message: PiToPhi = {
            paneId: this.pane,
            processId: this.process,
            runtimeGeneration: this.generation,
            payload: {
                $case: 'syncboardRequest',
                value: SyncboardRequest.create({
                    requestId,
                    operation,
                    key,
                    valueJson: Buffer.from(valueJson ?? new Uint8Array()),
                }),
            },
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.syncboardWaiters.delete(requestId);
                reject(new Error('Syncboard response deadline'));
            }, SYNCBOARD_CALL_TIMEOUT_MS);
            this.syncboardWaiters.set(requestId, { resolve, reject, timer });
            try {
                this.enqueueFrame(message);
                void this.pumpWriter();
            } catch (cause) {
                clearTimeout(timer);
                this.syncboardWaiters.delete(requestId);
                reject(
                    cause instanceof Error ? cause : new Error(String(cause)),
                );
            }
        });
    }

    private failSyncboardWaiters(error: Error): void {
        for (const [requestId, waiter] of this.syncboardWaiters) {
            clearTimeout(waiter.timer);
            this.syncboardWaiters.delete(requestId);
            waiter.reject(error);
        }
    }

    /** Await the next CompactRequest dispatched by the server. */
    async awaitCompactRequest(timeoutMs = 5_000): Promise<CompactRequest> {
        const queued = this.compactRequestQueue.shift();
        if (queued !== undefined) return queued;
        return new Promise<CompactRequest>((resolve, reject) => {
            const waiter = (req: CompactRequest) => {
                clearTimeout(timer);
                resolve(req);
            };
            const timer = setTimeout(() => {
                // An expired waiter must leave the queue: otherwise the
                // next request resolves an already-rejected promise and
                // is lost before its own waiter can see it.
                const at = this.compactRequestWaiters.indexOf(waiter);
                if (at >= 0) this.compactRequestWaiters.splice(at, 1);
                reject(new Error('compact request deadline'));
            }, timeoutMs);
            this.compactRequestWaiters.push(waiter);
        });
    }

    /** Total CompactRequests received on this stream. Proves (non-)dispatch. */
    receivedCompactRequests(): number {
        return this.compactRequestTotal;
    }

    private reloadRequestQueue: ReloadRequest[] = [];
    private reloadRequestWaiters: Array<(r: ReloadRequest) => void> = [];
    private reloadRequestTotal = 0;

    /** Await the next ReloadRequest dispatched by the server. */
    async awaitReloadRequest(timeoutMs = 5_000): Promise<ReloadRequest> {
        const queued = this.reloadRequestQueue.shift();
        if (queued !== undefined) return queued;
        return new Promise<ReloadRequest>((resolve, reject) => {
            const waiter = (req: ReloadRequest) => {
                clearTimeout(timer);
                resolve(req);
            };
            const timer = setTimeout(() => {
                const at = this.reloadRequestWaiters.indexOf(waiter);
                if (at >= 0) this.reloadRequestWaiters.splice(at, 1);
                reject(new Error('reload request deadline'));
            }, timeoutMs);
            this.reloadRequestWaiters.push(waiter);
        });
    }

    /** Total ReloadRequests received on this stream. Proves (non-)dispatch. */
    receivedReloadRequests(): number {
        return this.reloadRequestTotal;
    }

    /** Report the native callback-entry receipt for requestId. */
    sendReloadAck(
        requestId: string,
        outcome: ReloadDispatchOutcome,
        reason = '',
    ): void {
        this.enqueueFrame({
            paneId: this.pane,
            processId: this.process,
            runtimeGeneration: this.generation,
            payload: {
                $case: 'reloadAck',
                value: ReloadAck.create({ requestId, outcome, reason }),
            },
        });
        void this.pumpWriter();
    }

    /** Report one terminal Compact outcome for requestId. */
    sendCompactResult(
        requestId: string,
        outcome: CompactOutcome,
        reason = '',
    ): void {
        this.enqueueFrame({
            paneId: this.pane,
            processId: this.process,
            runtimeGeneration: this.generation,
            payload: {
                $case: 'compactResult',
                value: CompactResult.create({ requestId, outcome, reason }),
            },
        });
        void this.pumpWriter();
    }

    sendStarted(eventSequence: bigint, runId: bigint): void {
        this.enqueueFrame({
            paneId: this.pane,
            processId: this.process,
            runtimeGeneration: this.generation,
            payload: {
                $case: 'agentStarted',
                value: AgentStarted.create({ eventSequence, runId }),
            },
        });
        void this.pumpWriter();
    }

    sendSettled(
        eventSequence: bigint,
        runId: bigint,
        outcome: AgentSettled['outcome'],
    ): void {
        this.enqueueFrame({
            paneId: this.pane,
            processId: this.process,
            runtimeGeneration: this.generation,
            payload: {
                $case: 'agentSettled',
                value: AgentSettled.create({ eventSequence, runId, outcome }),
            },
        });
        void this.pumpWriter();
    }

    sendSnapshot(state: StateSnapshot): void {
        this.enqueueFrame({
            paneId: this.pane,
            processId: this.process,
            runtimeGeneration: this.generation,
            payload: { $case: 'stateSnapshot', value: state },
        });
        void this.pumpWriter();
    }

    /** Send a raw message, bypassing helpers for negative tests. */
    sendRaw(msg: PiToPhi): void {
        this.enqueueFrame(msg);
        void this.pumpWriter();
    }

    private enqueueFrame(msg: PiToPhi): void {
        const byteSize = PiToPhi.encode(msg).finish().length;
        if (!this.queue.tryEnqueue({ byteSize, msg })) {
            this.writerError = new Error('bounded send queue full');
            this.stream?.cancel();
            throw this.writerError;
        }
    }

    private async pumpWriter(): Promise<void> {
        if (this.writerActive) return;
        this.writerActive = true;
        try {
            for (;;) {
                const frame = this.queue.beginSend();
                if (frame === undefined || this.stream === null) return;
                try {
                    await this.writeWithDrain(frame.msg);
                } finally {
                    this.queue.endSend(frame);
                }
                if (this.writerError) return;
            }
        } finally {
            this.writerActive = false;
        }
    }

    private writeWithDrain(msg: PiToPhi): Promise<void> {
        const stream = this.stream;
        if (stream === null) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this.writerError = new Error('blocked send timeout');
                stream.cancel();
                reject(this.writerError);
            }, BLOCKED_SEND_TIMEOUT_MS);
            const done = (err?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err) reject(err);
                else resolve();
            };
            try {
                const ok = stream.write(msg, () => done());
                if (ok) {
                    // Write callback settles; timer guards a stalled transport.
                } else {
                    stream.once('drain', () => done());
                }
            } catch (err) {
                done(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    /** Wait until the outbound queue drains, for paced bulk sends. */
    async drain(timeoutMs = 5_000): Promise<void> {
        const start = Date.now();
        for (;;) {
            if (this.queue.outstanding === 0) return;
            if (this.writerError) throw this.writerError;
            if (Date.now() - start > timeoutMs)
                throw new Error('drain timeout');
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    /** Pause network reads to simulate a slow peer. */
    pause(): void {
        this.stream?.pause();
    }

    resume(): void {
        this.stream?.resume();
    }

    /** Await the terminal stream status (null for clean EOF). */
    async awaitStatus(): Promise<ServiceError | null> {
        return this.statusPromise ?? null;
    }

    async close(): Promise<void> {
        this.failSyncboardWaiters(new Error('bridge client closed'));
        this.stream?.end();
        this.client.close();
    }
}
