import { beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
    captureNativeReloadBaseline,
    freshReloadLatch,
    invokeNativeReload,
    nativeReloadAvailable,
} from './native-reload.js';

function fixture() {
    const calls: string[] = [];
    class CustomEditor {
        history: unknown = ['kept history'];
        text = 'kept draft';
        onSubmit: (text: string) => Promise<void> = async (text) => {
            calls.push(text);
        };
    }
    const editor = new CustomEditor();
    const state: {
        editor: unknown;
        factory: unknown;
        widget: boolean;
        noTui: boolean;
        widgetThrows: boolean;
        focusThrows: boolean;
    } = {
        editor,
        factory: undefined,
        widget: false,
        noTui: false,
        widgetThrows: false,
        focusThrows: false,
    };
    const tui = {
        getFocusedComponent() {
            if (state.focusThrows) throw new Error('focus unavailable');
            return state.editor;
        },
    };
    const ctx = {
        ui: {
            getEditorComponent: () => state.factory,
            setWidget: (
                _key: string,
                factory:
                    | ((tui: unknown, theme: unknown) => unknown)
                    | undefined,
            ) => {
                state.widget = factory !== undefined;
                if (factory === undefined) return;
                if (state.widgetThrows) throw new Error('widget unavailable');
                if (!state.noTui) factory(tui, {});
            },
        },
    } as unknown as ExtensionContext;
    return { calls, editor, state, ctx, CustomEditor };
}

function capture(f: ReturnType<typeof fixture>) {
    const state = freshReloadLatch();
    expect(captureNativeReloadBaseline(f.ctx, state)).toBe(true);
    return state;
}

beforeEach(() => {});

describe('native Pi reload adapter', () => {
    it('requires an owning session-start baseline before requests', () => {
        const f = fixture();
        const state = freshReloadLatch();
        expect(nativeReloadAvailable(f.ctx, state)).toBe(false);
        expect(invokeNativeReload(f.ctx, state)).toEqual({ entered: false });
        expect(f.calls).toEqual([]);
    });

    it('captures an empty history and submits only the fixed native command', async () => {
        const f = fixture();
        f.editor.history = [];
        const state = capture(f);
        expect(nativeReloadAvailable(f.ctx, state)).toBe(true);
        const attempt = invokeNativeReload(f.ctx, state);
        expect(attempt.entered).toBe(true);
        if (attempt.entered) await attempt.completion;
        expect(f.calls).toEqual(['/reload']);
    });

    it('does not replace the captured editor or callback', () => {
        const f = fixture();
        const state = capture(f);
        const baseline = state.baseline;
        f.editor.onSubmit = async (text) => {
            f.calls.push(`foreign:${text}`);
        };
        expect(captureNativeReloadBaseline(f.ctx, state)).toBe(true);
        expect(state.baseline).toBe(baseline);
        expect(nativeReloadAvailable(f.ctx, state)).toBe(false);
        expect(invokeNativeReload(f.ctx, state)).toEqual({ entered: false });
        expect(f.calls).toEqual([]);
    });

    it('refuses a different editor with the same runtime shape', () => {
        const f = fixture();
        const state = capture(f);
        f.state.editor = new f.CustomEditor();
        expect(nativeReloadAvailable(f.ctx, state)).toBe(false);
        expect(invokeNativeReload(f.ctx, state)).toEqual({ entered: false });
        expect(f.calls).toEqual([]);
    });

    it('refuses a configured custom editor factory', () => {
        const f = fixture();
        const state = capture(f);
        f.state.factory = () => f.editor;
        expect(nativeReloadAvailable(f.ctx, state)).toBe(false);
        expect(invokeNativeReload(f.ctx, state)).toEqual({ entered: false });
        expect(f.calls).toEqual([]);
    });

    it('refuses selectors without invoking their callback', () => {
        const f = fixture();
        const state = capture(f);
        f.state.editor = {
            onSubmit: async (text: string) => f.calls.push(`selector:${text}`),
        };
        expect(invokeNativeReload(f.ctx, state)).toEqual({ entered: false });
        expect(f.calls).toEqual([]);
        expect(f.state.widget).toBe(false);
    });

    it.each([
        [
            'synchronous startup callback',
            (f: ReturnType<typeof fixture>) => {
                f.editor.onSubmit = (text) => {
                    f.calls.push(text);
                    return undefined as never;
                };
                return false;
            },
        ],
        [
            'null editor',
            (f: ReturnType<typeof fixture>) => {
                f.state.editor = null;
                return true;
            },
        ],
        [
            'wrong editor constructor',
            (f: ReturnType<typeof fixture>) => {
                f.state.editor = { ...f.editor };
                return true;
            },
        ],
        [
            'malformed history',
            (f: ReturnType<typeof fixture>) => {
                f.editor.history = ['ok', 7];
                return true;
            },
        ],
        [
            'missing history',
            (f: ReturnType<typeof fixture>) => {
                delete (f.editor as unknown as Record<string, unknown>).history;
                return true;
            },
        ],
        [
            'missing submit callback',
            (f: ReturnType<typeof fixture>) => {
                f.editor.onSubmit = undefined as never;
                return true;
            },
        ],
        [
            'TUI unavailable',
            (f: ReturnType<typeof fixture>) => {
                f.state.noTui = true;
                return true;
            },
        ],
        [
            'throwing focus accessor',
            (f: ReturnType<typeof fixture>) => {
                f.state.focusThrows = true;
                return true;
            },
        ],
        [
            'throwing widget accessor',
            (f: ReturnType<typeof fixture>) => {
                f.state.widgetThrows = true;
                return true;
            },
        ],
        [
            'missing custom editor accessor',
            (f: ReturnType<typeof fixture>) => {
                (
                    f.ctx.ui as unknown as Record<string, unknown>
                ).getEditorComponent = undefined;
                return true;
            },
        ],
        [
            'throwing custom editor accessor',
            (f: ReturnType<typeof fixture>) => {
                (
                    f.ctx.ui as unknown as Record<string, unknown>
                ).getEditorComponent = () => {
                    throw new Error('unreadable');
                };
                return true;
            },
        ],
    ])('fails closed for %s', (_name, alter) => {
        const f = fixture();
        const state = capture(f);
        const baseline = state.baseline;
        alter(f);
        expect(nativeReloadAvailable(f.ctx, state)).toBe(false);
        expect(invokeNativeReload(f.ctx, state)).toEqual({ entered: false });
        expect(state.baseline).toBe(baseline);
        expect(f.calls).toEqual([]);
        expect(f.state.widget).toBe(false);
    });

    it('keeps the staged Pi draft and history unchanged during inspection', () => {
        const f = fixture();
        const state = capture(f);
        expect(nativeReloadAvailable(f.ctx, state)).toBe(true);
        expect(f.editor.text).toBe('kept draft');
        expect(f.editor.history).toEqual(['kept history']);
        expect(f.state.widget).toBe(false);
        expect(f.calls).toEqual([]);
    });

    it('treats a callback rejection as entered and never retries', async () => {
        const f = fixture();
        f.editor.onSubmit = async (text) => {
            f.calls.push(text);
            throw new Error('host failure');
        };
        const state = capture(f);
        const attempt = invokeNativeReload(f.ctx, state);
        expect(attempt.entered).toBe(true);
        if (attempt.entered)
            await expect(attempt.completion).rejects.toThrow('host failure');
        expect(f.calls).toEqual(['/reload']);
    });

    it('treats a synchronous callback throw as entered', async () => {
        const f = fixture();
        f.editor.onSubmit = new Proxy(async () => {}, {
            apply() {
                f.calls.push('/reload');
                throw new Error('sync failure');
            },
        });
        const state = capture(f);
        const attempt = invokeNativeReload(f.ctx, state);
        expect(attempt.entered).toBe(true);
        if (attempt.entered)
            await expect(attempt.completion).rejects.toThrow('sync failure');
        expect(f.calls).toEqual(['/reload']);
    });
});
