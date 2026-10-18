// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import {
    encode,
    recordingEnvelope,
    replayHarness,
} from './_terminalReplayHarness.js';

const { Terminal } = createHeadlessSandbox();
const write = (term, text) =>
    new Promise((resolve) => term.write(text, resolve));
function snapshot(term) {
    const b = term.buffer.active;
    return {
        cols: term.cols,
        rows: term.rows,
        type: b.type,
        cursor: [b.cursorX, b.cursorY],
        lines: Array.from({ length: b.length }, (_, i) =>
            b.getLine(i).translateToString(true),
        ),
    };
}
function hiddenReplay(source, fault) {
    const h = replayHarness(source, fault);
    h.show = panelVisibility(h.tab);
    h.tab.fitAddon = { fit: vi.fn(() => h.term.resize(8, 5)) };
    vi.spyOn(h.pty, 'sendResize');
    return h;
}

setupDomHarness();

function panelVisibility(tab, initiallyVisible = false) {
    let visible = initiallyVisible;
    tab.termContainer = document.createElement('div');
    tab.termContainer.getBoundingClientRect = () => ({
        width: visible ? 800 : 0,
        height: visible ? 480 : 0,
    });
    return (value) => {
        visible = value;
    };
}

function admissionHarness() {
    const tab = {
        paneId: 'hidden-geometry',
        _pendingPanelFit: false,
        _pendingForceResize: false,
        term: {
            cols: 80,
            rows: 24,
            options: { fontSize: 14, fontFamily: 'monospace' },
            _core: { _charSizeService: { measure: vi.fn() } },
        },
        fitAddon: {
            proposeDimensions: vi.fn(() => ({ cols: 8, rows: 5 })),
            fit: vi.fn(() => {
                tab.term.cols = 8;
                tab.term.rows = 5;
            }),
        },
        ws: { sendResize: vi.fn(() => true) },
    };
    const show = panelVisibility(tab);
    const manager = Object.assign(Object.create(TabManager.prototype), {
        app: { config: {}, terminalFontSize: 14 },
        tabs: new Map([[tab.paneId, tab]]),
        activePaneId: tab.paneId,
        _spamScroll: vi.fn(),
    });
    return { manager, tab, show };
}

function expectDeferred(tab) {
    expect(tab._pendingPanelFit).toBe(true);
    expect(tab._pendingForceResize).toBe(true);
    expect(tab.fitAddon.fit).not.toHaveBeenCalled();
    expect(tab.ws.sendResize).not.toHaveBeenCalled();
}

describe('hidden DOM-fit admission', () => {
    it('defers hidden fits without changing either grid dimension', () => {
        const { manager, tab } = admissionHarness();
        manager._fitVisibleTerminal(tab);
        expectDeferred(tab);
        expect([tab.term.cols, tab.term.rows]).toEqual([80, 24]);
        expect(tab.fitAddon.proposeDimensions).not.toHaveBeenCalled();
    });

    it('runs visible fits synchronously without consuming pending flags', () => {
        const { manager, tab, show } = admissionHarness();
        manager._fitVisibleTerminal(tab);
        show(true);
        manager._fitVisibleTerminal(tab);
        expect(tab.fitAddon.fit).toHaveBeenCalledOnce();
        expect([tab.term.cols, tab.term.rows]).toEqual([8, 5]);
        expect(tab._pendingPanelFit).toBe(true);
        expect(tab._pendingForceResize).toBe(true);
    });

    it('preserves the caller ownership of visible addon failures', () => {
        const { manager, tab, show } = admissionHarness();
        show(true);
        const error = new Error('fit refused');
        tab.fitAddon.fit.mockImplementation(() => {
            throw error;
        });
        expect(() => manager._fitVisibleTerminal(tab)).toThrow(error);
    });

    it.each(['helper', 'direct'])(
        'defers a %s fit in a hidden document even with a measurable panel',
        (route) => {
            const { manager, tab, show } = admissionHarness();
            show(true);
            vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
            if (route === 'helper') manager._fitVisibleTerminal(tab);
            else manager.fitActiveTerminal({ forceResize: true });
            expectDeferred(tab);
            expect([tab.term.cols, tab.term.rows]).toEqual([80, 24]);
            expect(tab.fitAddon.proposeDimensions).not.toHaveBeenCalled();
            expect(
                tab.term._core._charSizeService.measure,
            ).not.toHaveBeenCalled();
        },
    );

    it('supports visible headless fixtures without an addon', () => {
        const { manager, tab, show } = admissionHarness();
        show(true);
        delete tab.fitAddon;
        expect(() => manager._fitVisibleTerminal(tab)).not.toThrow();
        expect(tab._pendingPanelFit).toBe(false);
    });

    it.each([false, true])(
        'hidden direct fits force later activation even with bootstrap=%s',
        (bootstrap) => {
            const { manager, tab } = admissionHarness();
            if (bootstrap) tab._bootstrapGate = Promise.resolve();
            manager.fitActiveTerminal({ forceResize: false });
            expectDeferred(tab);
            expect(
                tab.term._core._charSizeService.measure,
            ).not.toHaveBeenCalled();
            expect(tab.fitAddon.proposeDimensions).not.toHaveBeenCalled();
            expect(tab.term.options.fontSize).toBe(14);
            expect([tab.term.cols, tab.term.rows]).toEqual([80, 24]);
            expect(manager._spamScroll).not.toHaveBeenCalled();
        },
    );

    it('does not measure characters even when a hidden direct fit is forced', () => {
        const { manager, tab } = admissionHarness();
        manager.fitActiveTerminal({ forceResize: true });
        expectDeferred(tab);
        expect(tab.term._core._charSizeService.measure).not.toHaveBeenCalled();
        expect(tab.fitAddon.proposeDimensions).not.toHaveBeenCalled();
    });

    it('applies the preferred font size without measuring the hidden active tab', () => {
        const { manager, tab } = admissionHarness();
        manager.applyTerminalFontSizeToAll(18);
        expectDeferred(tab);
        expect(tab.term.options.fontSize).toBe(18);
        expect(tab.fitAddon.proposeDimensions).not.toHaveBeenCalled();
        expect([tab.term.cols, tab.term.rows]).toEqual([80, 24]);
    });

    it('applies font family without fitting the hidden grid', () => {
        const { manager, tab } = admissionHarness();
        manager.applyFontToAllActiveTerminals('JetBrains Mono');
        expectDeferred(tab);
        expect(tab.term.options.fontFamily).toBe('JetBrains Mono');
        expect([tab.term.cols, tab.term.rows]).toEqual([80, 24]);
    });
});

describe('hidden replay and history geometry ownership', () => {
    it('finishes zero-delta attachment and releases held live output without a fit', async () => {
        const h = hiddenReplay(encode(''));
        try {
            h.term.resize(80, 24);
            h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
            h.pty.ws.output(0, encode('LIVE WHILE HIDDEN'));
            await h.settle();
            expectDeferred(h.tab);
            expect([h.term.cols, h.term.rows]).toEqual([80, 24]);
            expect(h.tab._bootstrapGate).toBeNull();
            expect(h.pty.holding).toBe(false);
            expect(h.pty.held).toEqual([]);
            expect(h.tape.join('')).toBe('LIVE WHILE HIDDEN');
            expect(h.tab.drainedSeq).toBe(encode('LIVE WHILE HIDDEN').length);
        } finally {
            h.dispose();
        }
    });

    it('continues parsing and releases live delivery while the whole document is hidden', async () => {
        const prefix = encode('HIDDEN '),
            tail = encode('OUTPUT');
        const h = hiddenReplay(encode(''));
        try {
            h.show(true);
            vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
            h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
            h.pty.ws.output(0, prefix);
            h.pty.ws.output(prefix.length, tail);
            await h.settle();
            expectDeferred(h.tab);
            expect([h.term.cols, h.term.rows]).toEqual([240, 12]);
            expect(h.tape.join('')).toBe('HIDDEN OUTPUT');
            expect(snapshot(h.term).lines[0]).toBe('HIDDEN OUTPUT');
            expect(h.tab.drainedSeq).toBe(prefix.length + tail.length);
            expect(h.pty.liveSeq).toBe(prefix.length + tail.length);
            expect(h.tab._bootstrapGate).toBeNull();
            expect(h.pty.holding).toBe(false);
            expect(h.pty.held).toEqual([]);
        } finally {
            h.dispose();
        }
    });

    it('same-epoch reconnect applies authoritative checkpoint geometry while hidden', async () => {
        const h = hiddenReplay(encode('OLD'));
        try {
            h.pty.ws.head({ epoch: 7, oldest: 0, head: 3 });
            await h.settle();
            const next = h.socket();
            vi.spyOn(next, 'sendResize');
            const bytes = encode('\x1b[6;60HCURRENT');
            next.ws.head(
                {
                    epoch: 7,
                    oldest: 0,
                    head: 3,
                    ckpt: {
                        kind: 'ansi-v1',
                        through: 3,
                        cols: 90,
                        rows: 15,
                        len: bytes.length,
                    },
                },
                bytes,
            );
            await h.settle();
            expectDeferred(h.tab);
            expect([h.term.cols, h.term.rows]).toEqual([90, 15]);
            expect(snapshot(h.term).lines[5]).toContain('CURRENT');
            expect(snapshot(h.term).lines.join('\n')).not.toContain('OLD');
            expect(h.tab._serverStateAvailable).toBe(true);
            expect(h.tab._bootstrapGate).toBeNull();
            expect(next.holding).toBe(false);
            expect(h.tab.drainedSeq).toBe(3);
            expect(h.requests).toHaveLength(1);
        } finally {
            h.dispose();
        }
    });

    it('repairs a hidden live gap in source order and releases its queued tail', async () => {
        const prefix = 'BEFORE GAP\r\n',
            gap = 'MISSING\r\n',
            tail = 'AFTER GAP\r\n';
        const source = encode(prefix + gap + tail);
        const h = hiddenReplay(source);
        try {
            h.pty.ws.head({ epoch: 7, oldest: 0, head: encode(prefix).length });
            await h.settle();
            h.pty.ws.output(encode(prefix + gap).length, encode(tail));
            await h.settle();
            expectDeferred(h.tab);
            expect([h.term.cols, h.term.rows]).toEqual([240, 12]);
            expect(h.tape.join('')).toBe(prefix + gap + tail);
            expect(h.pty.liveSeq).toBe(source.length);
            expect(h.tab.drainedSeq).toBe(source.length);
            expect(h.tab._gapInFlight).toBe(false);
            expect(h.pty.holding).toBe(false);
            expect(h.pty.held).toEqual([]);
        } finally {
            h.dispose();
        }
    });

    it('orders recorded resizes before their bytes even while hidden', async () => {
        const prefix = '\x1b[6;60HBEFORE\r\n',
            suffix = 'recorded wide text '.repeat(12);
        const start = 10,
            cut = start + encode(prefix).length;
        const source = encode(' '.repeat(start) + prefix + suffix);
        const h = hiddenReplay(source, ({ from, to }) =>
            recordingEnvelope(source.slice(from, to), from, to, {
                resizes: [
                    [0, 80, 8],
                    [cut, 120, 10],
                ],
            }),
        );
        const reference = new Terminal({
            cols: 80,
            rows: 8,
            scrollback: 10000,
        });
        try {
            await write(reference, prefix);
            reference.resize(120, 10);
            await write(reference, suffix);
            h.pty.ws.head({ epoch: 7, oldest: start, head: source.length });
            await h.settle();
            expectDeferred(h.tab);
            expect(snapshot(h.term)).toEqual(snapshot(reference));
            expect([h.term.cols, h.term.rows]).toEqual([120, 10]);
            expect(h.tab.drainedSeq).toBe(source.length);
            expect(h.pty.holding).toBe(false);
        } finally {
            reference.dispose();
            h.dispose();
        }
    });

    it('returns from a saved local history view without fitting a newly hidden panel', async () => {
        const prefix = 'LIVE\r\n',
            tail = 'TAIL\r\n';
        const h = hiddenReplay(encode(prefix + tail));
        h.manager._queuePanelFit = vi.fn();
        try {
            h.pty.ws.head({ epoch: 7, oldest: 0, head: encode(prefix).length });
            await h.settle();
            h.tab._serverStateAvailable = false;
            h.tab._historyBrowsing = true;
            h.tab._historyLiveState = {
                epoch: 7,
                cols: 80,
                rows: 9,
                through: encode(prefix).length,
                head: encode(prefix).length,
                ansi: prefix,
            };
            h.pty.ws.output(encode(prefix).length, encode(tail));
            await h.settle();
            h.show(true);
            const restore = h.manager._restoreLatestHistory(h.tab);
            h.show(false);
            await restore;
            await h.settle();
            expectDeferred(h.tab);
            expect([h.term.cols, h.term.rows]).toEqual([80, 9]);
            expect(snapshot(h.term).lines.filter(Boolean)).toEqual([
                'LIVE',
                'TAIL',
            ]);
            expect(h.tab._historyBrowsing).toBe(false);
            expect(h.tab._historyLiveState).toBeNull();
            expect(h.tab._bootstrapGate).toBeNull();
            expect(h.tab._historyLoading).toBe(false);
            expect(h.tab.drainedSeq).toBe(encode(prefix + tail).length);
            expect(h.pty.holding).toBe(false);
        } finally {
            h.dispose();
        }
    });

    it.each([false, true])(
        'state history completion defers a panel hidden during fetch (latest=%s)',
        async (latest) => {
            const source = encode('BOOK TAIL\r\n');
            const h = hiddenReplay(source);
            h.manager._queuePanelFit = vi.fn();
            try {
                h.pty.ws.head({ epoch: 7, oldest: 0, head: source.length });
                await h.settle();
                h.show(true);
                h.tab._pendingPanelFit = h.tab._pendingForceResize = false;
                const recordingFetch = h.fetcher;
                let finishState, started;
                const requested = new Promise((resolve) => {
                    started = resolve;
                });
                const response = new Promise((resolve) => {
                    finishState = resolve;
                });
                vi.stubGlobal(
                    'fetch',
                    vi.fn((url, options) => {
                        if (String(url).includes('/state?')) {
                            started();
                            return response;
                        }
                        return recordingFetch(url, options);
                    }),
                );
                const task = h.manager._loadStateHistory(h.tab, latest);
                await requested;
                expect(h.pty.holding).toBe(false);
                h.show(false);
                const bytes = encode(latest ? 'CURRENT\r\n' : 'ARCHIVE ');
                const frontier = latest ? source.length : 0;
                finishState(
                    recordingEnvelope(bytes, frontier, frontier, {
                        oldest: 0,
                        head: frontier,
                        ckpt: {
                            kind: 'ansi-v1',
                            through: frontier,
                            cols: 90,
                            rows: 15,
                            len: bytes.length,
                        },
                    }),
                );
                await task;
                await h.settle();
                expectDeferred(h.tab);
                expect([h.term.cols, h.term.rows]).toEqual([90, 15]);
                expect(snapshot(h.term).lines.filter(Boolean)).toEqual([
                    latest ? 'CURRENT' : 'ARCHIVE BOOK TAIL',
                ]);
                expect(h.tab._historyBrowsing).toBe(!latest);
                expect(h.tab._historyError).toBeNull();
                expect(h.tab._bootstrapGate).toBeNull();
                expect(h.tab._historyRequest).toBeNull();
                expect(h.tab._historyTask).toBeNull();
                expect(h.tab._historyLoading).toBe(false);
                expect(h.tab._historyParsing).toBe(false);
                expect(h.pty.holding).toBe(false);
                expect(h.manager._queuePanelFit).toHaveBeenLastCalledWith(
                    h.tab,
                    { forceResize: true },
                );
            } finally {
                h.dispose();
            }
        },
    );
});
