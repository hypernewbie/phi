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
            h.pty.ws.head({
                epoch: 7,
                oldest: 0,
                head: 0,
                initialCols: 240,
                initialRows: 12,
            });
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

    it('same-epoch reconnect applies recorded replay geometry while hidden', async () => {
        const old = encode('OLD'),
            suffix = encode('CURRENT');
        const source = new Uint8Array([...old, ...suffix]);
        const h = hiddenReplay(source, ({ from, to }) =>
            recordingEnvelope(source.slice(from, to), from, to, {
                resizes: from === 0 ? [] : [[from, 90, 15]],
            }),
        );
        try {
            h.pty.ws.head({
                epoch: 7,
                oldest: 0,
                head: old.length,
                initialCols: 240,
                initialRows: 12,
            });
            await h.settle();
            expect([h.term.cols, h.term.rows]).toEqual([240, 12]);
            const next = h.socket();
            vi.spyOn(next, 'sendResize');
            next.ws.head({
                epoch: 7,
                oldest: 0,
                head: source.length,
                initialCols: 240,
                initialRows: 12,
            });
            await h.settle();
            expectDeferred(h.tab);
            expect([h.term.cols, h.term.rows]).toEqual([90, 15]);
            expect(h.tape.join('')).toBe('OLDCURRENT');
            expect(h.tab._bootstrapGate).toBeNull();
            expect(next.holding).toBe(false);
            expect(h.tab.drainedSeq).toBe(source.length);
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
            h.pty.ws.head({
                epoch: 7,
                oldest: 0,
                head: encode(prefix).length,
                initialCols: 240,
                initialRows: 12,
            });
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
        // The raw journal never evicts: a fresh replay starts at byte
        // zero, so the fixture carries no skipped prefix.
        const cut = encode(prefix).length;
        const source = encode(prefix + suffix);
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
            h.pty.ws.head({ epoch: 7, oldest: 0, head: source.length });
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

    it('replay completion defers a panel hidden during fetch', async () => {
        const source = encode('BOOK TAIL\r\n');
        let finishFetch;
        const gate = new Promise((resolve) => {
            finishFetch = resolve;
        });
        const h = hiddenReplay(source, ({ from, to }) =>
            gate.then(() =>
                recordingEnvelope(source.slice(from, to), from, to, {
                    resizes: [[0, 90, 15]],
                }),
            ),
        );
        h.manager._queuePanelFit = vi.fn();
        try {
            h.show(true);
            h.tab._pendingPanelFit = h.tab._pendingForceResize = false;
            h.pty.ws.head({
                epoch: 7,
                oldest: 0,
                head: source.length,
                initialCols: 240,
                initialRows: 12,
            });
            h.show(false);
            finishFetch();
            await h.settle();
            expectDeferred(h.tab);
            expect([h.term.cols, h.term.rows]).toEqual([90, 15]);
            expect(h.tape.join('')).toBe('BOOK TAIL\r\n');
            expect(h.tab._bootstrapGate).toBeNull();
            expect(h.tab._historyParsing).toBe(false);
            expect(h.pty.holding).toBe(false);
            expect(h.tab.drainedSeq).toBe(source.length);
        } finally {
            h.dispose();
        }
    });
});
