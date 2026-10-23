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
const PROBE_KEY = 'phi.pi-phi.history-probe';

type SetWidgetFn = (
    key: string,
    factory: ((tui: unknown, theme: unknown) => unknown) | undefined,
    options?: { placement?: string },
) => void;

function asSetWidget(ui: unknown): SetWidgetFn | null {
    if (typeof ui !== 'object' || ui === null) return null;
    const fn = (ui as { setWidget?: unknown }).setWidget;
    return typeof fn === 'function' ? (fn as SetWidgetFn) : null;
}

/** Copy the live editor history, or null when unavailable. */
export function readEditorHistory(ui: unknown): string[] | null {
    try {
        return readEditorHistoryInner(ui);
    } catch {
        return null;
    }
}

function readEditorHistoryInner(ui: unknown): string[] | null {
    const setWidget = asSetWidget(ui);
    if (!setWidget) return null;
    let tui: unknown = null;
    try {
        setWidget(
            PROBE_KEY,
            (captured: unknown) => {
                tui = captured;
                // Zero-height: no paint can slip in between the
                // synchronous set and the removal below, but a
                // valid empty component keeps this safe regardless.
                return { render: () => [] };
            },
            { placement: 'belowEditor' },
        );
    } catch {
        return null;
    } finally {
        try {
            setWidget(PROBE_KEY, undefined);
        } catch {
            // Removal is best-effort; the probe holds no resources.
        }
    }
    // Print and RPC modes never invoke the factory.
    if (tui === null) return null;
    if (typeof tui !== 'object' || tui === null) return null;
    const getFocused = (tui as { getFocusedComponent?: unknown })
        .getFocusedComponent;
    if (typeof getFocused !== 'function') return null;
    let focused: unknown;
    try {
        focused = (getFocused as (this: unknown) => unknown).call(tui);
    } catch {
        return null;
    }
    // SAFETY: .history is TS-private on the Editor class but a plain
    // runtime field (pi-tui components/editor.js). The shape check
    // below rejects selectors, custom editors, and future shapes.
    if (typeof focused !== 'object' || focused === null) return null;
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
