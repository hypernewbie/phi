// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Brute-force-correct fit path: a fit that changes no geometry must not
// run scroll capture, _spamScroll timers, or a backend SIGWINCH
// round-trip. Tab switches with identical geometry are the common case
// (switching tabs never resizes the container), so they must be free.
setupDomHarness();

function ctx(activeTab) {
    const c = Object.create(TabManager.prototype);
    c.getActiveTab = vi.fn(() => activeTab);
    c.resolveTerminalFontSize = vi.fn(() => 14);
    c.sendResizeToBackend = vi.fn();
    c._spamScroll = vi.fn();
    return c;
}

function tab(cols, rows, proposed) {
    return {
        isDead: false,
        term: {
            cols,
            rows,
            options: { fontSize: 14 },
            buffer: { active: { viewportY: 10, baseY: 10 } },
        },
        fitAddon: {
            proposeDimensions: vi.fn(() => proposed),
            fit: vi.fn(),
        },
    };
}

describe('fitActiveTerminal skips same-geometry fits', () => {
    it('returns before fit, scroll restore, and backend resize when dims match', () => {
        const t = tab(80, 24, { cols: 80, rows: 24 });
        const c = ctx(t);
        c.fitActiveTerminal();
        expect(t.fitAddon.fit).not.toHaveBeenCalled();
        expect(c._spamScroll).not.toHaveBeenCalled();
        expect(c.sendResizeToBackend).not.toHaveBeenCalled();
    });

    it('measures the DOM once per fit with the real font resolver', () => {
        const t = tab(80, 24, { cols: 80, rows: 24 });
        const c = Object.create(TabManager.prototype);
        c.getActiveTab = vi.fn(() => t);
        c.app = { terminalFontSize: 14 };
        c.sendResizeToBackend = vi.fn();
        c._spamScroll = vi.fn();
        // resolveTerminalFontSize NOT stubbed: the shared proposal feeds
        // both font resolution (14 == 14, no change) and the skip check.
        c.fitActiveTerminal();
        expect(t.fitAddon.proposeDimensions).toHaveBeenCalledTimes(1);
        expect(t.term.options.fontSize).toBe(14);
        expect(t.fitAddon.fit).not.toHaveBeenCalled();
        expect(c._spamScroll).not.toHaveBeenCalled();
        expect(c.sendResizeToBackend).not.toHaveBeenCalled();
    });

    it('fits when the proposed geometry differs', () => {
        const t = tab(80, 24, { cols: 100, rows: 30 });
        const c = ctx(t);
        c.fitActiveTerminal();
        expect(t.fitAddon.fit).toHaveBeenCalledTimes(1);
        expect(c.sendResizeToBackend).toHaveBeenCalledWith(t);
    });

    it('fits when the font size still needs applying', () => {
        const t = tab(80, 24, { cols: 80, rows: 24 });
        t.term.options.fontSize = 12; // differs from resolved 14
        const c = ctx(t);
        c.fitActiveTerminal();
        expect(t.term.options.fontSize).toBe(14);
        expect(t.fitAddon.fit).toHaveBeenCalledTimes(1);
    });

    it('falls through when geometry is unmeasurable', () => {
        const t = tab(80, 24, undefined); // hidden term, no proposal
        const c = ctx(t);
        c.fitActiveTerminal();
        expect(t.fitAddon.fit).toHaveBeenCalledTimes(1);
    });

    it('does not skip mid-resize fits (cached scroll coords lifecycle)', () => {
        const t = tab(80, 24, { cols: 80, rows: 24 });
        const c = ctx(t);
        c.isResizing = true;
        c.fitActiveTerminal();
        // Same dims, but the resize-owned coordinate cache must keep
        // its exact current behavior: fit runs, _spamScroll runs.
        expect(t.fitAddon.fit).toHaveBeenCalledTimes(1);
        expect(c._spamScroll).toHaveBeenCalled();
    });

    it('sizes a fresh socket once, then stays silent on later skips', () => {
        const t = tab(80, 24, { cols: 80, rows: 24 });
        t.ws = { id: 'sock-1' };
        const c = ctx(t);
        c.fitActiveTerminal();
        // Client reflow skipped, but the backend never saw this socket.
        expect(t.fitAddon.fit).not.toHaveBeenCalled();
        expect(c.sendResizeToBackend).toHaveBeenCalledTimes(1);
        c.fitActiveTerminal();
        expect(c.sendResizeToBackend).toHaveBeenCalledTimes(1);
        // Socket swap (reconnect) re-arms the one-time sync.
        t.ws = { id: 'sock-2' };
        c.fitActiveTerminal();
        expect(c.sendResizeToBackend).toHaveBeenCalledTimes(2);
    });

    it('a genuine fit records the socket for later skips', () => {
        const t = tab(80, 24, { cols: 100, rows: 30 });
        t.ws = { id: 'sock-1' };
        const c = ctx(t);
        c.fitActiveTerminal();
        expect(t.fitAddon.fit).toHaveBeenCalledTimes(1);
        expect(c.sendResizeToBackend).toHaveBeenCalledTimes(1);
        // Geometry settles onto the new grid: pure skip, no resend.
        t.term.cols = 100;
        t.term.rows = 30;
        t.fitAddon.proposeDimensions = vi.fn(() => ({
            cols: 100,
            rows: 30,
        }));
        c.fitActiveTerminal();
        expect(t.fitAddon.fit).toHaveBeenCalledTimes(1);
        expect(c.sendResizeToBackend).toHaveBeenCalledTimes(1);
    });

    it('ignores dead or missing tabs', () => {
        const c = ctx(null);
        expect(() => c.fitActiveTerminal()).not.toThrow();
        const dead = tab(80, 24, { cols: 80, rows: 24 });
        dead.isDead = true;
        const c2 = ctx(dead);
        c2.fitActiveTerminal();
        expect(dead.fitAddon.fit).not.toHaveBeenCalled();
    });
});
