// Production gRPC channel for one extension runtime. It owns the duplex
// stream, the bounded outbound queue, and terminal-status reporting.
// Reconnect policy lives in the runtime; this channel manages one stream
// attempt. The client factory is injectable for mock-stream tests.

import {
    ChannelCredentials,
    type ClientDuplexStream,
    Metadata,
    type ServiceError,
} from '@grpc/grpc-js';
import {
    type Accepted,
    IntegrationClient,
    type PhiToPi,
    PiToPhi,
} from './gen/bridge.js';
import { parseTarget } from './endpoint.js';
import {
    BLOCKED_SEND_TIMEOUT_MS,
    HELLO_DEADLINE_MS,
    LIFECYCLE_HEADROOM_BYTES,
    LIFECYCLE_HEADROOM_MESSAGES,
    MAX_MESSAGE_BYTES,
    MAX_QUEUED_BYTES,
    MAX_QUEUED_MESSAGES,
    METADATA_PANE_KEY,
    METADATA_PROCESS_KEY,
    METADATA_TOKEN_KEY,
} from './protocol.js';
import { BoundedQueue } from './queue.js';

export interface ChannelCreds {
    readonly target: string;
    readonly pane: string;
    readonly process: string;
    readonly token: string;
}

export interface ChannelHooks {
    onMessage(msg: PhiToPi): void;
    /** Terminal stream status; null only on a clean local close. */
    onStatus(status: ServiceError | null): void;
}

export type DuplexStream = ClientDuplexStream<PiToPhi, PhiToPi>;

export type ClientFactory = (
    target: string,
    creds: ChannelCredentials,
    options: Record<string, unknown>,
) => { connect(metadata: Metadata): DuplexStream; close(): void };

const defaultClientFactory: ClientFactory = (target, creds, options) =>
    // SAFETY: the generated client implements connect/cancel/close with
    // compatible signatures; the assertion only narrows to the used surface.
    new IntegrationClient(target, creds, options) as unknown as {
        connect(metadata: Metadata): DuplexStream;
        close(): void;
    };

interface QueuedFrame {
    readonly byteSize: number;
    readonly msg: PiToPhi;
}

/** One duplex stream attempt with a bounded writer. */
export class BridgeChannel {
    private client: {
        connect(metadata: Metadata): DuplexStream;
        close(): void;
    } | null = null;
    private stream: DuplexStream | null = null;
    private queue = new BoundedQueue<QueuedFrame>();
    private writerActive = false;
    private writerError: Error | null = null;
    private closed = false;
    private blockedTimeout = false;
    private acceptedWaiters: Array<{
        resolve: (a: Accepted) => void;
        reject: (e: Error) => void;
    }> = [];

    constructor(
        private readonly creds: ChannelCreds,
        private readonly hooks: ChannelHooks,
        private readonly makeClient: ClientFactory = defaultClientFactory,
    ) {}

    /** Open the stream, send Hello, and await Accepted or a status. */
    async connect(hello: PiToPhi): Promise<Accepted> {
        // Only server-generated local targets are dialable. A TCP or
        // authority-shaped target must never reach the transport, so
        // the check runs before the client exists.
        parseTarget(this.creds.target);
        this.client = this.makeClient(
            this.creds.target,
            ChannelCredentials.createInsecure(),
            {
                'grpc.use_local_subchannel_pool': 1,
                'grpc.enable_retries': 0,
                'grpc.enable_http_proxy': 0,
                'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
                'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
            },
        );
        const md = new Metadata();
        md.set(METADATA_PANE_KEY, this.creds.pane);
        md.set(METADATA_PROCESS_KEY, this.creds.process);
        md.set(METADATA_TOKEN_KEY, this.creds.token);
        const stream = this.client.connect(md);
        this.stream = stream;
        stream.on('status', (status: ServiceError) => {
            // A blocked-send timeout cancels the stream locally; grpc-js
            // reports that self-cancel as CANCELLED. Preserve the local
            // reason as retryable UNAVAILABLE so the runtime reconnects
            // instead of treating it as a remote lease revocation.
            if (this.blockedTimeout && status.code === 1) {
                const retryable = Object.assign(
                    new Error('blocked send timeout'),
                    {
                        code: 14,
                        details: 'blocked send timeout',
                        metadata: status.metadata,
                    },
                ) as ServiceError;
                this.failWaiters(retryable);
                this.hooks.onStatus(retryable);
                return;
            }
            const terminal = status.code === 0 ? null : status;
            this.failWaiters(
                terminal ?? new Error('stream ended before accepted'),
            );
            this.hooks.onStatus(terminal);
        });
        stream.on('error', () => {
            // Status carries the terminal code; error avoids unhandled throws.
        });
        stream.on('data', (msg: PhiToPi) => {
            if (msg.payload?.$case === 'accepted') {
                const waiter = this.acceptedWaiters.shift();
                if (waiter) waiter.resolve(msg.payload.value);
                return;
            }
            this.hooks.onMessage(msg);
        });
        this.enqueue(hello);
        void this.pumpWriter();
        return new Promise<Accepted>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeWaiter(resolve);
                reject(new Error('accepted deadline'));
            }, HELLO_DEADLINE_MS);
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
        });
    }

    /**
     * Queue one message. Returns false on overflow without mutating; the
     * caller treats overflow as fatal for this stream attempt.
     */
    send(msg: PiToPhi): boolean {
        if (this.closed || this.writerError) return false;
        try {
            this.enqueue(msg);
        } catch {
            return false;
        }
        void this.pumpWriter();
        return true;
    }

    /**
     * Queue one history response. Returns false when the frame would
     * breach the history byte cap; unlike send, admission failure is
     * nonfatal and leaves the stream usable for lifecycle traffic.
     */
    sendHistory(msg: PiToPhi): boolean {
        if (this.closed || this.writerError) return false;
        const byteSize = PiToPhi.encode(msg).finish().length;
        if (
            !this.queue.tryEnqueueWithByteCap(
                { byteSize, msg },
                MAX_QUEUED_BYTES - LIFECYCLE_HEADROOM_BYTES,
                MAX_QUEUED_MESSAGES - LIFECYCLE_HEADROOM_MESSAGES,
            )
        ) {
            return false;
        }
        void this.pumpWriter();
        return true;
    }

    /** Half-close the stream and release the client. Idempotent. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.failWaiters(new Error('channel closed'));
        try {
            this.stream?.end();
        } catch {
            // Already torn down; close stays idempotent.
        }
        try {
            this.client?.close();
        } catch {
            // Already torn down; close stays idempotent.
        }
        this.stream = null;
        this.client = null;
    }

    get pending(): number {
        return this.queue.outstanding;
    }

    private enqueue(msg: PiToPhi): void {
        const byteSize = PiToPhi.encode(msg).finish().length;
        if (!this.queue.tryEnqueue({ byteSize, msg })) {
            this.writerError = new Error('bounded send queue full');
            throw this.writerError;
        }
    }

    private failWaiters(err: Error): void {
        const waiters = this.acceptedWaiters;
        this.acceptedWaiters = [];
        for (const w of waiters) w.reject(err);
    }

    private removeWaiter(resolve: (a: Accepted) => void): void {
        this.acceptedWaiters = this.acceptedWaiters.filter(
            (w) => w.resolve !== resolve,
        );
    }

    private async pumpWriter(): Promise<void> {
        if (this.writerActive) return;
        this.writerActive = true;
        try {
            for (;;) {
                // Check teardown before dequeuing: a frame taken past
                // this point without its matching endSend would leak.
                if (this.stream === null || this.closed) return;
                const frame = this.queue.beginSend();
                if (frame === undefined) return;
                try {
                    await this.writeWithDrain(frame.msg);
                } catch {
                    return;
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
                this.blockedTimeout = true;
                try {
                    stream.cancel();
                } catch {
                    // Already torn down; the timeout still stands.
                }
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
                const writable = stream.write(msg, () => done());
                if (!writable) stream.once('drain', () => done());
            } catch (err) {
                done(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
}
