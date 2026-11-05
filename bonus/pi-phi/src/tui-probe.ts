// Synchronous, zero-height TUI probe shared by host readers. The widget
// factory captures the live TUI during setWidget; cleanup always runs.

const PROBE_KEY = 'phi.pi-phi.focus-probe';

type SetWidgetFn = (
    key: string,
    factory: ((tui: unknown, theme: unknown) => unknown) | undefined,
    options?: { placement?: string },
) => void;

/**
 * Return the live TUI object, or null when the surface exposes no widget
 * host. The probe widget is zero-height and always removed, so probing
 * never changes focus, layout, or editor state.
 */
export function captureLiveTui(ui: unknown, key: string): unknown | null {
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
                // make a usable Pi surface look like a different host.
            }
        }
        return typeof tui === 'object' && tui !== null ? tui : null;
    } catch {
        return null;
    }
}

/** Return the focused component, or null when the live TUI is unavailable. */
export function captureFocusedComponent(
    ui: unknown,
    key: string,
): object | null {
    const tui = captureLiveTui(ui, key);
    if (!tui) return null;
    try {
        const getFocused = (tui as { getFocusedComponent?: unknown })
            .getFocusedComponent;
        if (typeof getFocused !== 'function') return null;
        const focused = (getFocused as (this: unknown) => unknown).call(tui);
        return typeof focused === 'object' && focused !== null ? focused : null;
    } catch {
        return null;
    }
}
