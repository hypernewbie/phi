import { describe, expect, it, vi } from 'vitest';
import {
    invokeTerminalRefresh,
    isTerminalRefreshAvailable,
    readRefreshTui,
} from './terminal-refresh.js';
import { captureFocusedComponent, captureLiveTui } from './tui-probe.js';

/** Live TUI surface: setWidget exposes the TUI object to the probe. */
function tuiUi(tui: object): unknown {
    return {
        setWidget: (
            _key: string,
            factory: ((tui: unknown, theme: unknown) => unknown) | undefined,
        ) => {
            if (factory !== undefined) factory(tui, {});
        },
    };
}

function recordingTui(over: Record<string, unknown> = {}): {
    tui: Record<string, unknown>;
    calls: string[];
    receiver: unknown[];
} {
    const calls: string[] = [];
    const receiver: unknown[] = [];
    const tui: Record<string, unknown> = {
        stop: function (this: unknown, options: unknown) {
            receiver.push(this);
            calls.push(`stop:${JSON.stringify(options)}`);
        },
        start: function (this: unknown) {
            receiver.push(this);
            calls.push('start');
        },
        requestRender: function (this: unknown, force: unknown) {
            receiver.push(this);
            calls.push(`requestRender:${String(force)}`);
        },
        ...over,
    };
    return { tui, calls, receiver };
}

describe('terminal refresh probe', () => {
    it('reads a TUI exposing the repaint lifecycle', () => {
        const { tui } = recordingTui();
        const read = readRefreshTui(tuiUi(tui));
        expect(read).not.toBeNull();
        expect(isTerminalRefreshAvailable(tuiUi(tui))).toBe(true);
    });

    it('omits the capability when any repaint method is missing', () => {
        for (const missing of ['stop', 'start', 'requestRender']) {
            const { tui } = recordingTui();
            delete tui[missing];
            expect(readRefreshTui(tuiUi(tui))).toBeNull();
            expect(isTerminalRefreshAvailable(tuiUi(tui))).toBe(false);
        }
    });

    it('omits the capability for print and non-object surfaces', () => {
        // Print/RPC hosts expose no widget host, so the factory never runs.
        expect(readRefreshTui({ setWidget: () => {} })).toBeNull();
        expect(readRefreshTui(undefined)).toBeNull();
        expect(readRefreshTui('ui')).toBeNull();
        expect(
            readRefreshTui({
                setWidget: () => {
                    throw new Error('unsupported');
                },
            }),
        ).toBeNull();
    });

    it('always removes the probe widget', () => {
        const keys: string[] = [];
        const ui = {
            setWidget: (
                key: string,
                factory:
                    | ((tui: unknown, theme: unknown) => unknown)
                    | undefined,
            ) => {
                keys.push(`${key}:${factory === undefined ? 'clear' : 'set'}`);
                if (factory !== undefined) factory(recordingTui().tui, {});
            },
        };
        captureLiveTui(ui, 'probe');
        captureFocusedComponent(ui, 'probe');
        expect(keys).toEqual([
            'probe:set',
            'probe:clear',
            'probe:set',
            'probe:clear',
        ]);
    });
});

describe('terminal refresh dispatch', () => {
    it('runs stop, start, and a forced render in order on the TUI receiver', () => {
        const { tui, calls, receiver } = recordingTui();
        const read = readRefreshTui(tuiUi(tui));
        if (!read) throw new Error('TUI not read');
        expect(invokeTerminalRefresh(read)).toBe(true);
        expect(calls).toEqual([
            'stop:{"preserveScreen":true}',
            'start',
            'requestRender:true',
        ]);
        // Method receivers must stay the TUI object, never the adapter.
        expect(receiver).toEqual([tui, tui, tui]);
    });

    it('repairs the renderer once when the restart fails after stop', () => {
        let started = 0;
        const { tui, calls } = recordingTui({
            start: () => {
                started += 1;
                if (started === 1) throw new Error('start failed');
                calls.push('start');
            },
            requestRender: () => {
                calls.push('requestRender');
            },
        });
        const read = readRefreshTui(tuiUi(tui));
        if (!read) throw new Error('TUI not read');
        expect(invokeTerminalRefresh(read)).toBe(false);
        expect(calls).toEqual([
            'stop:{"preserveScreen":true}',
            'start',
            'requestRender',
        ]);
    });

    it('repairs a renderer when stop throws after disabling input', () => {
        let acceptsInput = true;
        const start = vi.fn(() => {
            acceptsInput = true;
        });
        const requestRender = vi.fn();
        const { tui } = recordingTui({
            stop: () => {
                acceptsInput = false;
                throw new Error('terminal cleanup failed');
            },
            start,
            requestRender,
        });
        const read = readRefreshTui(tuiUi(tui));
        if (!read) throw new Error('TUI not read');
        expect(invokeTerminalRefresh(read)).toBe(false);
        expect(acceptsInput).toBe(true);
        expect(start).toHaveBeenCalledTimes(1);
        expect(requestRender).toHaveBeenCalledExactlyOnceWith(true);
    });
});
