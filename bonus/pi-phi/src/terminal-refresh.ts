// Checked access to Pi's live TUI repaint controls. A repaint stops the
// interactive renderer while preserving the screen, restarts it, and
// forces one full render, so a viewer that attached at HEAD receives the
// whole current screen without replaying history. It never submits a
// prompt, touches the editor draft, or waits for model work.

import { captureLiveTui } from './tui-probe.js';

const PROBE_KEY = 'phi.pi-phi.refresh-probe';

/** Minimal host view the repaint needs. Satisfied by stock Pi TUIs. */
export interface TerminalRefreshTui {
    stop(options: { preserveScreen: boolean }): unknown;
    start(): unknown;
    requestRender(force?: boolean): unknown;
}

/** The live TUI when it exposes all three repaint methods, else null. */
export function readRefreshTui(ui: unknown): TerminalRefreshTui | null {
    const tui = captureLiveTui(ui, PROBE_KEY);
    if (!tui) return null;
    const candidate = tui as Partial<TerminalRefreshTui>;
    if (
        typeof candidate.stop !== 'function' ||
        typeof candidate.start !== 'function' ||
        typeof candidate.requestRender !== 'function'
    ) {
        return null;
    }
    return candidate as TerminalRefreshTui;
}

/** True when the current surface can repaint its own live screen. */
export function isTerminalRefreshAvailable(ui: unknown): boolean {
    return readRefreshTui(ui) !== null;
}

/**
 * Repaint in place. Returns true only after the full
 * stop/start/forced-render sequence ran without throwing. Entry is the
 * dispatch boundary: a failure after `stop` is unknown, never a reason to
 * retry, and the one repair attempt below just keeps the renderer alive.
 */
export function invokeTerminalRefresh(tui: TerminalRefreshTui): boolean {
    try {
        tui.stop({ preserveScreen: true });
        tui.start();
        tui.requestRender(true);
        return true;
    } catch {
        // stop can throw after disabling input or cancelling the renderer.
        try {
            tui.start();
        } catch {
            // The renderer is already lost; nothing else is safe here.
        }
        try {
            tui.requestRender(true);
        } catch {
            // Forced repair is best-effort only.
        }
        return false;
    }
}
