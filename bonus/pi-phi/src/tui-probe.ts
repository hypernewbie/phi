// Synchronous, zero-height TUI probe shared by host readers. The widget
// factory captures the live TUI during setWidget; cleanup always runs.

const PROBE_KEY = 'phi.pi-phi.focus-probe';

type SetWidgetFn = (
    key: string,
    factory: ((tui: unknown, theme: unknown) => unknown) | undefined,
    options?: { placement?: string },
) => void;

/** Return the focused component, or null when the live TUI is unavailable. */
export function captureFocusedComponent(
    ui: unknown,
    key: string,
): object | null {
    try {
        if (typeof ui !== 'object' || ui === null) return null;
        const candidate = (ui as { setWidget?: unknown }).setWidget;
        if (typeof candidate !== 'function') return null;
        const setWidget = candidate as SetWidgetFn;
        let tui: unknown = null;
        try {
            setWidget(
                key || PROBE_KEY,
                (captured: unknown) => {
                    tui = captured;
                    return { render: () => [] };
                },
                { placement: 'belowEditor' },
            );
        } catch {
            return null;
        } finally {
            try {
                setWidget(key || PROBE_KEY, undefined);
            } catch {
                // The probe has no resources. A failed clear must not
                // make a usable Pi editor look like a different host.
            }
        }
        if (typeof tui !== 'object' || tui === null) return null;
        const getFocused = (tui as { getFocusedComponent?: unknown })
            .getFocusedComponent;
        if (typeof getFocused !== 'function') return null;
        const focused = (getFocused as (this: unknown) => unknown).call(tui);
        return typeof focused === 'object' && focused !== null ? focused : null;
    } catch {
        return null;
    }
}
