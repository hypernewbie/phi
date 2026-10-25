import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
    ENV_PANE,
    ENV_PROCESS,
    ENV_TARGET,
    ENV_TOKEN,
    clearCredsFromEnv,
    createExtension,
    readCredsFromEnv,
    resetOwnerSlotForTest,
    type FactoryRuntime,
} from './extension.js';

const SAVED = { ...process.env };

function setEnv(): void {
    process.env[ENV_TARGET] = 'unix:/tmp/x.sock';
    process.env[ENV_PANE] = 'pane';
    process.env[ENV_PROCESS] = 'proc';
    process.env[ENV_TOKEN] = 'tok';
}

function mockPi(): {
    pi: ExtensionAPI;
    handlers: Map<string, (event: unknown, ctx: never) => unknown>;
} {
    const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
    const pi = {
        on: (
            event: string,
            handler: (event: unknown, ctx: never) => unknown,
        ) => {
            handlers.set(event, handler);
            return () => {
                handlers.delete(event);
            };
        },
    } as unknown as ExtensionAPI;
    return { pi, handlers };
}

function mockCtx(): ExtensionContext {
    return {
        sessionManager: { getSessionId: () => 'sess', getLeafId: () => 'leaf' },
        model: { provider: 'p', id: 'm' },
    } as unknown as ExtensionContext;
}

function mockCtxWithSession(sessionId: string): ExtensionContext {
    return {
        sessionManager: {
            getSessionId: () => sessionId,
            getLeafId: () => 'leaf',
        },
        model: { provider: 'p', id: 'm' },
    } as unknown as ExtensionContext;
}

function recordingRuntime(): { calls: string[]; runtime: FactoryRuntime } {
    const calls: string[] = [];
    return {
        calls,
        runtime: {
            start: () => calls.push('start'),
            onSessionStart: () => calls.push('session_start'),
            onAgentStart: () => calls.push('agent_start'),
            onAgentEnd: (stop) => calls.push(`agent_end:${stop}`),
            onAgentSettled: (_ctx, aborted) => calls.push(`settled:${aborted}`),
            onModelSelect: () => calls.push('model_select'),
            onThinkingLevelSelect: () => calls.push('thinking_level_select'),
            onSessionTree: () => calls.push('session_tree'),
            onCompactStart: () => calls.push('compact_start'),
            onCompactEnd: () => calls.push('compact_end'),
            shutdown: () => calls.push('shutdown'),
        },
    };
}

beforeEach(() => {
    resetOwnerSlotForTest();
    for (const key of [ENV_TARGET, ENV_PANE, ENV_PROCESS, ENV_TOKEN])
        delete process.env[key];
});

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in SAVED)) delete process.env[key];
    }
    Object.assign(process.env, SAVED);
    resetOwnerSlotForTest();
});

describe('credential environment', () => {
    it('reads complete credentials and rejects partial ones', () => {
        expect(readCredsFromEnv()).toBeNull();
        setEnv();
        expect(readCredsFromEnv()).toEqual({
            target: 'unix:/tmp/x.sock',
            pane: 'pane',
            process: 'proc',
            token: 'tok',
        });
        delete process.env[ENV_TOKEN];
        expect(readCredsFromEnv()).toBeNull();
    });

    it('clears all four keys', () => {
        setEnv();
        clearCredsFromEnv();
        expect(readCredsFromEnv()).toBeNull();
    });
});

describe('factory inertness', () => {
    it('registers nothing without credentials', () => {
        const { pi, handlers } = mockPi();
        createExtension(pi);
        expect(handlers.size).toBe(0);
    });

    it('registers lifecycle handlers with credentials', () => {
        setEnv();
        const { pi, handlers } = mockPi();
        createExtension(pi);
        expect([...handlers.keys()].sort()).toEqual([
            'agent_end',
            'agent_settled',
            'agent_start',
            'model_select',
            'session_before_compact',
            'session_compact',
            'session_compact_failed',
            'session_shutdown',
            'session_start',
            'session_tree',
            'thinking_level_select',
        ]);
    });
});

describe('settings disable', () => {
    // Real hosts: getSettings throws during factory load and works in
    // event handlers (M7 runtime probe, both pinned versions).
    function mockPiWithSettings(
        settings: unknown,
        opts: { throwInFactory?: boolean } = {},
    ): {
        pi: ExtensionAPI;
        handlers: Map<string, (event: unknown, ctx: never) => unknown>;
    } {
        const { pi, handlers } = mockPi();
        const surface = pi as unknown as Record<string, unknown>;
        type AnyOn = (
            event: string,
            handler: (event: unknown, ctx: never) => unknown,
        ) => () => void;
        let factoryTime = true;
        if (opts.throwInFactory) {
            const innerOn = surface['on'] as AnyOn;
            surface['on'] = (
                event: string,
                handler: (event: unknown, ctx: never) => unknown,
            ) => {
                // First handler registration ends factory time.
                factoryTime = false;
                return innerOn(event, handler);
            };
        } else {
            factoryTime = false;
        }
        surface['getSettings'] = () => {
            if (factoryTime) {
                throw new Error(
                    'Extension runtime not initialized. Action methods cannot be called during extension loading.',
                );
            }
            return settings;
        };
        return { pi, handlers };
    }

    it('scrubs credentials and stays inert when disabled', () => {
        setEnv();
        const { pi, handlers } = mockPiWithSettings(
            { phiBridge: { enabled: false } },
            { throwInFactory: true },
        );
        const rec = recordingRuntime();
        createExtension(pi, { makeRuntime: () => rec.runtime });
        // Factory registers handlers; the gate runs at session_start.
        expect(handlers.size).toBe(11);
        handlers.get('session_start')!({}, mockCtx() as never);
        expect(rec.calls).toEqual([]);
        expect(readCredsFromEnv()).toBeNull();
        // Later events stay inert.
        handlers.get('agent_start')!({}, mockCtx() as never);
        handlers.get('agent_settled')!(
            { type: 'agent_settled' },
            mockCtx() as never,
        );
        expect(rec.calls).toEqual([]);
    });

    it('disables a previously claimed runtime on session replacement', () => {
        setEnv();
        let settings: unknown = {};
        const { pi, handlers } = mockPi();
        (pi as unknown as Record<string, unknown>)['getSettings'] = () =>
            settings;
        const rec = recordingRuntime();
        createExtension(pi, { makeRuntime: () => rec.runtime });
        handlers.get('session_start')!({}, mockCtxWithSession('s1') as never);
        expect(rec.calls).toEqual(['start']);
        // Replacement session with the disable now visible: the
        // claimed runtime is shut down and credentials are scrubbed.
        settings = { phiBridge: { enabled: false } };
        handlers.get('session_start')!({}, mockCtxWithSession('s2') as never);
        expect(rec.calls).toEqual(['start', 'shutdown']);
        expect(readCredsFromEnv()).toBeNull();
    });

    it('starts when enabled, missing, or unreadable', () => {
        for (const settings of [
            { phiBridge: { enabled: true } },
            {},
            { phiBridge: {} },
            { phiBridge: null },
            null,
        ]) {
            resetOwnerSlotForTest();
            setEnv();
            const { pi, handlers } = mockPiWithSettings(settings);
            const rec = recordingRuntime();
            createExtension(pi, { makeRuntime: () => rec.runtime });
            handlers.get('session_start')!({}, mockCtx() as never);
            expect(rec.calls).toEqual(['start']);
        }
        resetOwnerSlotForTest();
        setEnv();
        const { pi, handlers } = mockPi();
        (pi as unknown as Record<string, unknown>)['getSettings'] = () => {
            throw new Error('boom');
        };
        const rec = recordingRuntime();
        createExtension(pi, { makeRuntime: () => rec.runtime });
        handlers.get('session_start')!({}, mockCtx() as never);
        expect(rec.calls).toEqual(['start']);
    });
});

describe('owner guard', () => {
    it('first claimant owns; duplicate stays inert', () => {
        setEnv();
        const first = mockPi();
        const second = mockPi();
        const rec1 = recordingRuntime();
        const rec2 = recordingRuntime();
        createExtension(first.pi, { makeRuntime: () => rec1.runtime });
        createExtension(second.pi, { makeRuntime: () => rec2.runtime });
        const ctx = mockCtx();
        first.handlers.get('session_start')!({}, ctx as never);
        second.handlers.get('session_start')!({}, ctx as never);
        expect(rec1.calls).toEqual(['start']);
        expect(rec2.calls).toEqual([]);
        // Only the owner forwards events.
        first.handlers.get('agent_start')!({}, ctx as never);
        second.handlers.get('agent_start')!({}, ctx as never);
        first.handlers.get('thinking_level_select')!({}, ctx as never);
        second.handlers.get('thinking_level_select')!({}, ctx as never);
        expect(rec1.calls).toEqual([
            'start',
            'agent_start',
            'thinking_level_select',
        ]);
        expect(rec2.calls).toEqual([]);
        // Only the owner releases on shutdown.
        second.handlers.get('session_shutdown')!({}, ctx as never);
        first.handlers.get('agent_settled')!(
            { type: 'agent_settled' },
            ctx as never,
        );
        expect(rec1.calls).toContain('settled:false');
    });

    it('stashes credentials, clears env, and reloads from the stash', () => {
        setEnv();
        const first = mockPi();
        const rec1 = recordingRuntime();
        createExtension(first.pi, { makeRuntime: () => rec1.runtime });
        const ctx = mockCtx();
        first.handlers.get('session_start')!({}, ctx as never);
        expect(process.env[ENV_TOKEN]).toBeUndefined();
        expect(readCredsFromEnv()).toBeNull();
        first.handlers.get('session_shutdown')!({}, ctx as never);
        expect(rec1.calls).toEqual(['start', 'shutdown']);
        // Reload: no env remains, but the stash provisions a fresh runtime.
        const reloaded = mockPi();
        const rec2 = recordingRuntime();
        createExtension(reloaded.pi, { makeRuntime: () => rec2.runtime });
        expect(reloaded.handlers.size).toBe(11);
        reloaded.handlers.get('session_start')!({}, ctx as never);
        expect(rec2.calls).toEqual(['start']);
    });

    it('forwards the settled abort bit', () => {
        setEnv();
        const { pi, handlers } = mockPi();
        const rec = recordingRuntime();
        createExtension(pi, { makeRuntime: () => rec.runtime });
        const ctx = mockCtx();
        handlers.get('session_start')!({}, ctx as never);
        handlers.get('agent_settled')!(
            { type: 'agent_settled', aborted: true },
            ctx as never,
        );
        handlers.get('agent_settled')!({ type: 'agent_settled' }, ctx as never);
        expect(rec.calls).toEqual(['start', 'settled:true', 'settled:false']);
    });

    it('forwards the final assistant stop reason from agent_end', () => {
        setEnv();
        const { pi, handlers } = mockPi();
        const rec = recordingRuntime();
        createExtension(pi, { makeRuntime: () => rec.runtime });
        const ctx = mockCtx();
        handlers.get('session_start')!({}, ctx as never);
        handlers.get('agent_end')!(
            {
                type: 'agent_end',
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: [], stopReason: 'stop' },
                    { role: 'assistant', content: [], stopReason: 'error' },
                ],
            },
            ctx as never,
        );
        handlers.get('agent_end')!(
            { type: 'agent_end', messages: [{ role: 'user' }] },
            ctx as never,
        );
        handlers.get('agent_end')!({ type: 'agent_end' }, ctx as never);
        expect(rec.calls).toEqual([
            'start',
            'agent_end:error',
            'agent_end:null',
            'agent_end:null',
        ]);
    });

    it('retires the runtime on session replacement with a new generation', () => {
        setEnv();
        const { pi, handlers } = mockPi();
        const generations: bigint[] = [];
        const runtimes: FactoryRuntime[] = [];
        const rec = recordingRuntime();
        createExtension(pi, {
            makeRuntime: (_c, g) => {
                generations.push(g);
                const r = recordingRuntime();
                runtimes.push(r.runtime);
                return r.runtime;
            },
        });
        void rec;
        handlers.get('session_start')!(
            {},
            mockCtxWithSession('sess-a') as never,
        );
        handlers.get('session_start')!(
            {},
            mockCtxWithSession('sess-b') as never,
        );
        expect(generations).toEqual([1n, 2n]);
        expect(runtimes).toHaveLength(2);
    });

    it('refreshes the view on a duplicate session announcement', () => {
        setEnv();
        const { pi, handlers } = mockPi();
        const generations: bigint[] = [];
        createExtension(pi, {
            makeRuntime: (_c, g) => {
                generations.push(g);
                return recordingRuntime().runtime;
            },
        });
        const ctx = mockCtxWithSession('sess-a');
        handlers.get('session_start')!({}, ctx as never);
        handlers.get('session_start')!({}, ctx as never);
        expect(generations).toEqual([1n]);
    });
});
