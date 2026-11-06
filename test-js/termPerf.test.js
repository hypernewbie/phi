// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

// Lightweight User Timing instrumentation: marks and slow-path measures
// so DevTools can answer "where did the seconds go" on a real device.
// Purely observational: no behavior change.

function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.app = { config: {} };
    tm.updateDocumentTitle = () => {};
    tm.syncBackendPin = () => {};
    tm._flushTerminalWrite = TabManager.prototype._flushTerminalWrite;
    return tm;
}

describe('terminal performance instrumentation', () => {
    let markSpy;
    let measureSpy;

    beforeEach(() => {
        markSpy = vi.spyOn(performance, 'mark');
        measureSpy = vi.spyOn(performance, 'measure');
    });

    afterEach(() => {
        markSpy.mockRestore();
        measureSpy.mockRestore();
    });

    it('marks first-write once per attach and measures attach latency', async () => {
        const tm = makeTm();
        const written = [];
        const tab = {
            paneId: 'p1',
            isDead: false,
            isBusy: true,
            writeBuffer: '',
            writePending: false,
            _perfAttachAt: performance.now(),
            term: {
                write: (data, cb) => {
                    written.push(data);
                    cb();
                },
                buffer: { active: { viewportY: 0, baseY: 0 } },
                scrollToBottom: () => {},
                _core: { viewport: { syncScrollArea: () => {} } },
            },
        };

        tm.writeToTerminal(tab, 'hello');
        tm.writeToTerminal(tab, ' world');
        await Promise.resolve();

        expect(written.join('')).toBe('hello world');
        const marks = markSpy.mock.calls.map((c) => c[0]);
        expect(marks).toContain('phi:first-write');
        // Exactly once: the second write must not re-mark.
        expect(marks.filter((m) => m === 'phi:first-write')).toHaveLength(1);
        expect(measureSpy).toHaveBeenCalledWith(
            'phi:attach-to-first-write',
            expect.objectContaining({ start: expect.any(Number) }),
        );
    });

    it('does not measure attach latency when the write precedes ws-open', () => {
        const tm = makeTm();
        const tab = {
            isDead: false,
            isBusy: true,
            writeBuffer: '',
            writePending: false,
            term: { write: (_d, cb) => cb() },
        };
        tm.writeToTerminal(tab, 'x');
        expect(measureSpy).not.toHaveBeenCalled();
    });

    it('measures slow fits as phi:fit and never throws on missing APIs', async () => {
        const tm = makeTm();
        tm.getActiveTab = () => tab;
        tm.resolveTerminalFontSize = () => 14;
        tm.isResizing = false;
        tm._spamScroll = () => {};
        tm.sendResizeToBackend = () => {};

        let fitCalls = 0;
        const tab = {
            paneId: 'p2',
            isDead: false,
            isBusy: true,
            writeBuffer: '',
            writePending: false,
            term: {
                options: { fontSize: 14 },
                cols: 80,
                rows: 24,
                buffer: { active: { viewportY: 0, baseY: 0 } },
            },
            fitAddon: {
                fit: () => {
                    fitCalls++;
                    const t0 = Date.now();
                    // ~20ms real time crosses the 16ms slow threshold.
                    while (Date.now() - t0 < 20) {}
                },
            },
        };

        tm.fitActiveTerminal();
        expect(fitCalls).toBe(1);
        expect(measureSpy).toHaveBeenCalledWith(
            'phi:fit',
            expect.objectContaining({ duration: expect.any(Number) }),
        );

        // Fast fit (0ms) stays under the threshold: no measure recorded.
        measureSpy.mockClear();
        tab.fitAddon.fit = () => {};
        tm.fitActiveTerminal();
        const names = measureSpy.mock.calls.map((c) => c[0]);
        expect(names).not.toContain('phi:fit');
    });

    // Redraw tracepoints: every resize/redraw lands on one DevTools custom
    // track, fast ones included. console.timeStamp leaves the User Timing
    // buffer alone, so no bound is needed here.
    describe('redraw tracepoint', () => {
        let stampSpy;

        beforeEach(() => {
            // jsdom ships no console.timeStamp; the tracepoint must work with
            // the real one and stay silent without it.
            stampSpy = vi.fn();
            console.timeStamp = stampSpy;
        });

        afterEach(() => {
            delete console.timeStamp;
        });

        // Only the pane being painted carries the span.
        function traced(tab) {
            const tm = makeTm();
            tm.getActiveTab = () => tab;
            return tm;
        }

        it('closes the span on paint with reason, grid and duration', () => {
            const tab = { term: { cols: 80, rows: 24 } };
            const tm = traced(tab);

            tm._beginRedrawTrace(tab, 'tab-switch');
            tm._endRedrawTrace(tab);

            expect(stampSpy).toHaveBeenCalledTimes(1);
            const [label, start, end, track, group, color, data] =
                stampSpy.mock.calls[0];
            expect(label).toBe('tab-switch');
            expect(end).toBeGreaterThanOrEqual(start);
            expect(track).toBe('redraw');
            expect(group).toBe('phi');
            expect(color).toBe('primary');
            expect(data).toEqual({
                ms: expect.any(Number),
                cols: 80,
                rows: 24,
            });
            // The span is consumed: a second paint records nothing.
            tm._endRedrawTrace(tab);
            expect(stampSpy).toHaveBeenCalledTimes(1);
        });

        it('keeps the first request of a coalesced redraw', () => {
            const tab = { term: { cols: 10, rows: 5 } };
            const tm = traced(tab);

            tm._beginRedrawTrace(tab, 'panel');
            const first = tab._redrawTraceAt;
            tm._beginRedrawTrace(tab, 'refresh');
            expect(tab._redrawTraceAt).toBe(first);

            tm._endRedrawTrace(tab);
            expect(stampSpy.mock.calls[0][0]).toBe('panel');
        });

        it('records a fast redraw instead of dropping it', () => {
            const tab = { term: { cols: 80, rows: 24 } };
            const tm = traced(tab);

            tm._beginRedrawTrace(tab, 'panel');
            tab._redrawTraceAt = performance.now();
            tm._endRedrawTrace(tab);

            expect(stampSpy).toHaveBeenCalledTimes(1);
            expect(stampSpy.mock.calls[0][6].ms).toBeLessThan(16);
        });

        it('ignores a background pane, which paints nothing', () => {
            const active = { term: { cols: 80, rows: 24 } };
            const background = { term: { cols: 80, rows: 24 } };
            const tm = traced(active);

            // The panel observer fires for every open tab.
            tm._beginRedrawTrace(background, 'panel');
            expect(background._redrawTraceAt).toBeUndefined();
            tm._endRedrawTrace(background);
            expect(stampSpy).not.toHaveBeenCalled();
        });

        it('drops a pending span when the pane leaves', () => {
            const tab = { term: { cols: 80, rows: 24 } };
            const tm = traced(tab);

            tm._beginRedrawTrace(tab, 'panel');
            tm._dropRedrawTrace(tab);
            expect(tab._redrawTraceAt).toBeUndefined();

            // A later reveal must not report the abandoned request.
            tm._endRedrawTrace(tab);
            expect(stampSpy).not.toHaveBeenCalled();
        });

        it('drops a span that never painted in time', () => {
            const tab = { term: { cols: 80, rows: 24 } };
            const tm = traced(tab);

            tm._beginRedrawTrace(tab, 'tab-switch');
            tab._redrawTraceAt = performance.now() - 5000;
            tm._endRedrawTrace(tab);

            expect(stampSpy).not.toHaveBeenCalled();
            expect(tab._redrawTraceAt).toBeUndefined();
        });

        it('stays silent when the browser has no console.timeStamp', () => {
            const tab = { term: { cols: 80, rows: 24 } };
            const tm = traced(tab);
            delete console.timeStamp;

            tm._beginRedrawTrace(tab, 'fit');
            expect(() => tm._endRedrawTrace(tab)).not.toThrow();
            expect(tab._redrawTraceAt).toBeUndefined();
        });
    });
});
