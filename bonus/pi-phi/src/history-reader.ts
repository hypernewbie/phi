// Direct Pi editor-history reader. Captures the live TUI through a
// temporary below-editor widget, then copies the focused editor's
// in-memory history array (plain strings, newest-first). The probe
// widget is synchronous and zero-height, and removal runs in a
// finally, so the editor, focus, and layout are unchanged.
//
// Never throws into Pi: every unexpected shape or failure yields
// null (unavailable). Print and RPC modes never invoke the factory,
// so the reader reports unavailable there without probing further.

/** Probe widget key. Namespaced so it cannot collide with user widgets. */
import { captureFocusedComponent } from './tui-probe.js';

const PROBE_KEY = 'phi.pi-phi.history-probe';

/** Copy the live editor history, or null when unavailable. */
export function readEditorHistory(ui: unknown): string[] | null {
    try {
        return readEditorHistoryInner(ui);
    } catch {
        return null;
    }
}

function readEditorHistoryInner(ui: unknown): string[] | null {
    const focused = captureFocusedComponent(ui, PROBE_KEY);
    if (!focused) return null;
    // SAFETY: .history is TS-private on the Editor class but a plain
    // runtime field (pi-tui components/editor.js). The shape check
    // below rejects selectors, custom editors, and future shapes.
    const history = (focused as { history?: unknown }).history;
    if (!Array.isArray(history)) return null;
    for (const entry of history) {
        if (typeof entry !== 'string') return null;
    }
    return [...(history as string[])];
}

/** True when a history-shaped editor is currently readable. */
export function isHistoryReaderAvailable(ui: unknown): boolean {
    return readEditorHistory(ui) !== null;
}
