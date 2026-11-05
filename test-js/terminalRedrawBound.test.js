// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { replayHarness, encode } from './_terminalReplayHarness.js';

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
        c._bootstrappedRelease(second, p, 0, 5, 'v1.e.5.0');
        await Promise.all(second._pendingBootstraps ?? []);
        expect(c._fetchReplayPages).toHaveBeenCalledTimes(1);
        expect(c._resetPaneBuffer).toHaveBeenCalledTimes(1);
        // Exactly one paint, then one suppression: no second scroll.
        expect(second._redrawLog?.map((e) => e.outcome)).toEqual([
            'painted',
            'suppressed',
        ]);
    });

    it('starts a fallback repaint at the floor ordinal, not the live ordinal', async () => {
        const p = { mode: 'hot', sendResize: () => true };
        const c = ctx(async () => ({
            ...page(0, 6, 'hello!'),
            endCursor: 'v1.e.6.1',
        }));
        const tab = coldTab(p);
        tab._floorCursor = 'v1.e.0.0';
        tab._replayCursor = 'v1.e.5.1';
        tab.queuedSeq = tab.drainedSeq = 5;
        c._parseRecordingRange.mockImplementation(async () => {
            expect(tab._replayCursor).toBe('v1.e.0.0');
            expect(tab.drainedSeq).toBe(0);
            return true;
        });
        expect((await c._bootstrapDelta(tab, 0, 6)).kind).toBe('applied');
        expect(c._fetchReplayPages.mock.calls[0][4].afterCursor).toBe(
            'v1.e.0.0',
        );
        expect(tab._replayCursor).toBe('v1.e.6.1');
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

    it.each([false, true])(
        'manual refresh restores an idle terminal (live-only recovery: %s)',
        async (limited) => {
            const source = encode('RETAINED-SCREEN\r\n');
            let refuse = false;
            const h = replayHarness(source, () =>
                refuse ? { ok: false, status: 503 } : null,
            );
            try {
                h.pty.ws.head({ epoch: 7, oldest: 0, head: source.length });
                await h.settle();
                // Damage only the local view. The PTY is idle and its byte
                // frontier is unchanged, so a delta reconnect cannot repair it.
                h.term.reset();
                h.tab._limitedRecovery = limited;
                h.tab._recovery = { deadline: Date.now() - 1, attempts: 2 };
                h.manager.getActiveTab = () => h.tab;
                h.manager.reconnectTab = () => {
                    const pty = h.socket();
                    pty.ws.head({ epoch: 7, oldest: 0, head: source.length });
                };
                h.fetcher.mockClear();
                refuse = true;

                h.manager.refreshConsole();
                await h.settle();
                expect(h.tab._forceRedraw).toBe(true);
                expect(h.tab.ws.ws.closed).toBe(true);

                // A failed first page must not turn the replacement attach
                // into a zero-delta success that clears the view without replay.
                refuse = false;
                h.socket().ws.head({
                    epoch: 7,
                    oldest: 0,
                    head: source.length,
                });
                await h.settle();

                expect(h.fetcher).toHaveBeenCalledTimes(2);
                expect(h.requests.at(-1).from).toBe(0);
                const lines = Array.from(
                    { length: h.term.buffer.active.length },
                    (_, i) =>
                        h.term.buffer.active.getLine(i).translateToString(true),
                ).join('\n');
                expect(lines).toContain('RETAINED-SCREEN');
                expect(h.tab._limitedRecovery).not.toBe(true);
                expect(h.tab.drainedSeq).toBe(source.length);
                expect(h.tab._forceRedraw).toBe(false);
            } finally {
                h.dispose();
                vi.unstubAllGlobals();
            }
        },
    );

    it('does not reset when the window is empty and already painted', async () => {
        const p = { mode: 'hot', sendResize: () => true };
        const c = ctx(async () => page(0, 0, ''));
        const first = coldTab(p);
        await c._bootstrapDelta(first, 0, 0);
        const resets = c._resetPaneBuffer.mock.calls.length;
        const second = first;
        second._replayBaseline = { cols: 80, rows: 24 };
        const b = await c._bootstrapDelta(second, 0, 0);
        expect(b.kind).toBe('applied');
        expect(c._resetPaneBuffer).toHaveBeenCalledTimes(resets);
    });
});
