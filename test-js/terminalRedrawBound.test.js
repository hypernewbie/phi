// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Bounded redraw: a cold attach repaints by resetting the pane buffer and
// replaying the retained window. Repeating that for the same window appended
// scrollback and scrolled the screen continuously. One repaint per window;
// a repeat is suppressed unless the user asks for it.

setupDomHarness();

function page(start, end, body) {
    const bytes = new TextEncoder().encode(body);
    return {
        start,
        end,
        endCursor: `v1.e.${end}.0`,
        byteLength: bytes.byteLength,
        text: body,
        bytes,
        resizes: [],
    };
}

function ctx(fetchImpl) {
    const c = Object.create(TabManager.prototype);
    c._fetchReplayPages = vi.fn(fetchImpl);
    c.writeToTerminal = vi.fn();
    c._drainSettled = vi.fn(async () => {});
    c._resetPaneBuffer = vi.fn();
    c._showReplayProgress = vi.fn();
    c._hideReplayProgress = vi.fn();
    c._noteReplayDurability = vi.fn();
    c._scheduleCheckpointUpload = vi.fn();
    c._fitVisibleTerminal = vi.fn();
    c._refreshTerminalScreen = vi.fn();
    c._parseRecordingRange = vi.fn(async () => true);
    c._terminalPanelVisible = vi.fn(() => true);
    return c;
}

function coldTab(p) {
    return {
        paneId: 'p',
        isDead: false,
        ws: p,
        paneEpoch: 'e',
        queuedSeq: 0,
        drainedSeq: 0,
        writeBuffer: '',
        writePending: false,
        _replayBaseline: { cols: 80, rows: 24 },
        _replayCursor: 'v1.e.0.0',
        term: { cols: 80, rows: 24, resize: vi.fn() },
        termContainer: {},
        coder: 'pi',
    };
}

describe('bounded redraw', () => {
    it('paints an unchanged window once and suppresses the repeat', async () => {
        const p = { mode: 'hot', sendResize: () => true };
        const c = ctx(async () => page(0, 5, 'hello'));

        const first = coldTab(p);
        const a = await c._bootstrapDelta(first, 0, 5);
        expect(a.kind).toBe('applied');
        expect(c._fetchReplayPages).toHaveBeenCalledTimes(1);
        expect(c._resetPaneBuffer).toHaveBeenCalledTimes(1);

        // Same epoch, head and geometry: no fetch, no reset, no scroll.
        const second = first;
        second._replayBaseline = { cols: 80, rows: 24 };
        const b = await c._bootstrapDelta(second, 0, 5);
        expect(b.kind).toBe('live-now');
        expect(c._fetchReplayPages).toHaveBeenCalledTimes(1);
        expect(c._resetPaneBuffer).toHaveBeenCalledTimes(1);
        // Exactly one paint, then one suppression: no second scroll.
        expect(second._redrawLog?.map((e) => e.outcome)).toEqual([
            'painted',
            'suppressed',
        ]);
    });

    it('paints again when the head moved', async () => {
        const p = { mode: 'hot', sendResize: () => true };
        const c = ctx(async () => page(0, 5, 'hello'));
        const first = coldTab(p);
        await c._bootstrapDelta(first, 0, 5);

        const next = first;
        next._replayBaseline = { cols: 80, rows: 24 };
        c._fetchReplayPages.mockImplementation(async () =>
            page(0, 9, 'hello!!!!'),
        );
        const b = await c._bootstrapDelta(next, 0, 9);
        expect(b.kind).toBe('applied');
        expect(c._fetchReplayPages).toHaveBeenCalledTimes(2);
    });

    it('paints again when the geometry changed', async () => {
        const p = { mode: 'hot', sendResize: () => true };
        const c = ctx(async () => page(0, 5, 'hello'));
        const first = coldTab(p);
        await c._bootstrapDelta(first, 0, 5);

        const resized = first;
        resized._replayBaseline = { cols: 100, rows: 30 };
        const b = await c._bootstrapDelta(resized, 0, 5);
        expect(b.kind).toBe('applied');
        expect(c._fetchReplayPages).toHaveBeenCalledTimes(2);
    });

    it('repaints an unchanged window after an explicit refresh', async () => {
        const p = { mode: 'hot', sendResize: () => true };
        const c = ctx(async () => page(0, 5, 'hello'));
        const first = coldTab(p);
        await c._bootstrapDelta(first, 0, 5);

        const manual = first;
        manual._replayBaseline = { cols: 80, rows: 24 };
        manual._forceRedraw = true;
        const b = await c._bootstrapDelta(manual, 0, 5);
        expect(b.kind).toBe('applied');
        expect(c._fetchReplayPages).toHaveBeenCalledTimes(2);
        // The force is consumed: the next identical attach is suppressed.
        expect(manual._forceRedraw).toBe(false);
    });

    it('does not reset when the window is empty and already painted', async () => {
        const p = { mode: 'hot', sendResize: () => true };
        const c = ctx(async () => page(0, 0, ''));
        const first = coldTab(p);
        await c._bootstrapDelta(first, 0, 0);
        const resets = c._resetPaneBuffer.mock.calls.length;
        const second = first;
        second._replayBaseline = { cols: 80, rows: 24 };
        const b = await c._bootstrapDelta(second, 0, 0);
        expect(b.kind).toBe('live-now');
        expect(c._resetPaneBuffer).toHaveBeenCalledTimes(resets);
    });
});
