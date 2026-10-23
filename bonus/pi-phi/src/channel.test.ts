import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceError } from '@grpc/grpc-js';
import { InvalidTargetError } from './endpoint.js';
import {
    LIFECYCLE_HEADROOM_BYTES,
    MAX_QUEUED_BYTES,
    MAX_QUEUED_MESSAGES,
} from './protocol.js';
import {
    BridgeChannel,
    type ChannelCreds,
    type ClientFactory,
} from './channel.js';
import { Hello, HistoryResponse, LogicalState, PiToPhi } from './gen/bridge.js';

const CREDS: ChannelCreds = {
    target: 'unix:/tmp/phi-pi-abc/bridge.sock',
    pane: 'pane',
    process: 'proc',
    token: 'tok',
};

function hello(): PiToPhi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: {
            $case: 'hello',
            value: Hello.create({
                protocolVersion: 1,
                sessionId: 'sess',
                runtimeId: 'rt',
                capabilities: [],
                currentState: {
                    state: LogicalState.LOGICAL_STATE_IDLE,
                } as never,
                journalFirstSequence: 0n,
                journalLastSequence: 0n,
            }),
        },
    };
}

/** Client factory that records calls and returns an unusable stream. */
function countingFactory(): { factory: ClientFactory; calls: () => number } {
    let made = 0;
    const factory: ClientFactory = () => {
        made += 1;
        return {
            connect: () => {
                throw new Error('no stream in this test');
            },
            close: () => {},
        };
    };
    return { factory, calls: () => made };
}

describe('BridgeChannel target validation', () => {
    it('refuses to dial a target that is not a local socket', async () => {
        const { factory, calls } = countingFactory();
        for (const target of [
            'dns:///evil.example:443',
            'tcp://127.0.0.1:9000',
            'unix:relative/path.sock',
            'unix://authority/path.sock',
        ]) {
            const channel = new BridgeChannel(
                { ...CREDS, target },
                { onMessage: () => {}, onStatus: () => {} },
                factory,
            );
            await expect(channel.connect(hello())).rejects.toBeInstanceOf(
                InvalidTargetError,
            );
            channel.close();
        }
        expect(calls()).toBe(0);
    });

    it('dials a valid local target', async () => {
        const { factory, calls } = countingFactory();
        const channel = new BridgeChannel(
            CREDS,
            { onMessage: () => {}, onStatus: () => {} },
            factory,
        );
        // The stub client has no stream, so connect fails after the
        // target check passed. The client must exist by then.
        await channel.connect(hello()).catch(() => {});
        expect(calls()).toBe(1);
        channel.close();
    });
});

/** Mock duplex stream: hello succeeds, later writes stall forever. */
class StallingDuplex extends EventEmitter {
    writes = 0;
    cancels = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write(msg: any, cb?: () => void): boolean {
        void msg;
        this.writes += 1;
        if (this.writes === 1) {
            queueMicrotask(() => {
                cb?.();
                this.emit('data', {
                    payload: {
                        $case: 'accepted',
                        value: {
                            protocolVersion: 1,
                            capabilities: [],
                            runtimeGeneration: 1n,
                            runtimeId: 'rt',
                        },
                    },
                });
            });
            return true;
        }
        return false;
    }
    end(): void {}
    cancel(): void {
        this.cancels += 1;
        queueMicrotask(() => {
            this.emit('status', {
                code: 1,
                details: 'Cancelled',
                metadata: {},
            } as ServiceError);
        });
    }
}

describe('BridgeChannel blocked sends', () => {
    it('reports a locally timed-out send as retryable', async () => {
        vi.useFakeTimers();
        try {
            let reported: ServiceError | null | undefined;
            const duplex = new StallingDuplex();
            const factory: ClientFactory = () => ({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                connect: () => duplex as any,
                close: () => {},
            });
            const channel = new BridgeChannel(
                CREDS,
                {
                    onMessage: () => {},
                    onStatus: (s) => {
                        reported = s;
                    },
                },
                factory,
            );
            const accepted = channel.connect(hello());
            await vi.advanceTimersByTimeAsync(0);
            await accepted;
            expect(channel.send(hello())).toBe(true);
            await vi.advanceTimersByTimeAsync(6000);
            await vi.advanceTimersByTimeAsync(0);
            expect(duplex.cancels).toBe(1);
            expect(reported?.code).toBe(14);
            channel.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves a genuine remote cancellation as terminal', async () => {
        let reported: ServiceError | null | undefined;
        const duplex = new EventEmitter() as EventEmitter & {
            write: (msg: unknown, cb?: () => void) => boolean;
            end: () => void;
            cancel: () => void;
        };
        duplex.write = (_msg: unknown, cb?: () => void) => {
            queueMicrotask(() => {
                cb?.();
                duplex.emit('data', {
                    payload: {
                        $case: 'accepted',
                        value: {
                            protocolVersion: 1,
                            capabilities: [],
                            runtimeGeneration: 1n,
                            runtimeId: 'rt',
                        },
                    },
                });
            });
            return true;
        };
        duplex.end = () => {};
        duplex.cancel = () => {};
        const factory: ClientFactory = () => ({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            connect: () => duplex as any,
            close: () => {},
        });
        const channel = new BridgeChannel(
            CREDS,
            {
                onMessage: () => {},
                onStatus: (s) => {
                    reported = s;
                },
            },
            factory,
        );
        await channel.connect(hello());
        duplex.emit('status', {
            code: 1,
            details: 'revoked',
            metadata: {},
        } as ServiceError);
        await new Promise((r) => setTimeout(r, 0));
        expect(reported?.code).toBe(1);
        channel.close();
    });
});

function historyFrame(entryBytes: number, count: number): PiToPhi {
    const entry = 'e'.repeat(entryBytes);
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: {
            $case: 'historyResponse',
            value: HistoryResponse.create({
                requestId: 'h',
                entries: Array.from({ length: count }, () => entry),
                unavailable: false,
            }),
        },
    };
}

const encodedSize = (msg: PiToPhi): number =>
    PiToPhi.encode(msg).finish().length;

/** Mock duplex stream: hello succeeds, later writes stay in flight. */
class HoldingDuplex extends EventEmitter {
    writes = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write(msg: any, cb?: () => void): boolean {
        void msg;
        this.writes += 1;
        if (this.writes === 1) {
            queueMicrotask(() => {
                cb?.();
                this.emit('data', {
                    payload: {
                        $case: 'accepted',
                        value: {
                            protocolVersion: 1,
                            capabilities: [],
                            runtimeGeneration: 1n,
                            runtimeId: 'rt',
                        },
                    },
                });
            });
            return true;
        }
        // Held in flight: the writer never settles, so the bytes
        // stay outstanding until the test ends.
        return true;
    }
    end(): void {}
    cancel(): void {}
}

async function connectedHoldingChannel(): Promise<BridgeChannel> {
    const duplex = new HoldingDuplex();
    const factory: ClientFactory = () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        connect: () => duplex as any,
        close: () => {},
    });
    const channel = new BridgeChannel(
        CREDS,
        { onMessage: () => {}, onStatus: () => {} },
        factory,
    );
    await channel.connect(hello());
    return channel;
}

describe('BridgeChannel history admission', () => {
    const CAP = MAX_QUEUED_BYTES - LIFECYCLE_HEADROOM_BYTES;

    it('admits a near-limit history frame first and still sends lifecycle', async () => {
        const channel = await connectedHoldingChannel();
        try {
            const big = historyFrame(2400, 100);
            const size = encodedSize(big);
            expect(size).toBeGreaterThan(200 * 1024);
            expect(size).toBeLessThan(CAP);
            expect(channel.sendHistory(big)).toBe(true);
            // The frame is held in flight; an edge plus a snapshot
            // must still enqueue without ending the stream.
            expect(channel.send(hello())).toBe(true);
            expect(channel.send(hello())).toBe(true);
        } finally {
            channel.close();
        }
    });

    it('reserves message slots as well as bytes for the next edge and snapshot', async () => {
        const channel = await connectedHoldingChannel();
        try {
            const tiny = historyFrame(1, 1);
            let admitted = 0;
            while (admitted < MAX_QUEUED_MESSAGES && channel.sendHistory(tiny))
                admitted++;
            expect(admitted).toBe(MAX_QUEUED_MESSAGES - 2);
            expect(channel.send(hello())).toBe(true);
            expect(channel.send(hello())).toBe(true);
        } finally {
            channel.close();
        }
    });

    it('lifecycle-first admission retains the reservation', async () => {
        const channel = await connectedHoldingChannel();
        try {
            const big = historyFrame(2400, 100);
            expect(channel.send(big)).toBe(true);
            // The queued lifecycle frame consumes most of the shared budget.
            expect(channel.sendHistory(historyFrame(100, 100))).toBe(false);
            expect(channel.send(hello())).toBe(true);
            expect(channel.sendHistory(historyFrame(1, 1))).toBe(true);
        } finally {
            channel.close();
        }
    });

    it('rejects past the reservation without poisoning the channel', async () => {
        const channel = await connectedHoldingChannel();
        try {
            const tooBig = historyFrame(2500, 100);
            const size = encodedSize(tooBig);
            // Fits the raw queue bound, but leaves no lifecycle headroom.
            expect(size).toBeGreaterThan(CAP);
            expect(size).toBeLessThan(MAX_QUEUED_BYTES);
            expect(channel.sendHistory(tooBig)).toBe(false);
            // Nonfatal: lifecycle and later history still send.
            expect(channel.send(hello())).toBe(true);
            expect(channel.sendHistory(historyFrame(8, 1))).toBe(true);
        } finally {
            channel.close();
        }
    });
});
