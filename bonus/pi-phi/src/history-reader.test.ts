import { describe, expect, it } from 'vitest';
import {
    isHistoryReaderAvailable,
    readEditorHistory,
} from './history-reader.js';

interface Calls {
    keys: Array<{ key: string; cleared: boolean }>;
    placements: Array<string | undefined>;
}

function callsOf(): Calls {
    return { keys: [], placements: [] };
}

/** Interactive-like host: invokes the factory synchronously, like setExtensionWidget. */
function interactiveUi(focused: unknown, calls: Calls): unknown {
    const tui = { getFocusedComponent: () => focused };
    return {
        setWidget: (
            key: string,
            factory: ((tui: unknown, theme: unknown) => unknown) | undefined,
            options?: { placement?: string },
        ) => {
            calls.keys.push({ key, cleared: factory === undefined });
            calls.placements.push(options?.placement);
            if (factory !== undefined) factory(tui, {});
        },
    };
}

/** Print-like host: setWidget is a no-op, the factory never runs. */
function printUi(): unknown {
    return { setWidget: () => {} };
}

/** RPC-like host: factory content is ignored. */
function rpcUi(): unknown {
    return {
        setWidget: (_key: string, factory: unknown) => {
            if (factory !== undefined && !Array.isArray(factory)) return;
        },
    };
}

describe('readEditorHistory', () => {
    it('copies the focused editor history newest-first', () => {
        const calls = callsOf();
        const history = ['newest', 'older'];
        const out = readEditorHistory(interactiveUi({ history }, calls));
        expect(out).toEqual(['newest', 'older']);
        expect(out).not.toBe(history);
    });

    it('reports an empty history as available', () => {
        const calls = callsOf();
        expect(
            readEditorHistory(interactiveUi({ history: [] }, calls)),
        ).toEqual([]);
        expect(
            isHistoryReaderAvailable(interactiveUi({ history: [] }, calls)),
        ).toBe(true);
    });

    it('probes below the editor and removes the probe synchronously', () => {
        const calls = callsOf();
        readEditorHistory(interactiveUi({ history: ['a'] }, calls));
        expect(calls.placements).toEqual(['belowEditor', undefined]);
        expect(calls.keys).toHaveLength(2);
        expect(calls.keys[0]!.cleared).toBe(false);
        expect(calls.keys[1]).toEqual({
            key: calls.keys[0]!.key,
            cleared: true,
        });
    });

    it('returns a zero-height component from the probe factory', () => {
        let rendered: unknown = null;
        const ui = {
            setWidget: (
                _key: string,
                factory:
                    | ((tui: unknown, theme: unknown) => unknown)
                    | undefined,
            ) => {
                if (factory !== undefined) {
                    rendered = factory({}, {});
                }
            },
        };
        readEditorHistory(ui);
        expect(typeof rendered === 'object' && rendered !== null).toBe(true);
        const render = (rendered as { render?: unknown }).render;
        expect(typeof render).toBe('function');
        expect((render as (width: number) => string[])(80)).toEqual([]);
    });

    it('reports unavailable when the factory never runs', () => {
        expect(readEditorHistory(printUi())).toBeNull();
        expect(readEditorHistory(rpcUi())).toBeNull();
        expect(isHistoryReaderAvailable(printUi())).toBe(false);
    });

    it('reports unavailable without throwing on hostile shapes', () => {
        const throwing = {
            setWidget: () => {
                throw new Error('boom');
            },
        };
        const throwingClear = (() => {
            let n = 0;
            return {
                setWidget: (
                    _key: string,
                    factory:
                        | ((tui: unknown, theme: unknown) => unknown)
                        | undefined,
                ) => {
                    n += 1;
                    if (n === 1 && factory !== undefined) factory({}, {});
                    else throw new Error('clear boom');
                },
            };
        })();
        const cases: unknown[] = [
            undefined,
            null,
            42,
            'ui',
            {},
            { setWidget: 'nope' },
            throwing,
            throwingClear,
            interactiveUi(null, callsOf()),
            interactiveUi({}, callsOf()),
            interactiveUi({ history: 'nope' }, callsOf()),
            interactiveUi({ history: ['ok', 7] }, callsOf()),
            interactiveUi({ history: [null] }, callsOf()),
        ];
        for (const ui of cases) {
            expect(readEditorHistory(ui)).toBeNull();
        }
    });

    it('reports unavailable when focus lookup throws', () => {
        const ui = {
            setWidget: (
                _key: string,
                factory:
                    | ((tui: unknown, theme: unknown) => unknown)
                    | undefined,
            ) => {
                if (factory === undefined) return;
                factory(
                    {
                        getFocusedComponent: () => {
                            throw new Error('focus boom');
                        },
                    },
                    {},
                );
            },
        };
        expect(readEditorHistory(ui)).toBeNull();
    });

    it('reports unavailable when the TUI has no focus accessor', () => {
        const calls = callsOf();
        const ui = {
            setWidget: (
                key: string,
                factory:
                    | ((tui: unknown, theme: unknown) => unknown)
                    | undefined,
                options?: { placement?: string },
            ) => {
                calls.keys.push({ key, cleared: factory === undefined });
                calls.placements.push(options?.placement);
                if (factory !== undefined) factory({}, {});
            },
        };
        expect(readEditorHistory(ui)).toBeNull();
        // The probe is still removed.
        expect(calls.keys).toHaveLength(2);
        expect(calls.keys[1]!.cleared).toBe(true);
    });
});
