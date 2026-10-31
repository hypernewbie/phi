import { describe, expect, it } from 'vitest';
import type { ServiceError } from '@grpc/grpc-js';
import {
    type AgentSettled,
    CompactOutcome,
    LogicalState,
    type PhiToPi,
    PiToPhi,
    ReloadDispatchOutcome,
    RunOutcome,
    type StateSnapshot,
} from './gen/bridge.js';
import { LIFECYCLE_HEADROOM_BYTES } from './protocol.js';
import { SHUTDOWN_DRAIN_MS } from './protocol.js';
import { CAPABILITY_COMPACT, CAPABILITY_CONTEXT } from './protocol.js';
import { CAPABILITY_RELOAD } from './protocol.js';
import { CAPABILITY_HISTORY, CAPABILITY_LIFECYCLE } from './protocol.js';
import { CAPABILITY_MODELS } from './protocol.js';
import { CAPABILITY_SKILLS } from './protocol.js';
import { CAPABILITY_THINKING } from './protocol.js';
import { MAX_MODELS_ENTRIES } from './protocol.js';
import { MAX_SKILL_ENTRIES } from './protocol.js';
import { MAX_SKILL_NAME_BYTES } from './protocol.js';
import { MAX_THINKING_LEVELS } from './protocol.js';
import { MAX_THINKING_LEVEL_BYTES } from './protocol.js';
import { MAX_THINKING_MODEL_ID_BYTES } from './protocol.js';
import { InvalidTargetError } from './endpoint.js';
import type { ChannelCreds, ChannelHooks } from './channel.js';
import {
    type CompactLatchState,
    type PiContextView,
    type PiThinkingLevel,
    Runtime,
    type RuntimeChannel,
    freshCompactLatch,
} from './runtime.js';
import {
    captureNativeReloadBaseline,
    freshReloadLatch,
    type ReloadLatchState,
} from './native-reload.js';
import type {
    PiModelView,
    PiRegistryView,
    PiScopedModelView,
} from './runtime.js';

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
    nonfatalSends: PiToPhi[];
    closed: number;
    drainCalls: number[];
    events: string[];
    hooks: ChannelHooks | null;
    sendResult: boolean;
    nonfatalResult: boolean;
    connectError: Error | null;
}

function mockChannel(): MockChannel {
    const m: MockChannel = {
        hellos: [],
        sends: [],
        nonfatalSends: [],
        closed: 0,
        drainCalls: [],
        events: [],
        hooks: null,
        sendResult: true,
        nonfatalResult: true,
        connectError: null,
        connect: async (hello: PiToPhi) => {
            m.hellos.push(hello);
            if (m.connectError) throw m.connectError;
            return {
                protocolVersion: 1,
                capabilities:
                    hello.payload?.$case === 'hello'
                        ? hello.payload.value.capabilities
                        : [],
                runtimeGeneration: 1n,
                runtimeId: 'rt',
            };
        },
        send: (msg: PiToPhi) => {
            m.sends.push(msg);
            return m.sendResult;
        },
        sendNonfatal: (msg: PiToPhi) => {
            m.nonfatalSends.push(msg);
            m.events.push(
                msg.payload?.$case === 'reloadAck' ? 'reload-ack' : 'send',
            );
            return m.nonfatalResult;
        },
        close: () => {
            m.closed += 1;
        },
        drainAndClose: (timeoutMs: number) => {
            // The mock has no async queue: sends land
            // synchronously, so the drain is instant and closes.
            m.drainCalls.push(timeoutMs);
            m.events.push('drain');
            m.closed += 1;
            return Promise.resolve();
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

function historyUi(history: unknown): unknown {
    return {
        setWidget: (
            _key: string,
            factory: ((tui: unknown, theme: unknown) => unknown) | undefined,
        ) => {
            if (factory !== undefined) {
                factory(
                    {
                        getFocusedComponent: () => ({ history }),
                    },
                    {},
                );
            }
        },
    };
}

function historyRequest(id: string): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: { $case: 'historyRequest', value: { requestId: id } },
    };
}

function responseOf(msg: PiToPhi): {
    requestId: string;
    entries: string[];
    unavailable: boolean;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'historyResponse') {
        throw new Error(`not a history response: ${payload.$case}`);
    }
    return payload.value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Runtime hello', () => {
    it('advertises lifecycle and models with provisioned identity', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 3n,
            compactState: freshCompactLatch(),
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
        expect(payload.value.capabilities).toEqual([
            CAPABILITY_LIFECYCLE,
            CAPABILITY_MODELS,
        ]);
        expect(payload.value.sessionId).toBe('sess');
        expect(payload.value.currentState?.state).toBe(
            LogicalState.LOGICAL_STATE_IDLE,
        );
        expect(payload.value.currentState?.leafId).toBe('leaf');
        expect(payload.value.currentState?.model?.provider).toBe('p');
        rt.shutdown();
    });
    it('advertises history only while the reader reaches an editor', async () => {
        const editorUi = {
            setWidget: (
                _key: string,
                factory:
                    | ((tui: unknown, theme: unknown) => unknown)
                    | undefined,
            ) => {
                if (factory !== undefined) {
                    factory(
                        {
                            getFocusedComponent: () => ({
                                history: ['a'],
                            }),
                        },
                        {},
                    );
                }
            },
        };
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        rt.start(ctx({ ui: editorUi }));
        await sleep(10);
        expect(ch.hellos).toHaveLength(1);
        const payload = payloadOf(ch.hellos[0]!);
        expect(payload.$case).toBe('hello');
        if (payload.$case !== 'hello') return;
        expect(payload.value.capabilities).toEqual([
            CAPABILITY_LIFECYCLE,
            CAPABILITY_MODELS,
            CAPABILITY_HISTORY,
        ]);
        rt.shutdown();
    });
    it('stays lifecycle-and-models when the reader is unavailable', async () => {
        const printUi = { setWidget: () => {} };
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        rt.start(ctx({ ui: printUi }));
        await sleep(10);
        expect(ch.hellos).toHaveLength(1);
        const payload = payloadOf(ch.hellos[0]!);
        expect(payload.$case).toBe('hello');
        if (payload.$case !== 'hello') return;
        expect(payload.value.capabilities).toEqual([
            CAPABILITY_LIFECYCLE,
            CAPABILITY_MODELS,
        ]);
        rt.shutdown();
    });
});

describe('Runtime models requests', () => {
    async function started(ui: unknown): Promise<{
        ch: MockChannel;
        rt: Runtime;
    }> {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        rt.start(ctx({ ui }));
        await sleep(10);
        return { ch, rt };
    }

    it('answers with the live entries and echoes the id', async () => {
        const { ch, rt } = await started(historyUi(['b', 'a']));
        ch.hooks!.onMessage(historyRequest('h7'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(responseOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 'h7',
            entries: ['b', 'a'],
            unavailable: false,
        });
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('answers unavailable when the reader cannot reach an editor', async () => {
        const { ch, rt } = await started(historyUi([]));
        rt.onModelSelect(ctx({ ui: undefined }));
        ch.hooks!.onMessage(historyRequest('h1'));
        expect(ch.nonfatalSends).toHaveLength(1);
        const res = responseOf(ch.nonfatalSends[0]!);
        expect(res.requestId).toBe('h1');
        expect(res.unavailable).toBe(true);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('answers unavailable when the snapshot exceeds the message bound', async () => {
        const big = 'x'.repeat(3000);
        const { ch, rt } = await started(
            historyUi(Array.from({ length: 100 }, () => big)),
        );
        ch.hooks!.onMessage(historyRequest('h9'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(responseOf(ch.nonfatalSends[0]!).unavailable).toBe(true);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('drops requests with an empty id', async () => {
        const { ch, rt } = await started(historyUi(['a']));
        ch.hooks!.onMessage(historyRequest(''));
        expect(ch.nonfatalSends).toHaveLength(0);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('fails only the request when admission misses', async () => {
        const { ch, rt } = await started(historyUi(['a']));
        ch.nonfatalResult = false;
        ch.hooks!.onMessage(historyRequest('h3'));
        // The snapshot missed, so the runtime answers unavailable
        // instead; both attempts fail here and the stream survives.
        expect(ch.nonfatalSends).toHaveLength(2);
        expect(responseOf(ch.nonfatalSends[1]!).unavailable).toBe(true);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it.each(['paneId', 'processId', 'runtimeGeneration'] as const)(
        'drops a request with the wrong %s',
        async (field) => {
            const { ch, rt } = await started(historyUi(['a']));
            const request = historyRequest('h1');
            if (field === 'runtimeGeneration') request[field] = 2n;
            else request[field] = 'wrong';
            ch.hooks!.onMessage(request);
            expect(ch.nonfatalSends).toHaveLength(0);
            rt.shutdown();
        },
    );

    it('drops requests when history was not negotiated', async () => {
        const { ch, rt } = await started(undefined);
        ch.hooks!.onMessage(historyRequest('h1'));
        expect(ch.nonfatalSends).toHaveLength(0);
        rt.shutdown();
    });

    it('ignores informational server messages', async () => {
        const { ch, rt } = await started(historyUi(['a']));
        ch.hooks!.onMessage({
            paneId: 'pane',
            processId: 'proc',
            runtimeGeneration: 1n,
            payload: {
                $case: 'protocolError',
                value: { code: 0, safeMessage: 'test' },
            },
        });
        expect(ch.nonfatalSends).toHaveLength(0);
        expect(ch.sends).toHaveLength(0);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });
});

function fakeModel(provider: string, id: string): PiModelView {
    return { provider, id } as unknown as PiModelView;
}

function thinkingModel(
    provider: string,
    id: string,
    reasoning: boolean,
    thinkingLevelMap?: Record<string, string | null>,
): PiModelView {
    return {
        provider,
        id,
        reasoning,
        thinkingLevelMap,
    } as unknown as PiModelView;
}

function fakeRegistry(
    entries: Array<{ provider: string; id: string }>,
): PiRegistryView {
    const models = entries.map((m) => fakeModel(m.provider, m.id));
    return {
        getAvailable: () => models,
        find: (provider: string, modelId: string) =>
            models.find((m) => m.provider === provider && m.id === modelId),
    };
}

function fakeScope(
    entries: Array<{ provider: string; id: string }>,
): PiScopedModelView[] {
    return entries.map((m) => ({ model: fakeModel(m.provider, m.id) }));
}

function modelsRequest(id: string): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: { $case: 'modelsRequest', value: { requestId: id } },
    };
}

function setModelRequest(id: string, provider: string, model: string): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: {
            $case: 'setModelRequest',
            value: { requestId: id, provider, model },
        },
    };
}

function thinkingLevelsRequest(id: string): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: { $case: 'thinkingLevelsRequest', value: { requestId: id } },
    };
}

function setThinkingRequest(
    id: string,
    level: string,
    provider = 'p',
    model = 'm',
): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: {
            $case: 'setThinkingRequest',
            value: { requestId: id, level, provider, model },
        },
    };
}

function thinkingLevelsOf(msg: PiToPhi): {
    requestId: string;
    levels: string[];
    provider: string;
    model: string;
    unavailable: boolean;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'thinkingLevelsResponse') {
        throw new Error(`not a thinking-level response: ${payload.$case}`);
    }
    return payload.value;
}

function thinkingAckOf(msg: PiToPhi): {
    requestId: string;
    ok: boolean;
    reason: string;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'setThinkingAck') {
        throw new Error(`not a set-thinking ack: ${payload.$case}`);
    }
    return payload.value;
}

function modelsOf(msg: PiToPhi): {
    requestId: string;
    models: Array<{ provider: string; model: string }>;
    truncated: boolean;
    unavailable: boolean;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'modelsResponse') {
        throw new Error(`not a models response: ${payload.$case}`);
    }
    return payload.value;
}

function ackOf(msg: PiToPhi): {
    requestId: string;
    ok: boolean;
    reason: string;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'setModelAck') {
        throw new Error(`not a set-model ack: ${payload.$case}`);
    }
    return payload.value;
}

describe('Runtime models requests', () => {
    async function started(
        registry?: PiRegistryView,
        scoped?: PiScopedModelView[],
    ): Promise<{ ch: MockChannel; rt: Runtime }> {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        rt.start(ctx({ modelRegistry: registry, scopedModels: scoped }));
        await sleep(10);
        return { ch, rt };
    }

    it('answers with the catalog and echoes the id', async () => {
        const { ch, rt } = await started(
            fakeRegistry([
                { provider: 'a', id: 'x' },
                { provider: 'b', id: 'y' },
            ]),
        );
        ch.hooks!.onMessage(modelsRequest('m7'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(modelsOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 'm7',
            models: [
                { provider: 'a', model: 'x' },
                { provider: 'b', model: 'y' },
            ],
            truncated: false,
            unavailable: false,
        });
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('answers unavailable when the host registry throws', async () => {
        const { ch, rt } = await started({
            getAvailable: () => {
                throw new Error('boom');
            },
            find: () => undefined,
        });
        ch.hooks!.onMessage(modelsRequest('m-throw'));
        expect(ch.nonfatalSends).toHaveLength(1);
        const res = modelsOf(ch.nonfatalSends[0]!);
        expect(res.requestId).toBe('m-throw');
        expect(res.unavailable).toBe(true);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('filters to the session scope when scoping is set', async () => {
        const { ch, rt } = await started(
            fakeRegistry([
                { provider: 'a', id: 'x' },
                { provider: 'b', id: 'y' },
            ]),
            fakeScope([{ provider: 'b', id: 'y' }]),
        );
        ch.hooks!.onMessage(modelsRequest('m1'));
        expect(ch.nonfatalSends).toHaveLength(1);
        const res = modelsOf(ch.nonfatalSends[0]!);
        expect(res.models).toEqual([{ provider: 'b', model: 'y' }]);
        expect(res.truncated).toBe(false);
        expect(res.unavailable).toBe(false);
        rt.shutdown();
    });

    it('truncates at the entry cap', async () => {
        const entries = Array.from(
            { length: MAX_MODELS_ENTRIES + 100 },
            (_, i) => ({
                provider: 'p',
                id: `m${i}`,
            }),
        );
        const { ch, rt } = await started(fakeRegistry(entries));
        ch.hooks!.onMessage(modelsRequest('m9'));
        expect(ch.nonfatalSends).toHaveLength(1);
        const res = modelsOf(ch.nonfatalSends[0]!);
        expect(res.models).toHaveLength(MAX_MODELS_ENTRIES);
        expect(res.truncated).toBe(true);
        expect(res.unavailable).toBe(false);
        rt.shutdown();
    });

    it('answers unavailable without a registry', async () => {
        const { ch, rt } = await started(undefined);
        ch.hooks!.onMessage(modelsRequest('m1'));
        expect(ch.nonfatalSends).toHaveLength(1);
        const res = modelsOf(ch.nonfatalSends[0]!);
        expect(res.requestId).toBe('m1');
        expect(res.unavailable).toBe(true);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('answers unavailable when the list exceeds the message bound', async () => {
        const big = 'x'.repeat(600);
        const entries = Array.from({ length: MAX_MODELS_ENTRIES }, (_, i) => ({
            provider: `p${i}-${big}`,
            id: `m${i}-${big}`,
        }));
        const { ch, rt } = await started(fakeRegistry(entries));
        ch.hooks!.onMessage(modelsRequest('m2'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(modelsOf(ch.nonfatalSends[0]!).unavailable).toBe(true);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('drops requests with an empty id', async () => {
        const { ch, rt } = await started(
            fakeRegistry([{ provider: 'a', id: 'x' }]),
        );
        ch.hooks!.onMessage(modelsRequest(''));
        expect(ch.nonfatalSends).toHaveLength(0);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it.each(['paneId', 'processId', 'runtimeGeneration'] as const)(
        'drops a request with the wrong %s',
        async (field) => {
            const { ch, rt } = await started(
                fakeRegistry([{ provider: 'a', id: 'x' }]),
            );
            const request = modelsRequest('m1');
            if (field === 'runtimeGeneration') request[field] = 2n;
            else request[field] = 'wrong';
            ch.hooks!.onMessage(request);
            expect(ch.nonfatalSends).toHaveLength(0);
            rt.shutdown();
        },
    );

    it('drops requests when models were not negotiated', async () => {
        const ch = mockChannel();
        ch.connect = async (hello: PiToPhi) => {
            ch.hellos.push(hello);
            return {
                protocolVersion: 1,
                capabilities: [CAPABILITY_LIFECYCLE],
                runtimeGeneration: 1n,
                runtimeId: 'rt',
            };
        };
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        rt.start(
            ctx({ modelRegistry: fakeRegistry([{ provider: 'a', id: 'x' }]) }),
        );
        await sleep(10);
        ch.hooks!.onMessage(modelsRequest('m1'));
        expect(ch.nonfatalSends).toHaveLength(0);
        rt.shutdown();
    });

    it('fails only the request when admission misses', async () => {
        const { ch, rt } = await started(
            fakeRegistry([{ provider: 'a', id: 'x' }]),
        );
        ch.nonfatalResult = false;
        ch.hooks!.onMessage(modelsRequest('m3'));
        expect(ch.nonfatalSends).toHaveLength(2);
        expect(modelsOf(ch.nonfatalSends[1]!).unavailable).toBe(true);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });
});

describe('Runtime set-model requests', () => {
    async function started(
        registry: PiRegistryView | undefined,
        setModel: (model: PiModelView) => Promise<boolean>,
        scoped?: PiScopedModelView[],
    ): Promise<{ ch: MockChannel; rt: Runtime }> {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
            setModel,
        });
        rt.start(ctx({ modelRegistry: registry, scopedModels: scoped }));
        await sleep(10);
        return { ch, rt };
    }

    it('acks ok and switches through the host on a known entry', async () => {
        const seen: PiModelView[] = [];
        const { ch, rt } = await started(
            fakeRegistry([{ provider: 'a', id: 'x' }]),
            async (m) => {
                seen.push(m);
                return true;
            },
        );
        ch.hooks!.onMessage(setModelRequest('s1', 'a', 'x'));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(ackOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 's1',
            ok: true,
            reason: '',
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.provider).toBe('a');
        expect(seen[0]!.id).toBe('x');
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('acks unknown-model when the registry misses', async () => {
        let calls = 0;
        const { ch, rt } = await started(
            fakeRegistry([{ provider: 'a', id: 'x' }]),
            async () => {
                calls += 1;
                return true;
            },
        );
        ch.hooks!.onMessage(setModelRequest('s2', 'a', 'zzz'));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(ackOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 's2',
            ok: false,
            reason: 'unknown-model',
        });
        expect(calls).toBe(0);
        rt.shutdown();
    });

    it('acks unknown-model when the host registry throws', async () => {
        let calls = 0;
        const { ch, rt } = await started(
            {
                getAvailable: () => [],
                find: () => {
                    throw new Error('boom');
                },
            },
            async () => {
                calls += 1;
                return true;
            },
        );
        ch.hooks!.onMessage(setModelRequest('s-throw', 'a', 'x'));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(ackOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 's-throw',
            ok: false,
            reason: 'unknown-model',
        });
        expect(calls).toBe(0);
        rt.shutdown();
    });

    it('acks unknown-model for out-of-scope entries', async () => {
        let calls = 0;
        const { ch, rt } = await started(
            fakeRegistry([
                { provider: 'a', id: 'x' },
                { provider: 'b', id: 'y' },
            ]),
            async () => {
                calls += 1;
                return true;
            },
            fakeScope([{ provider: 'a', id: 'x' }]),
        );
        ch.hooks!.onMessage(setModelRequest('s3', 'b', 'y'));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(ackOf(ch.nonfatalSends[0]!).reason).toBe('unknown-model');
        expect(calls).toBe(0);
        rt.shutdown();
    });

    it('acks no-auth when the host refuses', async () => {
        const { ch, rt } = await started(
            fakeRegistry([{ provider: 'a', id: 'x' }]),
            async () => false,
        );
        ch.hooks!.onMessage(setModelRequest('s4', 'a', 'x'));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(ackOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 's4',
            ok: false,
            reason: 'no-auth',
        });
        rt.shutdown();
    });

    it('acks empty reason when the host throws', async () => {
        const { ch, rt } = await started(
            fakeRegistry([{ provider: 'a', id: 'x' }]),
            async () => {
                throw new Error('boom');
            },
        );
        ch.hooks!.onMessage(setModelRequest('s5', 'a', 'x'));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(ackOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 's5',
            ok: false,
            reason: '',
        });
        rt.shutdown();
    });

    it('acks unknown-model on empty ids', async () => {
        const { ch, rt } = await started(
            fakeRegistry([{ provider: 'a', id: 'x' }]),
            async () => true,
        );
        ch.hooks!.onMessage(setModelRequest('s6', '', ''));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(ackOf(ch.nonfatalSends[0]!).reason).toBe('unknown-model');
        rt.shutdown();
    });

    it('drops requests with an empty id', async () => {
        const { ch, rt } = await started(
            fakeRegistry([{ provider: 'a', id: 'x' }]),
            async () => true,
        );
        ch.hooks!.onMessage(setModelRequest('', 'a', 'x'));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(0);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('drops requests when models were not negotiated', async () => {
        const ch = mockChannel();
        ch.connect = async (hello: PiToPhi) => {
            ch.hellos.push(hello);
            return {
                protocolVersion: 1,
                capabilities: [CAPABILITY_LIFECYCLE],
                runtimeGeneration: 1n,
                runtimeId: 'rt',
            };
        };
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
            setModel: async () => true,
        });
        rt.start(
            ctx({ modelRegistry: fakeRegistry([{ provider: 'a', id: 'x' }]) }),
        );
        await sleep(10);
        ch.hooks!.onMessage(setModelRequest('s7', 'a', 'x'));
        await sleep(10);
        expect(ch.nonfatalSends).toHaveLength(0);
        rt.shutdown();
    });
});

describe('Runtime Thinking requests', () => {
    async function started(
        model: PiModelView | undefined,
        options: {
            initialLevel?: PiThinkingLevel;
            setLevel?: (level: PiThinkingLevel) => void;
            omitSetter?: boolean;
        } = {},
    ): Promise<{
        ch: MockChannel;
        rt: Runtime;
        level: () => PiThinkingLevel;
        setNativeLevel: (level: PiThinkingLevel) => void;
        setCalls: PiThinkingLevel[];
    }> {
        const ch = mockChannel();
        const setCalls: PiThinkingLevel[] = [];
        let level = options.initialLevel ?? 'medium';
        const runtimeOptions = {
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
            getThinkingLevel: () => level,
            ...(options.omitSetter
                ? {}
                : {
                      setThinkingLevel: (next: PiThinkingLevel) => {
                          setCalls.push(next);
                          if (options.setLevel) options.setLevel(next);
                          else level = next;
                      },
                  }),
        };
        const rt = new Runtime(runtimeOptions);
        rt.start(ctx({ model }));
        await sleep(10);
        return {
            ch,
            rt,
            level: () => level,
            setNativeLevel: (next) => {
                level = next;
            },
            setCalls,
        };
    }

    it('advertises the capability and reports exact helper-supported levels', async () => {
        const model = thinkingModel('p', 'm', true, {
            xhigh: 'xhigh-native',
            max: 'max-native',
        });
        const { ch, rt } = await started(model);
        const hello = payloadOf(ch.hellos[0]!);
        if (hello.$case !== 'hello') throw new Error('missing hello');
        expect(hello.value.capabilities).toContain(CAPABILITY_THINKING);
        expect(hello.value.currentState?.thinkingLevel).toBe('medium');
        ch.hooks!.onMessage(thinkingLevelsRequest('t1'));
        expect(thinkingLevelsOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 't1',
            levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
            provider: 'p',
            model: 'm',
            unavailable: false,
        });
        expect(
            thinkingLevelsOf(ch.nonfatalSends[0]!).levels.length,
        ).toBeLessThanOrEqual(MAX_THINKING_LEVELS);
        rt.shutdown();
    });

    it('preserves off-only models and helper exclusions including xhigh and max', async () => {
        const offOnly = await started(thinkingModel('p', 'off', false));
        offOnly.ch.hooks!.onMessage(thinkingLevelsRequest('t-off'));
        expect(thinkingLevelsOf(offOnly.ch.nonfatalSends[0]!).levels).toEqual([
            'off',
        ]);
        offOnly.rt.shutdown();

        const excluded = await started(
            thinkingModel('p', 'excluded', true, {
                low: null,
                xhigh: 'xhigh-native',
                max: 'max-native',
            }),
        );
        excluded.ch.hooks!.onMessage(thinkingLevelsRequest('t-excluded'));
        expect(thinkingLevelsOf(excluded.ch.nonfatalSends[0]!).levels).toEqual([
            'off',
            'minimal',
            'medium',
            'high',
            'xhigh',
            'max',
        ]);
        excluded.rt.shutdown();
    });

    it('returns unavailable for missing models and failed helper reads', async () => {
        const missing = await started(undefined);
        const hello = payloadOf(missing.ch.hellos[0]!);
        if (hello.$case !== 'hello') throw new Error('missing hello');
        expect(hello.value.currentState?.thinkingLevel).toBe('');
        missing.ch.hooks!.onMessage(thinkingLevelsRequest('t-missing'));
        expect(thinkingLevelsOf(missing.ch.nonfatalSends[0]!)).toEqual({
            requestId: 't-missing',
            levels: [],
            provider: '',
            model: '',
            unavailable: true,
        });
        missing.rt.shutdown();

        const broken = Object.defineProperty(
            { provider: 'p', id: 'broken' },
            'reasoning',
            {
                get: () => {
                    throw new Error('helper read failed');
                },
            },
        ) as PiModelView;
        const failed = await started(broken);
        failed.ch.hooks!.onMessage(thinkingLevelsRequest('t-failed'));
        expect(thinkingLevelsOf(failed.ch.nonfatalSends[0]!)).toMatchObject({
            provider: 'p',
            model: 'broken',
            unavailable: true,
        });
        failed.ch.hooks!.onMessage(
            setThinkingRequest('t-fail-set', 'high', 'p', 'broken'),
        );
        expect(thinkingAckOf(failed.ch.nonfatalSends[1]!)).toEqual({
            requestId: 't-fail-set',
            ok: false,
            reason: '',
        });
        expect(failed.setCalls).toEqual([]);
        failed.rt.shutdown();

        const oversized = await started(
            thinkingModel(
                'p'.repeat(MAX_THINKING_MODEL_ID_BYTES + 1),
                'm',
                true,
            ),
        );
        oversized.ch.hooks!.onMessage(thinkingLevelsRequest('t-oversized'));
        expect(thinkingLevelsOf(oversized.ch.nonfatalSends[0]!)).toMatchObject({
            levels: [],
            provider: '',
            model: '',
            unavailable: true,
        });
        oversized.rt.shutdown();
    });

    it('sets only a supported level on the matching live model and acks readback', async () => {
        const { ch, rt, level, setCalls } = await started(
            thinkingModel('p', 'm', true),
        );
        ch.hooks!.onMessage(setThinkingRequest('t-set', 'high'));
        expect(thinkingAckOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 't-set',
            ok: true,
            reason: '',
        });
        expect(level()).toBe('high');
        expect(setCalls).toEqual(['high']);

        // Same-level setters need no thinking_level_select event to succeed.
        ch.hooks!.onMessage(setThinkingRequest('t-same', 'high'));
        expect(thinkingAckOf(ch.nonfatalSends[1]!)).toEqual({
            requestId: 't-same',
            ok: true,
            reason: '',
        });
        rt.shutdown();

        const mismatch = await started(thinkingModel('p', 'm', true), {
            setLevel: () => {},
        });
        mismatch.ch.hooks!.onMessage(setThinkingRequest('t-readback', 'high'));
        expect(thinkingAckOf(mismatch.ch.nonfatalSends[0]!)).toEqual({
            requestId: 't-readback',
            ok: false,
            reason: '',
        });
        expect(mismatch.level()).toBe('medium');
        mismatch.rt.shutdown();
    });

    it('rejects changed models and unsupported or oversized levels without mutation', async () => {
        const { ch, rt, setCalls } = await started(
            thinkingModel('p', 'm', true),
        );
        ch.hooks!.onMessage(
            setThinkingRequest('t-model', 'high', 'p', 'other'),
        );
        expect(thinkingAckOf(ch.nonfatalSends[0]!).reason).toBe(
            'model-changed',
        );
        ch.hooks!.onMessage(setThinkingRequest('t-level', 'max'));
        expect(thinkingAckOf(ch.nonfatalSends[1]!).reason).toBe(
            'unsupported-level',
        );
        ch.hooks!.onMessage(
            setThinkingRequest(
                't-long',
                'x'.repeat(MAX_THINKING_LEVEL_BYTES + 1),
            ),
        );
        expect(thinkingAckOf(ch.nonfatalSends[2]!).reason).toBe(
            'unsupported-level',
        );
        ch.hooks!.onMessage(
            setThinkingRequest(
                't-long-model',
                'high',
                'p'.repeat(MAX_THINKING_MODEL_ID_BYTES + 1),
                'm',
            ),
        );
        expect(thinkingAckOf(ch.nonfatalSends[3]!).reason).toBe(
            'model-changed',
        );
        expect(setCalls).toEqual([]);
        rt.shutdown();
    });

    it('rechecks live supported levels immediately before setting', async () => {
        let reads = 0;
        const changing = Object.defineProperty(
            {
                provider: 'p',
                id: 'm',
                thinkingLevelMap: { xhigh: 'x', max: 'm' },
            },
            'reasoning',
            { get: () => ++reads < 3 },
        ) as PiModelView;
        const { ch, rt, setCalls } = await started(changing);
        ch.hooks!.onMessage(setThinkingRequest('t-race', 'high'));
        expect(thinkingAckOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 't-race',
            ok: false,
            reason: 'unsupported-level',
        });
        expect(setCalls).toEqual([]);
        rt.shutdown();
    });

    it('does not advertise or handle the capability without both host methods', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            compactState: freshCompactLatch(),
            creds: CREDS,
            generation: 1n,
            getThinkingLevel: () => 'medium',
            makeChannel: wired(ch),
        });
        rt.start(ctx({ model: thinkingModel('p', 'm', true) }));
        await sleep(10);
        const hello = payloadOf(ch.hellos[0]!);
        if (hello.$case !== 'hello') throw new Error('missing hello');
        expect(hello.value.capabilities).not.toContain(CAPABILITY_THINKING);
        ch.hooks!.onMessage(thinkingLevelsRequest('t-unnegotiated'));
        expect(ch.nonfatalSends).toEqual([]);
        rt.shutdown();
    });

    it('publishes native changes using the effective readback', async () => {
        const model = thinkingModel('p', 'm', true);
        const { ch, rt, setNativeLevel } = await started(model);
        // A native terminal event reads back its effective level into the snapshot.
        setNativeLevel('high');
        rt.onThinkingLevelSelect(ctx({ model }));
        const snapshot = ch.sends.at(-1)!.payload;
        if (snapshot?.$case !== 'stateSnapshot')
            throw new Error('missing snapshot');
        expect(snapshot.value.thinkingLevel).toBe('high');
        rt.shutdown();
    });
});

describe('Runtime lifecycle headroom', () => {
    it('keeps even a full-journal snapshot under the headroom', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        const long = 's'.repeat(128);
        const big = () =>
            ctx({
                sessionManager: {
                    getSessionId: () => long,
                    getLeafId: () => long,
                },
                model: {
                    provider: long,
                    model: long,
                    providerId: long,
                    id: long,
                } as unknown as PiContextView['model'],
            });
        rt.start(big());
        await sleep(10);
        for (let i = 0; i < 70; i++) rt.onAgentStart(big());
        const snapshots = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshots.length).toBeGreaterThan(0);
        const last = payloadOf(snapshots[snapshots.length - 1]!);
        if (last.$case !== 'stateSnapshot') throw new Error('unreachable');
        // Full journal plus gap: the largest snapshot this runtime emits.
        expect(last.value.journal).toHaveLength(64);
        expect(last.value.journalGap).toBe(true);
        let max = 0;
        for (const m of [...ch.sends, ...ch.hellos]) {
            max = Math.max(max, PiToPhi.encode(m).finish().length);
        }
        expect(max).toBeLessThan(LIFECYCLE_HEADROOM_BYTES);
        rt.shutdown();
    });
});

describe('Runtime lifecycle mapping', () => {
    it('opens one run on first start and continues on extra starts', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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

    it.each([null, 1, 14])(
        'ignores stale channel callbacks after reconnect (status %s)',
        async (code) => {
            const channels: MockChannel[] = [];
            const rt = new Runtime({
                creds: CREDS,
                generation: 1n,
                compactState: freshCompactLatch(),
                backoffBaseMs: 5,
                backoffMaxMs: 10,
                makeChannel: (_c, hooks) => {
                    const ch = mockChannel();
                    ch.hooks = hooks;
                    channels.push(ch);
                    return ch;
                },
            });
            try {
                rt.start(ctx({ ui: historyUi(['current']) }));
                await sleep(10);
                const old = channels[0]!;
                old.hooks!.onStatus(status(14));
                await sleep(30);
                expect(channels).toHaveLength(2);
                const current = channels[1]!;
                old.hooks!.onMessage(historyRequest('stale'));
                old.hooks!.onStatus(code === null ? null : status(code));
                expect(current.closed).toBe(0);
                expect(old.nonfatalSends).toHaveLength(0);
                current.hooks!.onMessage(historyRequest('current'));
                expect(current.nonfatalSends).toHaveLength(1);
                expect(responseOf(current.nonfatalSends[0]!).entries).toEqual([
                    'current',
                ]);
            } finally {
                rt.shutdown();
            }
        },
    );

    it('stops on terminal statuses', async () => {
        for (const code of [16, 7, 9, 1]) {
            const channels: MockChannel[] = [];
            const rt = new Runtime({
                creds: CREDS,
                generation: 1n,
                compactState: freshCompactLatch(),
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
                compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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
            compactState: freshCompactLatch(),
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

    it('shutdown drains queued lifecycle frames instead of dropping them', async () => {
        const { ch, rt } = await startedWith(telemetryCtx());
        rt.onAgentStart(telemetryCtx());
        rt.onAgentSettled(telemetryCtx(), false);
        const sendsBefore = ch.sends.length;
        expect(sendsBefore).toBeGreaterThan(0);
        rt.shutdown();
        // Bounded drain requested with the shutdown budget; the
        // runtime detaches immediately so no later event can send.
        expect(ch.drainCalls).toEqual([SHUTDOWN_DRAIN_MS]);
        rt.onAgentStart(telemetryCtx());
        expect(ch.sends.length).toBe(sendsBefore);
        // Idempotent: a second shutdown requests no second drain.
        rt.shutdown();
        expect(ch.drainCalls).toHaveLength(1);
    });

    it('releases a stream that connects after shutdown', async () => {
        const channels: MockChannel[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
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

function telemetryCtx(over: Partial<PiContextView> = {}): PiContextView {
    return ctx({
        getContextUsage: () => ({
            tokens: 1010,
            contextWindow: 8192,
            percent: 12.3291015625,
        }),
        isIdle: () => true,
        hasPendingMessages: () => false,
        compact: () => {},
        ...over,
    });
}

function snapshotOf(msg: PiToPhi): StateSnapshot {
    const payload = payloadOf(msg);
    if (payload.$case !== 'stateSnapshot') {
        throw new Error(`not a snapshot: ${payload.$case}`);
    }
    return payload.value;
}

async function startedWith(
    view: PiContextView,
    latch?: CompactLatchState,
): Promise<{ ch: MockChannel; rt: Runtime; latch: CompactLatchState }> {
    const ch = mockChannel();
    const l = latch ?? freshCompactLatch();
    const rt = new Runtime({
        creds: CREDS,
        generation: 1n,
        compactState: l,
        makeChannel: wired(ch),
    });
    rt.start(view);
    await sleep(10);
    return { ch, rt, latch: l };
}

function helloCaps(ch: MockChannel): string[] {
    const payload = payloadOf(ch.hellos[0]!);
    if (payload.$case !== 'hello') throw new Error('not a hello');
    return payload.value.capabilities;
}

function helloSnapshot(ch: MockChannel): ReturnType<typeof snapshotOf> {
    const payload = payloadOf(ch.hellos[0]!);
    if (payload.$case !== 'hello' || !payload.value.currentState) {
        throw new Error('hello without a baseline');
    }
    return payload.value.currentState;
}

describe('Runtime context telemetry', () => {
    it('advertises pi.context.v1 only with getContextUsage', async () => {
        const { ch, rt } = await startedWith(
            ctx({ getContextUsage: () => undefined }),
        );
        expect(helloCaps(ch)).toEqual([
            CAPABILITY_LIFECYCLE,
            CAPABILITY_MODELS,
            CAPABILITY_CONTEXT,
        ]);
        // Undefined sampling: no measurement, but the API exists.
        expect(helloSnapshot(ch).contextUsage).toBeUndefined();
        expect(helloSnapshot(ch).compactReadiness).toBeUndefined();
        rt.shutdown();
    });

    it('advertises pi.compact.v1 only with the full trio', async () => {
        const { ch, rt } = await startedWith(
            ctx({
                isIdle: () => true,
                hasPendingMessages: () => false,
                compact: () => {},
            }),
        );
        expect(helloCaps(ch)).toEqual([
            CAPABILITY_LIFECYCLE,
            CAPABILITY_MODELS,
            CAPABILITY_COMPACT,
        ]);
        const snap = helloSnapshot(ch);
        expect(snap.contextUsage).toBeUndefined();
        expect(snap.compactReadiness).toEqual({
            idle: true,
            hasPendingMessages: false,
            compactionActive: false,
            bridgePending: false,
        });
        rt.shutdown();
    });

    it.each(['compact', 'isIdle', 'hasPendingMessages'] as const)(
        'withholds pi.compact.v1 when %s is missing',
        async (missing) => {
            const trio = {
                isIdle: () => true,
                hasPendingMessages: () => false,
                compact: () => {},
            };
            delete trio[missing];
            const { ch, rt } = await startedWith(ctx(trio));
            expect(helloCaps(ch)).not.toContain(CAPABILITY_COMPACT);
            expect(helloSnapshot(ch).compactReadiness).toBeUndefined();
            rt.shutdown();
        },
    );

    it('omits telemetry without the optional APIs', async () => {
        const { ch, rt } = await startedWith(ctx());
        expect(helloCaps(ch)).toEqual([
            CAPABILITY_LIFECYCLE,
            CAPABILITY_MODELS,
        ]);
        expect(helloSnapshot(ch).contextUsage).toBeUndefined();
        expect(helloSnapshot(ch).compactReadiness).toBeUndefined();
        // No context-only traffic on hosts without telemetry APIs.
        rt.onAgentStart(ctx());
        rt.onAgentEnd('stop');
        expect(ch.nonfatalSends).toHaveLength(0);
        rt.shutdown();
    });

    it('publishes known usage in the baseline and transitions', async () => {
        const { ch, rt } = await startedWith(telemetryCtx());
        expect(helloSnapshot(ch).contextUsage).toEqual({
            tokens: 1010,
            contextWindow: 8192,
            percent: 12.3291015625,
        });
        rt.onModelSelect(telemetryCtx());
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snaps).toHaveLength(1);
        expect(snapshotOf(snaps[0]!).contextUsage).toEqual({
            tokens: 1010,
            contextWindow: 8192,
            percent: 12.3291015625,
        });
        rt.shutdown();
    });

    it('keeps zero tokens present: unknown is not zero', async () => {
        const { ch, rt } = await startedWith(
            telemetryCtx({
                getContextUsage: () => ({
                    tokens: 0,
                    contextWindow: 8192,
                    percent: 0,
                }),
            }),
        );
        expect(helloSnapshot(ch).contextUsage).toEqual({
            tokens: 0,
            contextWindow: 8192,
            percent: 0,
        });
        rt.shutdown();
    });

    it('keeps the window when tokens are unknown', async () => {
        const { ch, rt } = await startedWith(
            telemetryCtx({
                getContextUsage: () => ({
                    tokens: null,
                    contextWindow: 8192,
                    percent: null,
                }),
            }),
        );
        const usage = helloSnapshot(ch).contextUsage!;
        expect(usage.tokens).toBeUndefined();
        expect(usage.contextWindow).toBe(8192);
        expect(usage.percent).toBeUndefined();
        rt.shutdown();
    });

    it('omits percent when tokens are unknown but the host reports one', async () => {
        const { ch, rt } = await startedWith(
            telemetryCtx({
                getContextUsage: () => ({
                    tokens: null,
                    contextWindow: 8192,
                    percent: 50,
                }),
            }),
        );
        const usage = helloSnapshot(ch).contextUsage!;
        expect(usage.tokens).toBeUndefined();
        expect(usage.contextWindow).toBe(8192);
        expect(usage.percent).toBeUndefined();
        rt.shutdown();
    });

    it('clears the measurement on undefined sampling', async () => {
        const view = telemetryCtx();
        const { ch, rt } = await startedWith(view);
        expect(helloSnapshot(ch).contextUsage?.tokens).toBe(1010);
        rt.onModelSelect(telemetryCtx({ getContextUsage: () => undefined }));
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshotOf(snaps[0]!).contextUsage).toBeUndefined();
        // A later known sampling establishes a new measurement.
        rt.onModelSelect(view);
        const snaps2 = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshotOf(snaps2[1]!).contextUsage?.tokens).toBe(1010);
        rt.shutdown();
    });

    it.each([
        ['NaN tokens', { tokens: NaN, contextWindow: 8192, percent: 1 }],
        ['negative tokens', { tokens: -5, contextWindow: 8192, percent: 1 }],
        [
            'infinite tokens',
            { tokens: Infinity, contextWindow: 8192, percent: 1 },
        ],
        ['unsafe tokens', { tokens: 2 ** 60, contextWindow: 8192, percent: 1 }],
        ['string tokens', { tokens: '1010', contextWindow: 8192, percent: 1 }],
        ['zero window', { tokens: 10, contextWindow: 0, percent: 1 }],
        ['negative window', { tokens: 10, contextWindow: -8, percent: 1 }],
        ['negative percent', { tokens: 10, contextWindow: 8192, percent: -1 }],
        ['NaN percent', { tokens: 10, contextWindow: 8192, percent: NaN }],
    ])('clears the measurement on invalid sampling: %s', async (_name, bad) => {
        const { ch, rt } = await startedWith(telemetryCtx());
        expect(helloSnapshot(ch).contextUsage?.tokens).toBe(1010);
        rt.onModelSelect(
            telemetryCtx({
                getContextUsage: () =>
                    bad as unknown as {
                        tokens: number;
                        contextWindow: number;
                        percent: number;
                    },
            }),
        );
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshotOf(snaps[0]!).contextUsage).toBeUndefined();
        rt.shutdown();
    });

    it.each([[null], ['oops'], [42]])(
        'clears the measurement on non-object sampling: %s',
        async (bad) => {
            const { ch, rt } = await startedWith(telemetryCtx());
            rt.onModelSelect(
                telemetryCtx({
                    getContextUsage: () =>
                        bad as unknown as {
                            tokens: number;
                            contextWindow: number;
                            percent: number;
                        },
                }),
            );
            const snaps = ch.sends.filter(
                (m) => payloadOf(m).$case === 'stateSnapshot',
            );
            expect(snapshotOf(snaps[0]!).contextUsage).toBeUndefined();
            rt.shutdown();
        },
    );

    it('survives a throwing getContextUsage and recovers', async () => {
        const { ch, rt } = await startedWith(
            telemetryCtx({
                getContextUsage: () => {
                    throw new Error('boom');
                },
            }),
        );
        expect(helloSnapshot(ch).contextUsage).toBeUndefined();
        // Lifecycle keeps working through the throwing API.
        rt.onAgentStart(telemetryCtx());
        rt.onAgentEnd('stop');
        rt.onAgentSettled(telemetryCtx(), false);
        expect(
            ch.sends.filter((m) => payloadOf(m).$case === 'agentSettled'),
        ).toHaveLength(1);
        // Recovery on the next good sample.
        rt.onModelSelect(telemetryCtx());
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        const last = snapshotOf(snaps[snaps.length - 1]!);
        expect(last.contextUsage?.tokens).toBe(1010);
        rt.shutdown();
    });

    it('fails readiness closed when the trio throws', async () => {
        const { ch, rt } = await startedWith(
            telemetryCtx({
                isIdle: () => {
                    throw new Error('boom');
                },
                hasPendingMessages: () => {
                    throw new Error('boom');
                },
            }),
        );
        expect(helloSnapshot(ch).compactReadiness).toEqual({
            idle: false,
            hasPendingMessages: true,
            compactionActive: false,
            bridgePending: false,
        });
        rt.shutdown();
    });

    it('samples finalized assistant messages without disturbing lifecycle', async () => {
        const { ch, rt } = await startedWith(telemetryCtx());
        rt.onAgentStart(telemetryCtx());
        rt.onAgentEnd('stop');
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(snapshotOf(ch.nonfatalSends[0]!).contextUsage?.tokens).toBe(
            1010,
        );
        rt.onAgentSettled(telemetryCtx(), false);
        const settled = ch.sends.filter(
            (m) => payloadOf(m).$case === 'agentSettled',
        );
        expect(settled).toHaveLength(1);
        rt.shutdown();
    });

    it('refreshes context on the post-persistence turn_end boundary', async () => {
        const { ch, rt } = await startedWith(telemetryCtx());
        rt.onAgentStart(telemetryCtx());
        // A later turn carries a new measurement; the run continues.
        rt.onTurnEnd(
            telemetryCtx({
                getContextUsage: () => ({
                    tokens: 6100,
                    contextWindow: 8192,
                    percent: 74.46,
                }),
            }),
        );
        const emitted = ch.nonfatalSends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(emitted).toHaveLength(1);
        const snap = snapshotOf(emitted[0]!);
        expect(snap.state).toBe(LogicalState.LOGICAL_STATE_RUNNING);
        expect(snap.contextUsage?.tokens).toBe(6100);
        // No lifecycle edge: the run still settles exactly once.
        rt.onAgentEnd('stop');
        rt.onAgentSettled(telemetryCtx(), false);
        expect(
            ch.sends.filter((m) => payloadOf(m).$case === 'agentSettled'),
        ).toHaveLength(1);
        rt.shutdown();
    });

    it('retains the newest sample when context-only admission misses', async () => {
        const { ch, rt } = await startedWith(telemetryCtx());
        ch.nonfatalResult = false;
        rt.onAgentStart(telemetryCtx());
        rt.onAgentEnd('stop');
        expect(ch.nonfatalSends).toHaveLength(1);
        // Newest measurement, sampled after admission missed.
        rt.onModelSelect(
            telemetryCtx({
                getContextUsage: () => ({
                    tokens: 4242,
                    contextWindow: 8192,
                    percent: 51.78,
                }),
            }),
        );
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshotOf(snaps[snaps.length - 1]!).contextUsage).toEqual({
            tokens: 4242,
            contextWindow: 8192,
            percent: 51.78,
        });
        rt.shutdown();
    });

    it('reconnect baselines carry the newest live sample', async () => {
        const usage = { tokens: 1010, contextWindow: 8192, percent: 12.3 };
        const view = () =>
            telemetryCtx({ getContextUsage: () => ({ ...usage }) });
        const channels: MockChannel[] = [];
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            backoffBaseMs: 5,
            backoffMaxMs: 10,
            makeChannel: (_c, hooks) => {
                const ch = mockChannel();
                ch.hooks = hooks;
                channels.push(ch);
                return ch;
            },
        });
        rt.start(view());
        await sleep(10);
        // No event: the host value moves on its own.
        usage.tokens = 7777;
        usage.percent = 94.9;
        channels[0]!.hooks!.onStatus(status(14));
        await sleep(30);
        expect(channels.length).toBe(2);
        const payload = payloadOf(channels[1]!.hellos[0]!);
        if (payload.$case !== 'hello' || !payload.value.currentState) {
            throw new Error('reconnect without a baseline');
        }
        expect(payload.value.currentState.contextUsage).toEqual({
            tokens: 7777,
            contextWindow: 8192,
            percent: 94.9,
        });
        rt.shutdown();
    });

    it('keeps telemetry snapshots under lifecycle headroom at full journal', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        const long = 's'.repeat(128);
        const big = () =>
            telemetryCtx({
                sessionManager: {
                    getSessionId: () => long,
                    getLeafId: () => long,
                },
                model: {
                    provider: long,
                    model: long,
                    providerId: long,
                    id: long,
                } as unknown as PiContextView['model'],
            });
        rt.start(big());
        await sleep(10);
        for (let i = 0; i < 70; i++) rt.onAgentStart(big());
        let max = 0;
        for (const m of [...ch.sends, ...ch.hellos]) {
            max = Math.max(max, PiToPhi.encode(m).finish().length);
        }
        expect(max).toBeLessThan(LIFECYCLE_HEADROOM_BYTES);
        rt.shutdown();
    });
});

interface CapturedCompact {
    readonly options: unknown;
    readonly onComplete: () => void;
    readonly onError: (error: Error) => void;
}

/**
 * Capture one compact invocation for manual callback control. The
 * completion payload is irrelevant (the runtime must ignore it),
 * so the captured trigger takes no arguments.
 */
function captureCompactCall(
    options: { onComplete?: unknown; onError?: unknown } | undefined,
): CapturedCompact {
    const complete = options?.onComplete as (() => void) | undefined;
    const fail = options?.onError as ((error: Error) => void) | undefined;
    return {
        options,
        onComplete: () => complete?.(),
        onError: (error: Error) => fail?.(error),
    };
}

function compactRequest(
    id: string,
    over: {
        session?: string;
        leaf?: string;
        model?: { provider: string; model: string } | null;
    } = {},
): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: {
            $case: 'compactRequest',
            value: {
                requestId: id,
                expectedSessionId: over.session ?? 'sess',
                expectedLeafId: over.leaf ?? 'leaf',
                expectedModel:
                    over.model === null
                        ? undefined
                        : (over.model ?? { provider: 'p', model: 'm' }),
            },
        },
    };
}

function compactResultOf(msg: PiToPhi): {
    requestId: string;
    outcome: CompactOutcome;
    reason: string;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'compactResult') {
        throw new Error(`not a compact result: ${payload.$case}`);
    }
    return payload.value;
}

function results(ch: MockChannel): Array<{
    requestId: string;
    outcome: CompactOutcome;
    reason: string;
}> {
    return ch.nonfatalSends
        .filter((m) => payloadOf(m).$case === 'compactResult')
        .map(compactResultOf);
}

describe('Runtime compact dispatch', () => {
    async function startedCompact(
        over: Partial<PiContextView> = {},
        latch?: CompactLatchState,
    ): Promise<{
        ch: MockChannel;
        rt: Runtime;
        latch: CompactLatchState;
        calls: CapturedCompact[];
    }> {
        const calls: CapturedCompact[] = [];
        const ch = mockChannel();
        const l = latch ?? freshCompactLatch();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: l,
            makeChannel: wired(ch),
        });
        rt.start(
            telemetryCtx({
                compact: (options) => {
                    calls.push(captureCompactCall(options));
                },
                ...over,
            }),
        );
        await sleep(10);
        return { ch, rt, latch: l, calls };
    }

    it('keeps the compact outcome vocabulary stable', () => {
        expect(CompactOutcome.COMPACT_OUTCOME_UNSPECIFIED).toBe(0);
        expect(CompactOutcome.COMPACT_OUTCOME_COMPLETED).toBe(1);
        expect(CompactOutcome.COMPACT_OUTCOME_REFUSED).toBe(2);
        expect(CompactOutcome.COMPACT_OUTCOME_FAILED).toBe(3);
        expect(CompactOutcome.COMPACT_OUTCOME_CANCELLED).toBe(4);
    });

    it('dispatches through the public API and completes on the new leaf', async () => {
        let leaf = 'leaf';
        const view = () =>
            telemetryCtx({
                sessionManager: {
                    getSessionId: () => 'sess',
                    getLeafId: () => leaf,
                },
                compact: (options) => {
                    calls.push(captureCompactCall(options));
                },
            });
        const calls: CapturedCompact[] = [];
        const ch = mockChannel();
        const latch = freshCompactLatch();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: latch,
            makeChannel: wired(ch),
        });
        rt.start(view());
        await sleep(10);
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(1);
        // Callbacks only: no instructions, no summary override, and the
        // structural view exposes no abort for the runtime to call.
        expect(Object.keys(calls[0]!.options ?? {}).sort()).toEqual([
            'onComplete',
            'onError',
        ]);
        expect(latch.pending?.requestId).toBe('1');
        // Native success changes the leaf before the callback runs.
        leaf = 'leaf-2';
        rt.onCompactEnd(view());
        calls[0]!.onComplete();
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_COMPLETED,
                reason: '',
            },
        ]);
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshotOf(snaps[snaps.length - 1]!).leafId).toBe('leaf-2');
        expect(latch.pending).toBeNull();
        rt.shutdown();
    });

    it('maps host failure to failed/error', async () => {
        const { ch, rt, latch, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(1);
        calls[0]!.onError(new Error('provider blew up'));
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
                reason: 'error',
            },
        ]);
        expect(latch.pending).toBeNull();
        rt.shutdown();
    });

    it('maps already-compacted to failed/already-compacted', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1'));
        calls[0]!.onError(new Error('Already compacted'));
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
                reason: 'already-compacted',
            },
        ]);
        rt.shutdown();
    });

    it('maps host cancellation to cancelled/cancelled', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1'));
        calls[0]!.onError(new Error('Compaction cancelled'));
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_CANCELLED,
                reason: 'cancelled',
            },
        ]);
        rt.shutdown();
    });

    it('maps an AbortError to cancelled/cancelled', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1'));
        // Node's abort reason carries no "cancel" text, only the name.
        const abort = new Error('This operation was aborted');
        abort.name = 'AbortError';
        calls[0]!.onError(abort);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_CANCELLED,
                reason: 'cancelled',
            },
        ]);
        rt.shutdown();
    });

    it('classifies abort shapes by name, not by message', async () => {
        const cases: Array<{
            label: string;
            error: unknown;
            outcome: CompactOutcome;
            reason: string;
        }> = [
            {
                label: 'DOMException AbortError',
                error: new DOMException(
                    'This operation was aborted',
                    'AbortError',
                ),
                outcome: CompactOutcome.COMPACT_OUTCOME_CANCELLED,
                reason: 'cancelled',
            },
            {
                label: 'plain abort shape',
                error: {
                    name: 'AbortError',
                    message: 'This operation was aborted',
                },
                outcome: CompactOutcome.COMPACT_OUTCOME_CANCELLED,
                reason: 'cancelled',
            },
            {
                label: 'cancel text only',
                error: new Error('Compaction cancelled'),
                outcome: CompactOutcome.COMPACT_OUTCOME_CANCELLED,
                reason: 'cancelled',
            },
            {
                // Abort wording without the name stays a failure: a
                // provider error may say "aborted" too.
                label: 'abort text without the name',
                error: new Error('stream aborted'),
                outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
                reason: 'error',
            },
            {
                label: 'hostile name getter',
                error: Object.defineProperty({}, 'name', {
                    get() {
                        throw new Error('nope');
                    },
                }),
                outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
                reason: 'error',
            },
        ];
        for (const testCase of cases) {
            const { ch, rt, calls } = await startedCompact();
            ch.hooks!.onMessage(compactRequest('1'));
            expect(calls).toHaveLength(1);
            // The host type promises Error; hostile shapes still reach
            // this callback at runtime, which is the point of the table.
            calls[0]!.onError(testCase.error as Error);
            expect([testCase.label, results(ch)]).toEqual([
                testCase.label,
                [
                    {
                        requestId: '1',
                        outcome: testCase.outcome,
                        reason: testCase.reason,
                    },
                ],
            ]);
            rt.shutdown();
        }
    });

    it('refuses when the host is busy', async () => {
        const { ch, rt, latch, calls } = await startedCompact({
            isIdle: () => false,
        });
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'busy',
            },
        ]);
        expect(latch.pending).toBeNull();
        // The refused ID is consumed: a replay is a duplicate.
        ch.hooks!.onMessage(compactRequest('1'));
        expect(results(ch)).toHaveLength(2);
        expect(results(ch)[1]).toEqual({
            requestId: '1',
            outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
            reason: 'duplicate',
        });
        rt.shutdown();
    });

    it('refuses with queued messages', async () => {
        const { ch, rt, calls } = await startedCompact({
            hasPendingMessages: () => true,
        });
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'queued',
            },
        ]);
        rt.shutdown();
    });

    it('refuses while native compaction is active', async () => {
        const calls: CapturedCompact[] = [];
        const over = {
            compact: (options?: {
                onComplete?: unknown;
                onError?: unknown;
            }) => {
                calls.push(captureCompactCall(options));
            },
        };
        const { ch, rt } = await startedCompact(over);
        rt.onCompactStart(telemetryCtx(over));
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'compaction-active',
            },
        ]);
        // The end event clears the flag; a new ID dispatches.
        rt.onCompactEnd(telemetryCtx(over));
        ch.hooks!.onMessage(compactRequest('2'));
        expect(calls).toHaveLength(1);
        rt.shutdown();
    });

    it('refuses while a bridge compaction is unresolved', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(1);
        ch.hooks!.onMessage(compactRequest('2'));
        expect(calls).toHaveLength(1);
        expect(results(ch)).toEqual([
            {
                requestId: '2',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'pending',
            },
        ]);
        calls[0]!.onComplete();
        expect(results(ch)).toHaveLength(2);
        ch.hooks!.onMessage(compactRequest('3'));
        expect(calls).toHaveLength(2);
        rt.shutdown();
    });

    it('rejects duplicate and older IDs', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('5'));
        calls[0]!.onComplete();
        expect(calls).toHaveLength(1);
        ch.hooks!.onMessage(compactRequest('5'));
        ch.hooks!.onMessage(compactRequest('3'));
        expect(results(ch).slice(1)).toEqual([
            {
                requestId: '5',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'duplicate',
            },
            {
                requestId: '3',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'duplicate',
            },
        ]);
        expect(calls).toHaveLength(1);
        ch.hooks!.onMessage(compactRequest('6'));
        expect(calls).toHaveLength(2);
        rt.shutdown();
    });

    it.each([
        ['wrong session', { session: 'other' }],
        ['wrong leaf', { leaf: 'other' }],
        ['wrong model', { model: { provider: 'p', model: 'zzz' } }],
        ['empty session', { session: '' }],
        ['oversized leaf', { leaf: 'x'.repeat(300) }],
    ])('refuses a stale snapshot: %s', async (_name, over) => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1', over));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'stale',
            },
        ]);
        rt.shutdown();
    });

    it('refuses an absent-model expectation when the host holds a model', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1', { model: null }));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'stale',
            },
        ]);
        rt.shutdown();
    });

    it('dispatches when absent-model expectation meets an absent live model', async () => {
        const { ch, rt, calls } = await startedCompact({ model: undefined });
        ch.hooks!.onMessage(compactRequest('1', { model: null }));
        expect(calls).toHaveLength(1);
        calls[0]!.onComplete();
        expect(results(ch)[0]!.outcome).toBe(
            CompactOutcome.COMPACT_OUTCOME_COMPLETED,
        );
        rt.shutdown();
    });

    it('refuses when live identity is unreadable instead of trusting cache', async () => {
        const { ch, rt, calls } = await startedCompact({
            sessionManager: {
                getSessionId: () => {
                    throw new Error('boom');
                },
                getLeafId: () => 'leaf',
            },
        });
        // The cached 'sess' matches, but the live read fails: refuse.
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'stale',
            },
        ]);
        rt.shutdown();
    });

    it('refuses when the live leaf read throws', async () => {
        const { ch, rt, calls } = await startedCompact({
            sessionManager: {
                getSessionId: () => 'sess',
                getLeafId: () => {
                    throw new Error('boom');
                },
            },
        });
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'stale',
            },
        ]);
        rt.shutdown();
    });

    it('refuses when the live model read throws, without breaking the runtime', async () => {
        const { ch, rt, latch, calls } = await startedCompact();
        const throwing = telemetryCtx();
        Object.defineProperty(throwing, 'model', {
            get() {
                throw new Error('boom');
            },
        });
        // A throwing host accessor must not escape event mapping.
        expect(() => rt.onModelSelect(throwing)).not.toThrow();
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'stale',
            },
        ]);
        // The runtime still works: a good event and a new ID dispatch.
        const recapture = (options?: {
            onComplete?: unknown;
            onError?: unknown;
        }): void => {
            calls.push(captureCompactCall(options));
        };
        rt.onModelSelect(telemetryCtx({ compact: recapture }));
        ch.hooks!.onMessage(compactRequest('2'));
        expect(calls).toHaveLength(1);
        expect(latch.pending?.requestId).toBe('2');
        rt.shutdown();
    });

    it('dispatches with the maximum canonical uint64 ID', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('18446744073709551615'));
        expect(calls).toHaveLength(1);
        calls[0]!.onComplete();
        expect(results(ch)).toEqual([
            {
                requestId: '18446744073709551615',
                outcome: CompactOutcome.COMPACT_OUTCOME_COMPLETED,
                reason: '',
            },
        ]);
        rt.shutdown();
    });

    it.each([
        [''],
        ['0'],
        ['00'],
        ['01'],
        ['abc'],
        ['1x'],
        ['-1'],
        ['1.5'],
        [' 1'],
        ['1 '],
        ['x'.repeat(21)],
        ['18446744073709551616'],
    ])('drops malformed IDs without consuming them: %s', async (bad) => {
        const { ch, rt, latch, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest(bad));
        expect(calls).toHaveLength(0);
        expect(ch.nonfatalSends).toHaveLength(0);
        expect(latch.highWater).toBeNull();
        // The malformed ID left no trace: '1' still dispatches.
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(1);
        rt.shutdown();
    });

    it('drops requests when compact was not negotiated', async () => {
        const ch = mockChannel();
        ch.connect = async (hello: PiToPhi) => {
            ch.hellos.push(hello);
            return {
                protocolVersion: 1,
                capabilities: [CAPABILITY_LIFECYCLE],
                runtimeGeneration: 1n,
                runtimeId: 'rt',
            };
        };
        const calls: CapturedCompact[] = [];
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        rt.start(
            telemetryCtx({
                compact: (options) => {
                    calls.push(captureCompactCall(options));
                },
            }),
        );
        await sleep(10);
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(0);
        expect(ch.nonfatalSends).toHaveLength(0);
        rt.shutdown();
    });

    it('refuses when the compact APIs vanished after negotiation', async () => {
        const { ch, rt, calls } = await startedCompact();
        rt.onModelSelect(ctx());
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(0);
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
                reason: 'unavailable',
            },
        ]);
        rt.shutdown();
    });

    it('reports uncertain on a sync throw and retains the latch', async () => {
        const calls: Array<{
            onComplete: () => void;
            onError: (error: Error) => void;
        }> = [];
        const view = telemetryCtx({
            compact: (options) => {
                calls.push(captureCompactCall(options));
                throw new Error('sync boom');
            },
        });
        const ch = mockChannel();
        const latch = freshCompactLatch();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: latch,
            makeChannel: wired(ch),
        });
        rt.start(view);
        await sleep(10);
        ch.hooks!.onMessage(compactRequest('1'));
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_UNSPECIFIED,
                reason: 'uncertain',
            },
        ]);
        // The latch stays unresolved: no automatic retry permitted.
        expect(latch.pending?.requestId).toBe('1');
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshotOf(snaps[snaps.length - 1]!).compactReadiness).toEqual({
            idle: true,
            hasPendingMessages: false,
            compactionActive: false,
            bridgePending: true,
        });
        ch.hooks!.onMessage(compactRequest('2'));
        expect(results(ch)[1]).toEqual({
            requestId: '2',
            outcome: CompactOutcome.COMPACT_OUTCOME_REFUSED,
            reason: 'pending',
        });
        // A late callback releases only its matching operation: no
        // second result, but readiness refreshes to free.
        calls[0]!.onComplete();
        expect(results(ch)).toHaveLength(2);
        expect(latch.pending).toBeNull();
        const snaps2 = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(
            snapshotOf(snaps2[snaps2.length - 1]!).compactReadiness
                ?.bridgePending,
        ).toBe(false);
        rt.shutdown();
    });

    it('sends no uncertain result after synchronous success then throw', async () => {
        const calls: CapturedCompact[] = [];
        const view = telemetryCtx({
            compact: (options) => {
                const call = captureCompactCall(options);
                calls.push(call);
                call.onComplete();
                throw new Error('sync boom after success');
            },
        });
        const ch = mockChannel();
        const latch = freshCompactLatch();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: latch,
            makeChannel: wired(ch),
        });
        rt.start(view);
        await sleep(10);
        ch.hooks!.onMessage(compactRequest('1'));
        // Exactly one terminal result: the synchronous success.
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_COMPLETED,
                reason: '',
            },
        ]);
        expect(latch.pending).toBeNull();
        rt.shutdown();
    });

    it('maps a Symbol error message to a safe failure without throwing', async () => {
        const { ch, rt, latch, calls } = await startedCompact();
        const evilMessage = new Error('hidden');
        Object.defineProperty(evilMessage, 'message', {
            // A runtime Symbol defeats the string annotation: the
            // classifier must coerce it inside the guard instead of
            // letting the regex throw before latch release.
            get: () => Symbol('boom'),
        });
        ch.hooks!.onMessage(compactRequest('1'));
        expect(() => calls[0]!.onError(evilMessage)).not.toThrow();
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
                reason: 'error',
            },
        ]);
        expect(latch.pending).toBeNull();
        rt.shutdown();
    });

    it('survives throwing error message access in onError', async () => {
        const { ch, rt, latch, calls } = await startedCompact();
        const evilCoercion = {};
        Object.defineProperty(evilCoercion, 'toString', {
            value: () => {
                throw new Error('coercion boom');
            },
        });
        ch.hooks!.onMessage(compactRequest('1'));
        expect(() =>
            calls[0]!.onError(evilCoercion as unknown as Error),
        ).not.toThrow();
        const evilGetter = new Error('hidden');
        Object.defineProperty(evilGetter, 'message', {
            get: () => {
                throw new Error('getter boom');
            },
        });
        ch.hooks!.onMessage(compactRequest('2'));
        expect(() => calls[1]!.onError(evilGetter)).not.toThrow();
        expect(results(ch)).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
                reason: 'error',
            },
            {
                requestId: '2',
                outcome: CompactOutcome.COMPACT_OUTCOME_FAILED,
                reason: 'error',
            },
        ]);
        expect(latch.pending).toBeNull();
        rt.shutdown();
    });

    it('terminates at most once on a double callback', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1'));
        calls[0]!.onComplete();
        calls[0]!.onComplete();
        calls[0]!.onError(new Error('late'));
        expect(results(ch)).toHaveLength(1);
        rt.shutdown();
    });

    it('never throws from callbacks, even when publishing fails', async () => {
        const { ch, rt, latch, calls } = await startedCompact();
        ch.send = () => {
            throw new Error('send boom');
        };
        ch.sendNonfatal = () => {
            throw new Error('nonfatal boom');
        };
        ch.hooks!.onMessage(compactRequest('1'));
        expect(() => calls[0]!.onComplete()).not.toThrow();
        // Released exactly once; no second failure result is possible.
        expect(latch.pending).toBeNull();
        expect(() => calls[0]!.onError(new Error('x'))).not.toThrow();
        rt.shutdown();
    });

    it('releases across runtime replacement without publishing stale state', async () => {
        const latch = freshCompactLatch();
        const ch1 = mockChannel();
        const rt1 = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: latch,
            makeChannel: wired(ch1),
        });
        const calls: CapturedCompact[] = [];
        const view = telemetryCtx({
            compact: (options) => {
                calls.push(captureCompactCall(options));
            },
        });
        rt1.start(view);
        await sleep(10);
        ch1.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(1);
        // Replacement runtime takes over the process slot.
        rt1.shutdown();
        const ch2 = mockChannel();
        const rt2 = new Runtime({
            creds: CREDS,
            generation: 2n,
            compactState: latch,
            makeChannel: wired(ch2),
        });
        rt2.start(view);
        await sleep(10);
        expect(latch.pending?.requestId).toBe('1');
        // The old callback releases its operation but publishes
        // no terminal result on the retired runtime. (Dispatch
        // already emitted one pending snapshot there.)
        calls[0]!.onComplete();
        expect(results(ch1)).toHaveLength(0);
        expect(latch.pending).toBeNull();
        // The active runtime refreshes readiness with its context.
        const snaps = ch2.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snaps.length).toBeGreaterThan(0);
        expect(snapshotOf(snaps[snaps.length - 1]!).compactReadiness).toEqual({
            idle: true,
            hasPendingMessages: false,
            compactionActive: false,
            bridgePending: false,
        });
        rt2.shutdown();
    });

    it('keeps pending work across reconnect and answers on the new channel', async () => {
        const calls: CapturedCompact[] = [];
        const view = telemetryCtx({
            compact: (options) => {
                calls.push(captureCompactCall(options));
            },
        });
        const channels: MockChannel[] = [];
        const latch = freshCompactLatch();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: latch,
            backoffBaseMs: 5,
            backoffMaxMs: 10,
            makeChannel: (_c, hooks) => {
                const ch = mockChannel();
                ch.hooks = hooks;
                channels.push(ch);
                return ch;
            },
        });
        rt.start(view);
        await sleep(10);
        channels[0]!.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(1);
        channels[0]!.hooks!.onStatus(status(14));
        await sleep(30);
        expect(channels.length).toBe(2);
        expect(latch.pending?.requestId).toBe('1');
        expect(latch.highWater).toBe(1n);
        calls[0]!.onComplete();
        const fresh = results(channels[1]!);
        expect(fresh).toEqual([
            {
                requestId: '1',
                outcome: CompactOutcome.COMPACT_OUTCOME_COMPLETED,
                reason: '',
            },
        ]);
        expect(results(channels[0]!)).toHaveLength(0);
        rt.shutdown();
    });

    it('releases without publishing when the session changed', async () => {
        let session = 'sess';
        const view = () =>
            telemetryCtx({
                sessionManager: {
                    getSessionId: () => session,
                    getLeafId: () => 'leaf',
                },
            });
        const calls: CapturedCompact[] = [];
        const ch = mockChannel();
        const latch = freshCompactLatch();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: latch,
            makeChannel: wired(ch),
        });
        const base = view();
        rt.start({
            ...base,
            compact: (options) => {
                calls.push(captureCompactCall(options));
            },
        });
        await sleep(10);
        ch.hooks!.onMessage(compactRequest('1'));
        expect(calls).toHaveLength(1);
        // Same runtime, replaced session: the callback must not
        // report success into the new session.
        session = 'sess-b';
        calls[0]!.onComplete();
        // No terminal result into the new session. (Dispatch
        // already emitted one pending snapshot before the move.)
        expect(results(ch)).toHaveLength(0);
        expect(latch.pending).toBeNull();
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshotOf(snaps[snaps.length - 1]!).sessionId).toBe('sess-b');
        rt.shutdown();
    });

    it('resamples readiness from the callback, not the compact event', async () => {
        // Pi emits session_compact before clearing manual-compaction
        // state: idle still reads false at the event, true later.
        let cleared = false;
        const view = () =>
            telemetryCtx({
                isIdle: () => cleared,
            });
        const calls: CapturedCompact[] = [];
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        const base = view();
        rt.start({
            ...base,
            isIdle: () => true,
            compact: (options) => {
                calls.push(captureCompactCall(options));
            },
        });
        await sleep(10);
        ch.hooks!.onMessage(compactRequest('1'));
        rt.onCompactEnd(view());
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(
            snapshotOf(snaps[snaps.length - 1]!).compactReadiness?.idle,
        ).toBe(false);
        cleared = true;
        calls[0]!.onComplete();
        const snaps2 = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(
            snapshotOf(snaps2[snaps2.length - 1]!).compactReadiness?.idle,
        ).toBe(true);
        rt.shutdown();
    });

    it('refreshes readiness after a compaction no bridge callback owns', async () => {
        // A compaction typed in the TUI has no Compact callback, so
        // only the bounded post-event refresh can publish the cleared
        // state; without it the control stays disabled until the next
        // unrelated event.
        let cleared = false;
        const view = () => telemetryCtx({ isIdle: () => cleared });
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        rt.start(view());
        await sleep(10);
        rt.onCompactEnd(view());
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(
            snapshotOf(snaps[snaps.length - 1]!).compactReadiness?.idle,
        ).toBe(false);
        cleared = true;
        await sleep(50);
        const refreshed = ch.nonfatalSends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(
            refreshed.some(
                (m) => snapshotOf(m).compactReadiness?.idle === true,
            ),
        ).toBe(true);
        rt.shutdown();
    });

    it('bounds the post-event readiness refresh attempts', async () => {
        // The ladder exists for a compaction with no callback. It must
        // publish once on busy-to-idle, then stop; a busy host must not
        // be resampled forever.
        let cleared = false;
        let idleReads = 0;
        const view = () =>
            telemetryCtx({
                isIdle: () => {
                    idleReads += 1;
                    return cleared;
                },
            });
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
        });
        const published = () =>
            ch.nonfatalSends.filter(
                (m) => payloadOf(m).$case === 'stateSnapshot',
            ).length;
        rt.start(view());
        await sleep(10);
        rt.onCompactEnd(view());
        // Still busy at the first attempt: no publish yet.
        await sleep(60);
        expect(published()).toBe(0);
        cleared = true;
        await sleep(200);
        expect(published()).toBe(1);
        const readsAfterFlip = idleReads;
        await sleep(500);
        expect(published()).toBe(1);
        expect(idleReads).toBe(readsAfterFlip);
        rt.shutdown();

        // A host that never clears manual-compaction state stops after
        // the bounded attempts instead of resampling forever.
        const ch2 = mockChannel();
        let reads2 = 0;
        const busyView = () =>
            telemetryCtx({
                isIdle: () => {
                    reads2 += 1;
                    return false;
                },
            });
        const rt2 = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch2),
        });
        rt2.start(busyView());
        await sleep(10);
        rt2.onCompactEnd(busyView());
        await sleep(900);
        const readsAtCap = reads2;
        await sleep(400);
        expect(reads2).toBe(readsAtCap);
        expect(
            ch2.nonfatalSends.filter(
                (m) => payloadOf(m).$case === 'stateSnapshot',
            ),
        ).toHaveLength(0);
        rt2.shutdown();
    });

    it('reports bridge pending in readiness while unresolved', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.hooks!.onMessage(compactRequest('1'));
        // Dispatch itself emits the pending frame: no extra event.
        const emitted = ch.nonfatalSends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(emitted).toHaveLength(1);
        expect(snapshotOf(emitted[0]!).compactReadiness).toEqual({
            idle: true,
            hasPendingMessages: false,
            compactionActive: false,
            bridgePending: true,
        });
        calls[0]!.onComplete();
        const snaps2 = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(
            snapshotOf(snaps2[snaps2.length - 1]!).compactReadiness
                ?.bridgePending,
        ).toBe(false);
        rt.shutdown();
    });

    it('publishes native compaction start without a lifecycle edge', async () => {
        const { ch, rt } = await startedCompact();
        const sendsBefore = ch.sends.length;
        rt.onCompactStart(telemetryCtx());
        const emitted = ch.nonfatalSends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(emitted).toHaveLength(1);
        expect(snapshotOf(emitted[0]!).compactReadiness).toEqual({
            idle: true,
            hasPendingMessages: false,
            compactionActive: true,
            bridgePending: false,
        });
        // No lifecycle edge was fabricated.
        expect(ch.sends).toHaveLength(sendsBefore);
        rt.shutdown();
    });

    it('retains start and pending state when nonfatal admission misses', async () => {
        const { ch, rt, calls } = await startedCompact();
        ch.nonfatalResult = false;
        ch.hooks!.onMessage(compactRequest('1'));
        rt.onCompactStart(telemetryCtx());
        // Both immediate publishes missed admission, but the
        // newest sample stays for the next authoritative snapshot.
        rt.onModelSelect(telemetryCtx());
        const snaps = ch.sends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(snapshotOf(snaps[snaps.length - 1]!).compactReadiness).toEqual({
            idle: true,
            hasPendingMessages: false,
            compactionActive: true,
            bridgePending: true,
        });
        calls[0]!.onComplete();
        rt.shutdown();
    });
});

function skillsRequest(id: string): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: { $case: 'skillsRequest', value: { requestId: id } },
    };
}

function invokeSkillRequest(id: string, name: string): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: {
            $case: 'invokeSkillRequest',
            value: { requestId: id, name },
        },
    };
}

function skillsOf(msg: PiToPhi): {
    requestId: string;
    skills: Array<{ name: string; description: string }>;
    truncated: boolean;
    unavailable: boolean;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'skillsResponse') {
        throw new Error(`not a skills response: ${payload.$case}`);
    }
    return payload.value;
}

function invokeAckOf(msg: PiToPhi): {
    requestId: string;
    ok: boolean;
    reason: string;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'invokeSkillAck') {
        throw new Error(`not an invoke-skill ack: ${payload.$case}`);
    }
    return payload.value;
}

describe('Runtime skills requests', () => {
    interface SkillHost {
        getSkills?: () => Array<{ name: string; description: string }>;
        invokeSkill?: (name: string) => void;
    }

    async function started(host: SkillHost): Promise<{
        ch: MockChannel;
        rt: Runtime;
    }> {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
            ...(host.getSkills ? { getSkills: host.getSkills } : {}),
            ...(host.invokeSkill ? { invokeSkill: host.invokeSkill } : {}),
        });
        rt.start(ctx());
        await sleep(10);
        return { ch, rt };
    }

    function capabilitiesOf(ch: MockChannel): string[] {
        const payload = payloadOf(ch.hellos[0]!);
        if (payload.$case !== 'hello') throw new Error('not a hello');
        return payload.value.capabilities;
    }

    it('advertises the capability only with both host calls', async () => {
        const both = await started({
            getSkills: () => [],
            invokeSkill: () => {},
        });
        expect(capabilitiesOf(both.ch)).toContain(CAPABILITY_SKILLS);
        both.rt.shutdown();

        const listOnly = await started({ getSkills: () => [] });
        expect(capabilitiesOf(listOnly.ch)).not.toContain(CAPABILITY_SKILLS);
        listOnly.rt.shutdown();

        const invokeOnly = await started({ invokeSkill: () => {} });
        expect(capabilitiesOf(invokeOnly.ch)).not.toContain(CAPABILITY_SKILLS);
        invokeOnly.rt.shutdown();
    });

    it('answers with the live skills and echoes the id', async () => {
        const { ch, rt } = await started({
            getSkills: () => [
                { name: 'demo-skill', description: 'demo' },
                { name: 'other-skill', description: '' },
            ],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(skillsRequest('k1'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(skillsOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 'k1',
            skills: [
                { name: 'demo-skill', description: 'demo' },
                { name: 'other-skill', description: '' },
            ],
            truncated: false,
            unavailable: false,
        });
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('answers unavailable when the host list throws', async () => {
        const { ch, rt } = await started({
            getSkills: () => {
                throw new Error('boom');
            },
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(skillsRequest('k2'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(skillsOf(ch.nonfatalSends[0]!).unavailable).toBe(true);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('truncates at the entry cap', async () => {
        const entries = Array.from(
            { length: MAX_SKILL_ENTRIES + 50 },
            (_, i) => ({
                name: `skill-${i}`,
                description: 'd',
            }),
        );
        const { ch, rt } = await started({
            getSkills: () => entries,
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(skillsRequest('k3'));
        expect(ch.nonfatalSends).toHaveLength(1);
        const res = skillsOf(ch.nonfatalSends[0]!);
        expect(res.skills).toHaveLength(MAX_SKILL_ENTRIES);
        expect(res.truncated).toBe(true);
        expect(res.unavailable).toBe(false);
        rt.shutdown();
    });

    it('answers unavailable for a multi-byte description over the wire bound', async () => {
        // 600 characters pass Pi's character check but are 1200 bytes.
        const { ch, rt } = await started({
            getSkills: () => [
                { name: 'demo-skill', description: 'é'.repeat(600) },
            ],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(skillsRequest('k4'));
        expect(ch.nonfatalSends).toHaveLength(1);
        const res = skillsOf(ch.nonfatalSends[0]!);
        expect(res.unavailable).toBe(true);
        expect(res.skills).toHaveLength(0);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('answers unavailable for a warning-loaded overlong entry', async () => {
        // Pi loads a skill whose description is too long and only warns.
        const { ch, rt } = await started({
            getSkills: () => [
                { name: 'demo-skill', description: 'x'.repeat(2000) },
            ],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(skillsRequest('k5'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(skillsOf(ch.nonfatalSends[0]!).unavailable).toBe(true);
        rt.shutdown();
    });

    it('answers unavailable for a name that cannot address one skill', async () => {
        // Pi only warns about a name with a space, but "/skill:<name>"
        // would split at the first space and expand another skill.
        const { ch, rt } = await started({
            getSkills: () => [{ name: 'demo skill', description: 'demo' }],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(skillsRequest('k8'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(skillsOf(ch.nonfatalSends[0]!).unavailable).toBe(true);
        rt.shutdown();
    });

    it('answers unavailable for a bad entry past the cap', async () => {
        // The whole raw list is checked before the cap applies: an
        // entry beyond the display limit still breaks the answer.
        const entries = Array.from(
            { length: MAX_SKILL_ENTRIES + 1 },
            (_, i) => ({ name: `skill-${i}`, description: 'd' }),
        );
        entries[MAX_SKILL_ENTRIES] = {
            name: 'demo skill',
            description: 'd',
        };
        const { ch, rt } = await started({
            getSkills: () => entries,
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(skillsRequest('k9'));
        expect(ch.nonfatalSends).toHaveLength(1);
        const res = skillsOf(ch.nonfatalSends[0]!);
        expect(res.unavailable).toBe(true);
        expect(res.skills).toHaveLength(0);
        rt.shutdown();
    });

    it('drops requests when skills were not negotiated', async () => {
        const { ch, rt } = await started({ getSkills: () => [] });
        ch.hooks!.onMessage(skillsRequest('k6'));
        expect(ch.nonfatalSends).toHaveLength(0);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('drops requests with an empty id', async () => {
        const { ch, rt } = await started({
            getSkills: () => [],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(skillsRequest(''));
        expect(ch.nonfatalSends).toHaveLength(0);
        rt.shutdown();
    });

    it('fails only the request when admission misses', async () => {
        const { ch, rt } = await started({
            getSkills: () => [{ name: 'demo-skill', description: 'demo' }],
            invokeSkill: () => {},
        });
        ch.nonfatalResult = false;
        ch.hooks!.onMessage(skillsRequest('k7'));
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });
});

describe('Runtime skill invocations', () => {
    async function started(host: {
        getSkills?: () => Array<{ name: string; description: string }>;
        invokeSkill?: (name: string) => void;
    }): Promise<{ ch: MockChannel; rt: Runtime; sent: string[] }> {
        const ch = mockChannel();
        const sent: string[] = [];
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            makeChannel: wired(ch),
            ...(host.getSkills ? { getSkills: host.getSkills } : {}),
            ...(host.invokeSkill
                ? {
                      invokeSkill: (name: string) => {
                          sent.push(name);
                          host.invokeSkill!(name);
                      },
                  }
                : {}),
        });
        rt.start(ctx());
        await sleep(10);
        return { ch, rt, sent };
    }

    it('acks ok and dispatches through the host for a known skill', async () => {
        const { ch, rt, sent } = await started({
            getSkills: () => [{ name: 'demo-skill', description: 'demo' }],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(invokeSkillRequest('i1', 'demo-skill'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(invokeAckOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 'i1',
            ok: true,
            reason: '',
        });
        expect(sent).toEqual(['demo-skill']);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('acks unknown-skill for a name the session does not know', async () => {
        const { ch, rt, sent } = await started({
            getSkills: () => [{ name: 'demo-skill', description: 'demo' }],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(invokeSkillRequest('i2', 'other-skill'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(invokeAckOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 'i2',
            ok: false,
            reason: 'unknown-skill',
        });
        expect(sent).toEqual([]);
        rt.shutdown();
    });

    it('acks unavailable when the host call throws', async () => {
        const { ch, rt } = await started({
            getSkills: () => [{ name: 'demo-skill', description: 'demo' }],
            invokeSkill: () => {
                throw new Error('boom');
            },
        });
        ch.hooks!.onMessage(invokeSkillRequest('i3', 'demo-skill'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(invokeAckOf(ch.nonfatalSends[0]!)).toEqual({
            requestId: 'i3',
            ok: false,
            reason: 'unavailable',
        });
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });

    it('acks unavailable when the host list throws', async () => {
        const { ch, rt } = await started({
            getSkills: () => {
                throw new Error('boom');
            },
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(invokeSkillRequest('i4', 'demo-skill'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(invokeAckOf(ch.nonfatalSends[0]!).reason).toBe('unavailable');
        rt.shutdown();
    });

    it('acks unknown-skill for an oversized name', async () => {
        const { ch, rt, sent } = await started({
            getSkills: () => [{ name: 'demo-skill', description: 'demo' }],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(
            invokeSkillRequest('i5', 'x'.repeat(MAX_SKILL_NAME_BYTES + 1)),
        );
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(invokeAckOf(ch.nonfatalSends[0]!).reason).toBe('unknown-skill');
        expect(sent).toEqual([]);
        rt.shutdown();
    });

    it('acks unavailable for a name that cannot address one skill', async () => {
        const { ch, rt, sent } = await started({
            getSkills: () => [{ name: 'demo skill', description: 'demo' }],
            invokeSkill: () => {},
        });
        ch.hooks!.onMessage(invokeSkillRequest('i7', 'demo skill'));
        expect(ch.nonfatalSends).toHaveLength(1);
        expect(invokeAckOf(ch.nonfatalSends[0]!).reason).toBe('unavailable');
        expect(sent).toEqual([]);
        rt.shutdown();
    });

    it('drops requests when skills were not negotiated', async () => {
        const { ch, rt } = await started({ getSkills: () => [] });
        ch.hooks!.onMessage(invokeSkillRequest('i6', 'demo-skill'));
        expect(ch.nonfatalSends).toHaveLength(0);
        expect(ch.closed).toBe(0);
        rt.shutdown();
    });
});

class StockEditor {
    history: string[] = [];
    calls: string[] = [];
    onSubmit = async (text: string): Promise<void> => {
        this.calls.push(text);
    };
}
// The adapter matches Pi's stock editor constructor name.
Object.defineProperty(StockEditor, 'name', { value: 'CustomEditor' });

function reloadUi(holder: { current: unknown }): unknown {
    return {
        getEditorComponent: () => undefined,
        setWidget: (
            _key: string,
            factory: ((tui: unknown, theme: unknown) => unknown) | undefined,
        ) => {
            if (factory !== undefined) {
                factory({ getFocusedComponent: () => holder.current }, {});
            }
        },
    };
}

interface ReloadFixture {
    ch: MockChannel;
    rt: Runtime;
    latch: ReloadLatchState;
    compact: CompactLatchState;
    holder: { current: unknown };
    editor: StockEditor;
}

async function startedReload(
    over: Partial<PiContextView> = {},
    latch?: ReloadLatchState,
    setup?: (editor: StockEditor) => void,
): Promise<ReloadFixture> {
    const editor = new StockEditor();
    setup?.(editor);
    const holder: { current: unknown } = { current: editor };
    const l = latch ?? freshReloadLatch();
    const compact = freshCompactLatch();
    const startCtx = telemetryCtx({ ui: reloadUi(holder), ...over });
    // Mirror the extension: capture the baseline at session_start,
    // before the runtime starts.
    captureNativeReloadBaseline(startCtx, l);
    const ch = mockChannel();
    const rt = new Runtime({
        creds: CREDS,
        generation: 1n,
        compactState: compact,
        reloadState: l,
        makeChannel: wired(ch),
    });
    rt.start(startCtx);
    await sleep(10);
    return { ch, rt, latch: l, compact, holder, editor };
}

function reloadRequest(
    id: string,
    over: {
        session?: string;
        leaf?: string;
        model?: { provider: string; model: string } | null;
        run?: bigint;
        context?: bigint;
        noCounters?: boolean;
    } = {},
): PhiToPi {
    return {
        paneId: 'pane',
        processId: 'proc',
        runtimeGeneration: 1n,
        payload: {
            $case: 'reloadRequest',
            value: {
                requestId: id,
                expectedSessionId: over.session ?? 'sess',
                expectedLeafId: over.leaf ?? 'leaf',
                expectedModel:
                    over.model === null
                        ? undefined
                        : (over.model ?? { provider: 'p', model: 'm' }),
                ...(over.noCounters
                    ? {}
                    : {
                          expectedRunId: over.run ?? 0n,
                          expectedContextRevision: over.context ?? 0n,
                      }),
            },
        },
    };
}

function reloadAckOf(msg: PiToPhi): {
    requestId: string;
    outcome: ReloadDispatchOutcome;
    reason: string;
} {
    const payload = payloadOf(msg);
    if (payload.$case !== 'reloadAck') {
        throw new Error(`not a reload ack: ${payload.$case}`);
    }
    return payload.value;
}

function reloadAcks(ch: MockChannel): Array<{
    requestId: string;
    outcome: ReloadDispatchOutcome;
    reason: string;
}> {
    return ch.nonfatalSends
        .filter((m) => payloadOf(m).$case === 'reloadAck')
        .map(reloadAckOf);
}

function reloadReadinessOf(
    msg: PiToPhi,
): NonNullable<StateSnapshot['reloadReadiness']> {
    const readiness = snapshotOf(msg).reloadReadiness;
    if (!readiness) throw new Error('missing reload readiness');
    return readiness;
}

function lastSnapshot(ch: MockChannel): PiToPhi {
    const snaps = ch.sends.filter(
        (m) => payloadOf(m).$case === 'stateSnapshot',
    );
    const last = snaps[snaps.length - 1];
    if (!last) throw new Error('no snapshot sent');
    return last;
}

describe('Runtime reload dispatch', () => {
    it('keeps the reload outcome vocabulary stable', () => {
        expect(ReloadDispatchOutcome.RELOAD_DISPATCH_OUTCOME_UNSPECIFIED).toBe(
            0,
        );
        expect(ReloadDispatchOutcome.RELOAD_DISPATCH_OUTCOME_DISPATCHED).toBe(
            1,
        );
        expect(ReloadDispatchOutcome.RELOAD_DISPATCH_OUTCOME_REFUSED).toBe(2);
    });

    it('advertises reload with the idle pair, without the compact API', async () => {
        const { ch, rt } = await startedReload({ compact: undefined });
        const hello = ch.hellos[0]!;
        const payload = payloadOf(hello);
        if (payload.$case !== 'hello') throw new Error('no hello sent');
        expect(payload.value.capabilities).toContain(CAPABILITY_RELOAD);
        expect(payload.value.capabilities).not.toContain(CAPABILITY_COMPACT);
        rt.shutdown();
    });

    it('omits reload without a captured baseline', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
            compactState: freshCompactLatch(),
            reloadState: freshReloadLatch(),
            makeChannel: wired(ch),
        });
        rt.start(telemetryCtx());
        await sleep(10);
        const payload = payloadOf(ch.hellos[0]!);
        if (payload.$case !== 'hello') throw new Error('no hello sent');
        expect(payload.value.capabilities).not.toContain(CAPABILITY_RELOAD);
        rt.shutdown();
    });

    it('dispatches idle, acks entry, and releases on settle', async () => {
        const { ch, rt, latch, editor } = await startedReload();
        ch.hooks!.onMessage(reloadRequest('1'));
        expect(editor.calls).toEqual(['/reload']);
        expect(latch.pending?.requestId).toBe('1');
        expect(reloadAcks(ch)).toEqual([
            {
                requestId: '1',
                outcome:
                    ReloadDispatchOutcome.RELOAD_DISPATCH_OUTCOME_DISPATCHED,
                reason: '',
            },
        ]);
        // A pending readiness frame precedes the receipt.
        const frames = ch.nonfatalSends.filter(
            (m) => payloadOf(m).$case === 'stateSnapshot',
        );
        expect(
            reloadReadinessOf(frames[frames.length - 1]!).reloadPending,
        ).toBe(true);
        await sleep(10);
        expect(latch.pending).toBeNull();
        // Release publishes readiness, never a second receipt.
        expect(reloadAcks(ch)).toHaveLength(1);
        expect(reloadReadinessOf(lastSnapshot(ch)).reloadPending).toBe(false);
        expect(reloadReadinessOf(lastSnapshot(ch)).highWater).toBe(1n);
        rt.shutdown();
    });

    it('accepts a new empty session with a null leaf', async () => {
        const { ch, rt, editor } = await startedReload({
            sessionManager: {
                getSessionId: () => 'sess',
                getLeafId: () => null,
            },
        });
        ch.hooks!.onMessage(reloadRequest('1', { leaf: '' }));
        expect(editor.calls).toEqual(['/reload']);
        expect(reloadAcks(ch)).toEqual([
            {
                requestId: '1',
                outcome:
                    ReloadDispatchOutcome.RELOAD_DISPATCH_OUTCOME_DISPATCHED,
                reason: '',
            },
        ]);
        rt.shutdown();
    });

    it('refuses stale identity and context fences', async () => {
        const { ch, rt, editor } = await startedReload();
        const cases: Array<[string, Parameters<typeof reloadRequest>[1]]> = [
            ['1', { session: 'other' }],
            ['2', { leaf: 'other' }],
            ['3', { model: { provider: 'p', model: 'other' } }],
            ['4', { run: 7n }],
            ['5', { context: 7n }],
            ['6', { noCounters: true }],
        ];
        for (const [id, over] of cases)
            ch.hooks!.onMessage(reloadRequest(id, over));
        expect(reloadAcks(ch).map((a) => a.reason)).toEqual([
            'stale',
            'stale',
            'stale',
            'stale',
            'stale',
            'stale',
        ]);
        expect(editor.calls).toEqual([]);
        rt.shutdown();
    });

    it('refuses busy, queued, and compaction-active states', async () => {
        const { ch, rt, editor } = await startedReload();
        rt.onSessionStart(telemetryCtx({ isIdle: () => false }));
        ch.hooks!.onMessage(reloadRequest('1'));
        rt.onSessionStart(telemetryCtx({ hasPendingMessages: () => true }));
        ch.hooks!.onMessage(reloadRequest('2'));
        rt.onSessionStart(telemetryCtx());
        rt.onCompactStart(telemetryCtx());
        ch.hooks!.onMessage(reloadRequest('3', { context: 1n }));
        expect(reloadAcks(ch).map((a) => a.reason)).toEqual([
            'busy',
            'queued',
            'compaction-active',
        ]);
        expect(editor.calls).toEqual([]);
        rt.shutdown();
    });

    it('refuses while a reload is pending, then dispatches after release', async () => {
        const { ch, rt, editor } = await startedReload();
        ch.hooks!.onMessage(reloadRequest('1'));
        ch.hooks!.onMessage(reloadRequest('2'));
        expect(reloadAcks(ch).map((a) => a.reason)).toEqual(['', 'pending']);
        await sleep(10);
        ch.hooks!.onMessage(reloadRequest('3'));
        expect(reloadAcks(ch).map((a) => a.reason)).toEqual([
            '',
            'pending',
            '',
        ]);
        expect(editor.calls).toEqual(['/reload', '/reload']);
        rt.shutdown();
    });

    it('excludes reload and compact in both directions', async () => {
        const { ch, rt, latch, compact, editor } = await startedReload();
        compact.pending = {
            requestId: 'c1',
            runtimeId: 'other',
            sessionId: 'sess',
            reported: false,
        };
        ch.hooks!.onMessage(reloadRequest('1'));
        expect(reloadAcks(ch).map((a) => a.reason)).toEqual(['pending']);
        compact.pending = null;
        ch.hooks!.onMessage(reloadRequest('2'));
        expect(editor.calls).toEqual(['/reload']);
        ch.hooks!.onMessage(compactRequest('9'));
        expect(results(ch).map((r) => r.reason)).toEqual(['pending']);
        expect(latch.pending?.requestId).toBe('2');
        rt.shutdown();
    });

    it('consumes refused IDs and drops malformed ones', async () => {
        const { ch, rt, editor } = await startedReload();
        ch.hooks!.onMessage(reloadRequest('1', { session: 'other' }));
        ch.hooks!.onMessage(reloadRequest('1'));
        ch.hooks!.onMessage(reloadRequest('not-an-id'));
        expect(reloadAcks(ch).map((a) => a.reason)).toEqual([
            'stale',
            'duplicate',
        ]);
        expect(editor.calls).toEqual([]);
        rt.shutdown();
    });

    it('refuses on selector focus and dispatches after restoration', async () => {
        const { ch, rt, latch, holder, editor } = await startedReload();
        holder.current = {
            onSubmit: async (text: string) => {
                editor.calls.push(`selector:${text}`);
            },
        };
        ch.hooks!.onMessage(reloadRequest('1'));
        expect(reloadAcks(ch).map((a) => a.reason)).toEqual(['unavailable']);
        expect(editor.calls).toEqual([]);
        expect(latch.pending).toBeNull();
        holder.current = editor;
        ch.hooks!.onMessage(reloadRequest('2'));
        expect(reloadAcks(ch).map((a) => a.reason)).toEqual([
            'unavailable',
            '',
        ]);
        expect(editor.calls).toEqual(['/reload']);
        rt.shutdown();
    });

    it('tracks the context fence across message, compact, and tree edges', async () => {
        const { ch, rt } = await startedReload();
        const baseline = ch.nonfatalSends.length;
        rt.onMessageStart(telemetryCtx(), 'assistant');
        expect(ch.nonfatalSends.length).toBe(baseline);
        rt.onMessageStart(telemetryCtx(), 'user');
        const userFrame = ch.nonfatalSends[ch.nonfatalSends.length - 1]!;
        expect(reloadReadinessOf(userFrame).contextRevision).toBe(1n);
        rt.onCompactStart(telemetryCtx());
        rt.onSessionTree(telemetryCtx());
        expect(reloadReadinessOf(lastSnapshot(ch)).contextRevision).toBe(3n);
        rt.shutdown();
    });

    it('publishes explicit zero counters and absent high-water', async () => {
        const { ch, rt } = await startedReload();
        const payload = payloadOf(ch.hellos[0]!);
        if (payload.$case !== 'hello') throw new Error('no hello sent');
        const readiness = payload.value.currentState?.reloadReadiness;
        expect(readiness?.runId).toBe(0n);
        expect(readiness?.contextRevision).toBe(0n);
        expect(readiness?.highWater).toBeUndefined();
        rt.shutdown();
    });

    it('releases through the replacement runtime after reload', async () => {
        let gate: (() => void) | null = null;
        const first = await startedReload({}, undefined, (editor) => {
            editor.onSubmit = async (text: string) => {
                editor.calls.push(text);
                await new Promise<void>((resolve) => {
                    gate = resolve;
                });
            };
        });
        first.ch.hooks!.onMessage(reloadRequest('1'));
        expect(first.latch.pending?.requestId).toBe('1');
        const ch2 = mockChannel();
        const rt2 = new Runtime({
            creds: CREDS,
            generation: 2n,
            compactState: freshCompactLatch(),
            reloadState: first.latch,
            makeChannel: wired(ch2),
        });
        rt2.start(telemetryCtx());
        await sleep(10);
        gate!();
        await sleep(10);
        expect(first.latch.pending).toBeNull();
        expect(reloadAcks(first.ch)).toHaveLength(1);
        expect(reloadReadinessOf(lastSnapshot(ch2)).reloadPending).toBe(false);
        expect(reloadReadinessOf(lastSnapshot(ch2)).highWater).toBe(1n);
        first.rt.shutdown();
        rt2.shutdown();
    });

    it('queues the receipt before draining on reentrant shutdown', async () => {
        let hook: (() => void) | null = null;
        const { ch, rt, latch, editor } = await startedReload(
            {},
            undefined,
            (e) => {
                e.onSubmit = async (text: string) => {
                    e.calls.push(text);
                    hook?.();
                };
            },
        );
        hook = () => rt.shutdown();
        ch.hooks!.onMessage(reloadRequest('1'));
        // Models Pi emitting session_shutdown from inside its native
        // callback. The receipt must enter the writer before draining.
        expect(editor.calls).toEqual(['/reload']);
        expect(reloadAcks(ch)).toEqual([
            {
                requestId: '1',
                outcome:
                    ReloadDispatchOutcome.RELOAD_DISPATCH_OUTCOME_DISPATCHED,
                reason: '',
            },
        ]);
        expect(ch.events.lastIndexOf('reload-ack')).toBeGreaterThanOrEqual(0);
        expect(ch.events.lastIndexOf('drain')).toBeGreaterThan(
            ch.events.lastIndexOf('reload-ack'),
        );
        expect(ch.drainCalls).toEqual([SHUTDOWN_DRAIN_MS]);
        expect(latch.pending?.requestId).toBe('1');
        await sleep(10);
        expect(latch.pending).toBeNull();
        rt.shutdown();
    });

    it('gates a replacement runtime until the reload receipt stream closes', async () => {
        const nativeGate: { finish?: () => void } = {};
        const first = await startedReload({}, undefined, (editor) => {
            editor.onSubmit = async (text: string) => {
                editor.calls.push(text);
                await new Promise<void>((resolve) => {
                    nativeGate.finish = resolve;
                });
            };
        });

        const drainGate: { finish?: () => void } = {};
        first.ch.drainAndClose = (timeoutMs: number) => {
            first.ch.drainCalls.push(timeoutMs);
            first.ch.events.push('drain');
            return new Promise<void>((resolve) => {
                drainGate.finish = resolve;
            });
        };
        first.ch.hooks!.onMessage(reloadRequest('1'));
        expect(reloadAcks(first.ch)).toHaveLength(1);
        // Models session_shutdown after the synchronous callback
        // entry window returned and the receipt was queued.
        first.rt.shutdown();
        expect(first.latch.drain).not.toBeNull();

        const secondCh = mockChannel();
        const second = new Runtime({
            creds: CREDS,
            generation: 2n,
            compactState: first.compact,
            reloadState: first.latch,
            makeChannel: wired(secondCh),
        });
        second.start(telemetryCtx({ ui: reloadUi(first.holder) }));
        await sleep(10);
        expect(secondCh.hellos).toHaveLength(0);

        drainGate.finish?.();
        await sleep(10);
        expect(secondCh.hellos).toHaveLength(1);
        expect(first.latch.drain).toBeNull();

        nativeGate.finish?.();
        await sleep(10);
        expect(first.latch.pending).toBeNull();
        second.shutdown();
    });
});
