import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    ExtensionAPI,
    ExtensionCommandContext,
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
import type { ReloadCommand } from './runtime.js';

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

function mockPiWithReload(): {
    pi: ExtensionAPI;
    handlers: Map<string, (event: unknown, ctx: never) => unknown>;
    commands: Array<{
        name: string;
        source: string;
        sourceInfo: { path: string };
    }>;
    commandHandlers: Map<
        string,
        (args: string, ctx: ExtensionCommandContext) => Promise<void>
    >;
    sendUserMessage: ReturnType<typeof vi.fn>;
} {
    const { pi, handlers } = mockPi();
    const commands: Array<{
        name: string;
        source: string;
        sourceInfo: { path: string };
    }> = [];
    const commandHandlers = new Map<
        string,
        (args: string, ctx: ExtensionCommandContext) => Promise<void>
    >();
    const sendUserMessage = vi.fn();
    Object.assign(pi, {
        registerCommand: (
            name: string,
            options: {
                handler: (
                    args: string,
                    ctx: ExtensionCommandContext,
                ) => Promise<void>;
            },
        ) => {
            commandHandlers.set(name, options.handler);
            commands.push({
                name,
                source: 'extension',
                sourceInfo: {
                    path: '/tmp/pi-phi-extension.cjs',
                },
            });
        },
        getCommands: () => commands,
        sendUserMessage,
    });
    return { pi, handlers, commands, commandHandlers, sendUserMessage };
}

/**
 * Two extension hosts sharing one Pi command registry. Models pinned
 * Pi 1.0.1: each loaded copy keeps its own commands, the runner
 * aggregates them in load order, duplicate names become name:1/name:2,
 * and getCommands reports the invocation name as the command name
 * (dist/core/extensions/runner.js resolveRegisteredCommands,
 * dist/core/agent-session.js getCommands). The per-name occurrence
 * suffixing is the behavior that matters here; Pi's extra
 * taken-name collision pass has no trigger in this suite.
 */
function mockPiPairWithSharedRegistry(): {
    first: {
        pi: ExtensionAPI;
        handlers: Map<string, (event: unknown, ctx: never) => unknown>;
        sendUserMessage: ReturnType<typeof vi.fn>;
    };
    second: {
        pi: ExtensionAPI;
        handlers: Map<string, (event: unknown, ctx: never) => unknown>;
        sendUserMessage: ReturnType<typeof vi.fn>;
    };
    registered: Array<{
        name: string;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }>;
} {
    const registered: Array<{
        name: string;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }> = [];
    const resolveCommands = (): Array<{
        name: string;
        source: string;
        sourceInfo: { path: string };
    }> => {
        const counts = new Map<string, number>();
        for (const entry of registered)
            counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
        const seen = new Map<string, number>();
        return registered.map((entry) => {
            const occurrence = (seen.get(entry.name) ?? 0) + 1;
            seen.set(entry.name, occurrence);
            const invocationName =
                (counts.get(entry.name) ?? 0) > 1
                    ? `${entry.name}:${occurrence}`
                    : entry.name;
            return {
                name: invocationName,
                source: 'extension',
                sourceInfo: {
                    path: '/tmp/pi-phi-extension.cjs',
                },
            };
        });
    };
    const side = (): {
        pi: ExtensionAPI;
        handlers: Map<string, (event: unknown, ctx: never) => unknown>;
        sendUserMessage: ReturnType<typeof vi.fn>;
    } => {
        const { pi, handlers } = mockPi();
        const sendUserMessage = vi.fn();
        Object.assign(pi, {
            registerCommand: (
                name: string,
                options: {
                    handler: (
                        args: string,
                        ctx: ExtensionCommandContext,
                    ) => Promise<void>;
                },
            ) => {
                registered.push({ name, handler: options.handler });
            },
            getCommands: resolveCommands,
            sendUserMessage,
        });
        return { pi, handlers, sendUserMessage };
    };
    return { first: side(), second: side(), registered };
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
        ]);
    });
});

describe('native reload command', () => {
    it('advertises only an owned command and dispatches with expansion enabled', async () => {
        setEnv();
        const { pi, handlers, commands, commandHandlers, sendUserMessage } =
            mockPiWithReload();
        let reloadCommand: ReloadCommand | undefined;
        createExtension(pi, {
            makeRuntime: (_creds, _generation, reload) => {
                reloadCommand = reload;
                return recordingRuntime().runtime;
            },
        });
        // Only the claimed owner registers: nothing at factory time.
        expect(commands).toEqual([]);
        expect(reloadCommand).toBeUndefined();
        handlers.get('session_start')!({}, mockCtx() as never);
        expect(commands.map((command) => command.name)).toEqual([
            'phi-bridge-reload',
        ]);
        expect(reloadCommand?.isAvailable()).toBe(true);
        expect(reloadCommand?.dispatch()).toBe(true);
        expect(sendUserMessage).toHaveBeenCalledWith('/phi-bridge-reload', {
            expandPromptTemplates: true,
        });

        const reload = vi.fn(async () => {});
        await commandHandlers.get('phi-bridge-reload')!('', {
            ...mockCtx(),
            reload,
        } as unknown as ExtensionCommandContext);
        expect(reload).toHaveBeenCalledOnce();

        commands.length = 0;
        expect(reloadCommand?.isAvailable()).toBe(false);
        expect(reloadCommand?.dispatch()).toBe(false);
        expect(sendUserMessage).toHaveBeenCalledOnce();
        await commandHandlers.get('phi-bridge-reload')!('', {
            ...mockCtx(),
            reload,
        } as unknown as ExtensionCommandContext);
        expect(reload).toHaveBeenCalledOnce();
    });

    it('does not register or advertise reload when host APIs are missing', () => {
        setEnv();
        const { pi, handlers } = mockPi();
        let reloadCommand: ReloadCommand | undefined;
        createExtension(pi, {
            makeRuntime: (_creds, _generation, reload) => {
                reloadCommand = reload;
                return recordingRuntime().runtime;
            },
        });
        handlers.get('session_start')!({}, mockCtx() as never);
        expect(reloadCommand?.isAvailable()).toBe(false);
    });

    it('shared registry models Pi duplicate renaming', () => {
        const pair = mockPiPairWithSharedRegistry();
        const noop = async (): Promise<void> => {};
        interface ReloadSurface {
            registerCommand(
                name: string,
                options: { handler: typeof noop },
            ): void;
            getCommands(): Array<{ name: string }>;
        }
        const first = pair.first.pi as unknown as ReloadSurface;
        const second = pair.second.pi as unknown as ReloadSurface;
        first.registerCommand('phi-bridge-reload', { handler: noop });
        second.registerCommand('phi-bridge-reload', { handler: noop });
        expect(second.getCommands().map((command) => command.name)).toEqual([
            'phi-bridge-reload:1',
            'phi-bridge-reload:2',
        ]);
    });

    it('duplicate loads keep one unsuffixed owned command', async () => {
        setEnv();
        const pair = mockPiPairWithSharedRegistry();
        let firstReload: ReloadCommand | undefined;
        let secondReload: ReloadCommand | undefined;
        createExtension(pair.first.pi, {
            makeRuntime: (_creds, _generation, reload) => {
                firstReload = reload;
                return recordingRuntime().runtime;
            },
        });
        createExtension(pair.second.pi, {
            makeRuntime: (_creds, _generation, reload) => {
                secondReload = reload;
                return recordingRuntime().runtime;
            },
        });
        // Neither copy registers before ownership is resolved.
        expect(pair.registered).toEqual([]);
        pair.first.handlers.get('session_start')!({}, mockCtx() as never);
        pair.second.handlers.get('session_start')!({}, mockCtx() as never);
        // Only the claimed owner registered, so Pi leaves the name
        // unsuffixed and the owned command stays available.
        expect(pair.registered.map((entry) => entry.name)).toEqual([
            'phi-bridge-reload',
        ]);
        expect(secondReload).toBeUndefined();
        expect(firstReload?.isAvailable()).toBe(true);
        expect(firstReload?.dispatch()).toBe(true);
        expect(pair.first.sendUserMessage).toHaveBeenCalledWith(
            '/phi-bridge-reload',
            { expandPromptTemplates: true },
        );
        expect(pair.second.sendUserMessage).not.toHaveBeenCalled();
        const reload = vi.fn(async () => {});
        await pair.registered[0]!.handler('', {
            ...mockCtx(),
            reload,
        } as unknown as ExtensionCommandContext);
        expect(reload).toHaveBeenCalledOnce();
    });

    it('dispatch refusal never throws into the stream handler', () => {
        setEnv();
        const { pi, handlers, sendUserMessage } = mockPiWithReload();
        sendUserMessage.mockImplementation(() => {
            throw new Error('host rejected');
        });
        let reloadCommand: ReloadCommand | undefined;
        createExtension(pi, {
            makeRuntime: (_creds, _generation, reload) => {
                reloadCommand = reload;
                return recordingRuntime().runtime;
            },
        });
        handlers.get('session_start')!({}, mockCtx() as never);
        expect(reloadCommand?.isAvailable()).toBe(true);
        let result: boolean | undefined;
        expect(() => {
            result = reloadCommand?.dispatch();
        }).not.toThrow();
        expect(result).toBe(false);
        // One attempt, no retry: the PTY fallback owns recovery.
        expect(sendUserMessage).toHaveBeenCalledTimes(1);
        expect(sendUserMessage).toHaveBeenCalledWith('/phi-bridge-reload', {
            expandPromptTemplates: true,
        });
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
        expect(handlers.size).toBe(10);
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

    it('revokes the reload capability when the disable becomes visible', () => {
        setEnv();
        let settings: unknown = {};
        const { pi, handlers, sendUserMessage } = mockPiWithReload();
        (pi as unknown as Record<string, unknown>)['getSettings'] = () =>
            settings;
        const rec = recordingRuntime();
        let reload: ReloadCommand | undefined;
        createExtension(pi, {
            makeRuntime: (_creds, _generation, reloadCommand) => {
                reload = reloadCommand;
                return rec.runtime;
            },
        });
        handlers.get('session_start')!({}, mockCtxWithSession('s1') as never);
        expect(reload?.isAvailable()).toBe(true);
        expect(reload?.dispatch()).toBe(true);
        sendUserMessage.mockClear();
        settings = { phiBridge: { enabled: false } };
        handlers.get('session_start')!({}, mockCtxWithSession('s2') as never);
        // The command stays registered in Pi, but the disabled runtime
        // must neither advertise nor dispatch the capability.
        expect(reload?.isAvailable()).toBe(false);
        expect(reload?.dispatch()).toBe(false);
        expect(sendUserMessage).not.toHaveBeenCalled();
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
        expect(rec1.calls).toEqual(['start', 'agent_start']);
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
        expect(reloaded.handlers.size).toBe(10);
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
