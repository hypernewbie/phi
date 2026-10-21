import { describe, expect, it } from 'vitest';
import type { ServiceError } from '@grpc/grpc-js';
import {
    type AgentSettled,
    LogicalState,
    type PiToPhi,
    RunOutcome,
} from './gen/bridge.js';
import { CAPABILITY_LIFECYCLE } from './protocol.js';
import { InvalidTargetError } from './endpoint.js';
import type { ChannelCreds, ChannelHooks } from './channel.js';
import { type PiContextView, Runtime, type RuntimeChannel } from './runtime.js';

const CREDS: ChannelCreds = {
    target: 'unix:/tmp/test.sock',
    pane: 'pane',
    process: 'proc',
    token: 'tok',
};

function ctx(over: Partial<PiContextView> = {}): PiContextView {
    return {
        sessionManager: { getSessionId: () => 'sess', getLeafId: () => 'leaf' },
        model: {
            provider: 'p',
            model: 'm',
            providerId: 'p',
            id: 'm',
        } as unknown as PiContextView['model'],
        ...over,
    };
}

interface MockChannel extends RuntimeChannel {
    hellos: PiToPhi[];
    sends: PiToPhi[];
    closed: number;
    hooks: ChannelHooks | null;
    sendResult: boolean;
    connectError: Error | null;
}

function mockChannel(): MockChannel {
    const m: MockChannel = {
        hellos: [],
        sends: [],
        closed: 0,
        hooks: null,
        sendResult: true,
        connectError: null,
        connect: async (hello: PiToPhi) => {
            m.hellos.push(hello);
            if (m.connectError) throw m.connectError;
            return {
                protocolVersion: 1,
                capabilities: [CAPABILITY_LIFECYCLE],
                runtimeGeneration: 1n,
                runtimeId: 'rt',
            };
        },
        send: (msg: PiToPhi) => {
            m.sends.push(msg);
            return m.sendResult;
        },
        close: () => {
            m.closed += 1;
        },
    };
    return m;
}

function wired(
    ch: MockChannel,
): (_c: ChannelCreds, hooks: ChannelHooks) => RuntimeChannel {
    return (_c, hooks) => {
        ch.hooks = hooks;
        return ch;
    };
}

function status(code: number): ServiceError {
    return { code, details: 'test', metadata: {} } as ServiceError;
}

function payloadOf(msg: PiToPhi): NonNullable<PiToPhi['payload']> {
    const payload = msg.payload;
    if (!payload) throw new Error('missing payload');
    return payload;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Runtime hello', () => {
    it('advertises lifecycle only with provisioned identity', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 3n,
            makeChannel: wired(ch),
        });
        rt.start(ctx());
        await sleep(10);
        expect(ch.hellos).toHaveLength(1);
        const hello = ch.hellos[0]!;
        expect(hello.paneId).toBe('pane');
        expect(hello.processId).toBe('proc');
        expect(hello.runtimeGeneration).toBe(3n);
        const payload = payloadOf(hello);
        expect(payload.$case).toBe('hello');
        if (payload.$case !== 'hello') return;
        expect(payload.value.capabilities).toEqual([CAPABILITY_LIFECYCLE]);
        expect(payload.value.sessionId).toBe('sess');
        expect(payload.value.currentState?.state).toBe(
            LogicalState.LOGICAL_STATE_IDLE,
        );
        expect(payload.value.currentState?.leafId).toBe('leaf');
        expect(payload.value.currentState?.model?.provider).toBe('p');
        rt.shutdown();
    });
});

describe('Runtime lifecycle mapping', () => {
    it('opens one run on first start and continues on extra starts', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            makeChannel: wired(ch),
        });
        rt.start(ctx());
        await sleep(10);
        rt.onAgentStart(ctx());
        rt.onAgentStart(ctx());
        const started = ch.sends.filter(
            (m) => payloadOf(m).$case === 'agentStarted',
        );
        expect(started).toHaveLength(2);
        const first = payloadOf(started[0]!);
        const second = payloadOf(started[1]!);
        if (first.$case !== 'agentStarted' || second.$case !== 'agentStarted')
            return;
        expect(first.value.runId).toBe(1n);
        expect(second.value.runId).toBe(1n);
        expect(second.value.eventSequence).toBe(first.value.eventSequence + 1n);
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snaps).toHaveLength(2);
        rt.shutdown();
    });

    it('settles the observed run and ignores idle settlements', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            makeChannel: wired(ch),
        });
        rt.start(ctx());
        await sleep(10);
        rt.onAgentSettled(ctx(), false);
        expect(ch.sends).toHaveLength(0);
        rt.onAgentStart(ctx());
        rt.onAgentEnd('stop');
        rt.onAgentSettled(ctx(), false);
        const settled = ch.sends.filter(
            (m) => payloadOf(m).$case === 'agentSettled',
        );
        expect(settled).toHaveLength(1);
        const payload = payloadOf(settled[0]!);
        if (payload.$case !== 'agentSettled') return;
        expect(payload.value.runId).toBe(1n);
        expect(payload.value.outcome).toBe(RunOutcome.RUN_OUTCOME_COMPLETED);
        // Duplicate settlement after completion is ignored.
        rt.onAgentSettled(ctx(), false);
        expect(
            ch.sends.filter((m) => payloadOf(m).$case === 'agentSettled'),
        ).toHaveLength(1);
        rt.shutdown();
    });

    it('maps abort to ABORTED and never reuses an old outcome', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            makeChannel: wired(ch),
        });
        rt.start(ctx());
        await sleep(10);
        rt.onAgentStart(ctx());
        rt.onAgentSettled(ctx(), true);
        rt.onAgentStart(ctx());
        rt.onAgentEnd('stop');
        rt.onAgentSettled(ctx(), false);
        const settled = ch.sends.filter(
            (m) => payloadOf(m).$case === 'agentSettled',
        );
        expect(settled).toHaveLength(2);
        const outcomes = settled.map((m) => {
            const p = payloadOf(m);
            return p.$case === 'agentSettled'
                ? (p.value as AgentSettled).outcome
                : undefined;
        });
        expect(outcomes).toEqual([
            RunOutcome.RUN_OUTCOME_ABORTED,
            RunOutcome.RUN_OUTCOME_COMPLETED,
        ]);
        rt.shutdown();
    });

    it('maps stop evidence to error and missing evidence to unknown', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            makeChannel: wired(ch),
        });
        const settledOutcomes = (): Array<RunOutcome | undefined> =>
            ch.sends
                .filter((m) => payloadOf(m).$case === 'agentSettled')
                .map((m) => {
                    const p = payloadOf(m);
                    return p.$case === 'agentSettled'
                        ? (p.value as AgentSettled).outcome
                        : undefined;
                });
        rt.start(ctx());
        await sleep(10);
        // Error evidence settles as error.
        rt.onAgentStart(ctx());
        rt.onAgentEnd('error');
        rt.onAgentSettled(ctx(), false);
        // Aborted evidence settles as aborted even without the flag.
        rt.onAgentStart(ctx());
        rt.onAgentEnd('aborted');
        rt.onAgentSettled(ctx(), false);
        // No evidence stays explicitly unknown, never a reused outcome.
        rt.onAgentStart(ctx());
        rt.onAgentSettled(ctx(), false);
        expect(settledOutcomes()).toEqual([
            RunOutcome.RUN_OUTCOME_ERROR,
            RunOutcome.RUN_OUTCOME_ABORTED,
            RunOutcome.RUN_OUTCOME_UNSPECIFIED,
        ]);
        rt.shutdown();
    });

    it('bounds the journal and reports the gap', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            makeChannel: wired(ch),
        });
        rt.start(ctx());
        await sleep(10);
        for (let i = 0; i < 40; i++) {
            rt.onAgentStart(ctx());
            rt.onAgentSettled(ctx(), false);
        }
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        const last = payloadOf(snaps[snaps.length - 1]!);
        if (last.$case !== 'stateSnapshot') return;
        expect(last.value.journal.length).toBe(64);
        expect(last.value.journalGap).toBe(true);
        expect(last.value.journal[0]!.eventSequence).toBe(17n);
        rt.shutdown();
    });
});

describe('Runtime snapshots', () => {
    it('publishes snapshots on identity events', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            makeChannel: wired(ch),
        });
        rt.start(ctx());
        await sleep(10);
        const before = ch.sends.length;
        rt.onModelSelect(ctx());
        rt.onSessionTree(ctx());
        rt.onCompactStart(ctx());
        rt.onCompactEnd(ctx());
        rt.onSessionStart(ctx());
        const snapshots = ch.sends
            .slice(before)
            .filter((m) => payloadOf(m).$case === 'stateSnapshot');
        // Model, tree, compaction end, and replacement session refresh
        // identities; compaction start only marks, never snapshots.
        expect(snapshots).toHaveLength(4);
        rt.shutdown();
    });
});

describe('Runtime reconnect', () => {
    it('retries retryable ends with the same generation and journal', async () => {
        const channels: MockChannel[] = [];
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            backoffBaseMs: 5,
            backoffMaxMs: 10,
            makeChannel: (_c, hooks) => {
                const ch = mockChannel();
                ch.hooks = hooks;
                channels.push(ch);
                return ch;
            },
        });
        rt.start(ctx());
        await sleep(10);
        rt.onAgentStart(ctx());
        channels[0]!.hooks!.onStatus(status(14));
        await sleep(30);
        expect(channels.length).toBe(2);
        const hello2 = payloadOf(channels[1]!.hellos[0]!);
        if (hello2.$case !== 'hello') return;
        expect(channels[1]!.hellos[0]!.runtimeGeneration).toBe(1n);
        expect(hello2.value.currentState?.journal.length).toBe(1);
        // Reconnect during a run reports running, never a stale idle.
        expect(hello2.value.currentState?.state).toBe(
            LogicalState.LOGICAL_STATE_RUNNING,
        );
        rt.shutdown();
    });

    it('stops on terminal statuses', async () => {
        for (const code of [16, 7, 9, 1]) {
            const channels: MockChannel[] = [];
            const rt = new Runtime({
                creds: CREDS,
                generation: 1n,
                backoffBaseMs: 5,
                backoffMaxMs: 10,
                makeChannel: (_c, hooks) => {
                    const ch = mockChannel();
                    ch.hooks = hooks;
                    channels.push(ch);
                    return ch;
                },
            });
            rt.start(ctx());
            await sleep(10);
            channels[0]!.hooks!.onStatus(status(code));
            await sleep(25);
            expect(channels.length, `code ${code}`).toBe(1);
            rt.shutdown();
        }
    });

    it('stops when the handshake itself is terminally rejected', async () => {
        for (const code of [16, 7, 9, 1]) {
            const channels: MockChannel[] = [];
            const rt = new Runtime({
                creds: CREDS,
                generation: 1n,
                backoffBaseMs: 5,
                backoffMaxMs: 10,
                makeChannel: (_c, hooks) => {
                    const ch = mockChannel();
                    ch.hooks = hooks;
                    ch.connectError = status(code);
                    channels.push(ch);
                    return ch;
                },
            });
            rt.start(ctx());
            await sleep(30);
            expect(channels.length, `code ${code}`).toBe(1);
            rt.shutdown();
        }
    });

    it('stops retrying when the target can never be valid', async () => {
        const channels: MockChannel[] = [];
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            backoffBaseMs: 5,
            backoffMaxMs: 10,
            makeChannel: (_c, hooks) => {
                const ch = mockChannel();
                ch.hooks = hooks;
                ch.connectError = new InvalidTargetError('bad target');
                channels.push(ch);
                return ch;
            },
        });
        rt.start(ctx());
        await sleep(30);
        expect(channels.length).toBe(1);
        rt.shutdown();
    });

    it('reconnects after queue overflow instead of gapping the stream', async () => {
        const channels: MockChannel[] = [];
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            backoffBaseMs: 5,
            backoffMaxMs: 10,
            makeChannel: (_c, hooks) => {
                const ch = mockChannel();
                ch.hooks = hooks;
                channels.push(ch);
                return ch;
            },
        });
        rt.start(ctx());
        await sleep(10);
        channels[0]!.sendResult = false;
        rt.onAgentStart(ctx());
        await sleep(30);
        expect(channels.length).toBe(2);
        rt.shutdown();
    });

    it('shutdown stops retries and ignores events', async () => {
        const channels: MockChannel[] = [];
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            backoffBaseMs: 5,
            backoffMaxMs: 10,
            makeChannel: (_c, hooks) => {
                const ch = mockChannel();
                ch.hooks = hooks;
                channels.push(ch);
                return ch;
            },
        });
        rt.start(ctx());
        await sleep(10);
        rt.shutdown();
        expect(channels[0]!.closed).toBe(1);
        channels[0]!.hooks!.onStatus(status(14));
        rt.onAgentStart(ctx());
        await sleep(25);
        expect(channels.length).toBe(1);
        expect(channels[0]!.sends).toHaveLength(0);
    });

    it('releases a stream that connects after shutdown', async () => {
        const channels: MockChannel[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            backoffBaseMs: 5,
            backoffMaxMs: 10,
            makeChannel: (_c, hooks) => {
                const ch = mockChannel();
                ch.hooks = hooks;
                const inner = ch.connect;
                ch.connect = async (hello) => {
                    await gate;
                    return inner(hello);
                };
                channels.push(ch);
                return ch;
            },
        });
        rt.start(ctx());
        await sleep(10);
        rt.shutdown();
        release();
        await sleep(25);
        // The late acceptance closes the channel instead of adopting
        // it, and no retry follows a shutdown: one close from the
        // shutdown path, one from the post-connect guard.
        expect(channels).toHaveLength(1);
        expect(channels[0]!.closed).toBe(2);
        expect(channels[0]!.hellos).toHaveLength(1);
    });

    it('maps aborted settlements from the 1.3.0 event shape', async () => {
        const { settledAborted } = await import('./extension.js');
        expect(settledAborted({ type: 'agent_settled', aborted: true })).toBe(
            true,
        );
        expect(settledAborted({ type: 'agent_settled' })).toBe(false);
        expect(settledAborted({ type: 'agent_settled', aborted: 1 })).toBe(
            false,
        );
        expect(settledAborted(null)).toBe(false);
    });
});
