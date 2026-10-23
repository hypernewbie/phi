import { describe, expect, it } from 'vitest';
import type { ServiceError } from '@grpc/grpc-js';
import {
    type AgentSettled,
    LogicalState,
    type PhiToPi,
    PiToPhi,
    RunOutcome,
} from './gen/bridge.js';
import { LIFECYCLE_HEADROOM_BYTES } from './protocol.js';
import { CAPABILITY_HISTORY, CAPABILITY_LIFECYCLE } from './protocol.js';
import { CAPABILITY_MODELS } from './protocol.js';
import { MAX_MODELS_ENTRIES } from './protocol.js';
import { InvalidTargetError } from './endpoint.js';
import type { ChannelCreds, ChannelHooks } from './channel.js';
import { type PiContextView, Runtime, type RuntimeChannel } from './runtime.js';
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
            return m.nonfatalResult;
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

describe('Runtime lifecycle headroom', () => {
    it('keeps even a full-journal snapshot under the headroom', async () => {
        const ch = mockChannel();
        const rt = new Runtime({
            creds: CREDS,
            generation: 1n,
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

    it.each([null, 1, 14])(
        'ignores stale channel callbacks after reconnect (status %s)',
        async (code) => {
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
