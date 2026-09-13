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

    it('marks first-write once per attach and measures attach latency', () => {
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
});
