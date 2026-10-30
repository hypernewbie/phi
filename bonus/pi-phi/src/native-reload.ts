// Checked access to Pi's native interactive /reload submit callback.
// This is a compatibility adapter for tested stock editors, not a public Pi API.

import { captureFocusedComponent } from './tui-probe.js';

/**
 * Minimal host view the adapter needs. Satisfied by both the
 * extension context at session_start and the runtime's structural
 * event-context view at request time.
 */
export interface NativeReloadHost {
    readonly ui?: unknown;
}

const PROBE_KEY = 'phi.pi-phi.reload-probe';

type Submit = (text: string) => unknown;

export interface NativeReloadBaseline {
    readonly editor: object;
    readonly submit: Submit;
}

export interface ReloadLatchState {
    baseline: NativeReloadBaseline | null;
    pending: {
        requestId: string;
        runtimeId: string;
        sessionId: string;
        reported: boolean;
    } | null;
    highWater: bigint | null;
    active: { runtimeId: string; notify: () => void } | null;
}

export function freshReloadLatch(): ReloadLatchState {
    return { baseline: null, pending: null, highWater: null, active: null };
}

function readStockEditor(ctx: NativeReloadHost): NativeReloadBaseline | null {
    try {
        const ui = ctx.ui;
        const getEditorComponent = (
            ui as unknown as { getEditorComponent?: unknown }
        ).getEditorComponent;
        if (typeof getEditorComponent !== 'function') return null;
        if (getEditorComponent.call(ui) !== undefined) return null;

        const editor = captureFocusedComponent(ui, PROBE_KEY) as {
            constructor?: { name?: unknown };
            history?: unknown;
            onSubmit?: unknown;
        } | null;
        if (!editor || editor.constructor?.name !== 'CustomEditor') return null;
        if (
            !Array.isArray(editor.history) ||
            !editor.history.every((entry) => typeof entry === 'string')
        ) {
            return null;
        }
        const submit = editor.onSubmit;
        if (
            typeof submit !== 'function' ||
            submit.constructor?.name !== 'AsyncFunction'
        ) {
            return null;
        }
        return { editor, submit: submit as Submit };
    } catch {
        return null;
    }
}

/** Capture once during the owning extension's session_start. */
export function captureNativeReloadBaseline(
    ctx: NativeReloadHost,
    state: ReloadLatchState,
): boolean {
    if (state.baseline) return true;
    const candidate = readStockEditor(ctx);
    if (!candidate) return false;
    state.baseline = candidate;
    return true;
}

/** Current focus must still be the captured stock editor and callback. */
export function nativeReloadAvailable(
    ctx: NativeReloadHost,
    state: ReloadLatchState,
): boolean {
    const baseline = state.baseline;
    if (!baseline) return false;
    const current = readStockEditor(ctx);
    return (
        current !== null &&
        current.editor === baseline.editor &&
        current.submit === baseline.submit
    );
}

export type NativeReloadAttempt =
    | { readonly entered: false }
    | {
          readonly entered: true;
          readonly completion: Promise<unknown>;
      };

/** Run all guards and enter Pi's fixed native command in one call stack. */
export function invokeNativeReload(
    ctx: NativeReloadHost,
    state: ReloadLatchState,
): NativeReloadAttempt {
    const baseline = state.baseline;
    if (!baseline) return { entered: false };
    const current = readStockEditor(ctx);
    if (
        !current ||
        current.editor !== baseline.editor ||
        current.submit !== baseline.submit
    ) {
        return { entered: false };
    }

    // This synchronous call is the dispatch boundary. A throw or promise
    // rejection after entry remains possibly dispatched; callers must not
    // retry it or route it through the PTY.
    try {
        return {
            entered: true,
            completion: Promise.resolve(
                baseline.submit.call(baseline.editor, '/reload'),
            ),
        };
    } catch (error) {
        return { entered: true, completion: Promise.reject(error) };
    }
}
