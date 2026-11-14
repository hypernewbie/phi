// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import { encode, replayHarness } from './_terminalReplayHarness.js';

setupDomHarness();
const { Terminal } = createHeadlessSandbox();
const write = (term, data) =>
    new Promise((resolve) => term.write(data, resolve));
function visible(term) {
    const buffer = term.buffer.active;
    return {
        cols: term.cols,
        rows: term.rows,
        type: buffer.type,
        cursor: [buffer.cursorX, buffer.cursorY],
        lines: Array.from({ length: buffer.length }, (_, i) =>
            buffer.getLine(i).translateToString(true),
        ),
    };
}

it('every zero-delta resume sends current dimensions even when the grid is unchanged', async () => {
    const h = replayHarness(encode(''));
    try {
        h.term.resize(80, 24);
        h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
        await h.settle();
        for (let attempt = 0; attempt < 2; attempt++) {
            const next = h.socket();
            const resize = vi.spyOn(next, 'sendResize');
            next.ws.head({ epoch: 7, oldest: 0, head: 0 });
            await h.settle();
            expect(resize).toHaveBeenCalledExactlyOnceWith(80, 24);
            expect(next.holding).toBe(false);
            expect(h.tab._sizedGrid?.ws).toBe(next);
        }
        expect(h.requests).toEqual([]);
    } finally {
        h.dispose();
    }
});

it('replay parsing finishes before fit, backend resize and held-live release', async () => {
    const h = replayHarness(encode('SNAP'));
    let finish;
    let parsed;
    const barrier = new Promise((resolve) => {
        parsed = resolve;
    });
    const nativeWrite = h.term.write.bind(h.term);
    h.term.write = (data, callback) =>
        nativeWrite(data, () => {
            finish = callback;
            parsed();
        });
    const resize = vi.spyOn(h.pty, 'sendResize');
    const fit = vi.fn(() => h.term.resize(100, 30));
    h.tab.fitAddon = { fit };
    try {
        h.pty.ws.head({ epoch: 7, oldest: 0, head: 4 });
        await barrier;
        expect(fit).not.toHaveBeenCalled();
        expect(resize).not.toHaveBeenCalled();
        expect(h.pty.holding).toBe(true);
        finish();
        await h.settle();
        expect(fit).toHaveBeenCalledOnce();
        expect(resize).toHaveBeenCalledExactlyOnceWith(100, 30);
        expect(h.pty.holding).toBe(false);
        expect(h.term.buffer.active.getLine(0).translateToString(true)).toBe(
            'SNAP',
        );
    } finally {
        h.dispose();
    }
});

it('a failed bootstrap fit closes and clears its gate, then recovers without repeating parsed bytes', async () => {
    const source = encode('BOOT tail');
    const h = replayHarness(source);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.tab.fitAddon = {
        fit: vi.fn(() => {
            throw new Error('panel temporarily detached');
        }),
    };
    try {
        h.pty.ws.head({ epoch: 7, oldest: 0, head: 4 });
        h.pty.ws.output(4, source.slice(4));
        await h.settle();
        expect(h.pty.ws.closed).toBe(true);
        expect(h.tab._bootstrapGate).toBeNull();
        expect(h.tab.drainedSeq).toBe(4);
        h.tab.fitAddon.fit.mockImplementation(() => {});
        const next = h.socket();
        next.ws.head({ epoch: 7, oldest: 0, head: source.length });
        await h.settle();
        expect(h.tape.join('')).toBe('BOOT tail');
        expect(h.tab.drainedSeq).toBe(source.length);
        expect(next.holding).toBe(false);
    } finally {
        warning.mockRestore();
        h.dispose();
    }
});

it.each([false, true])(
    'replacement epoch restores recorded geometry before painting (alternate=%s)',
    async (alternate) => {
        const ansi = `${alternate ? '\x1b[?1049h' : ''}\x1b[6;71HRIGHT`;
        const h = replayHarness(encode(ansi));
        try {
            h.term.resize(20, 4);
            h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
            await h.settle();
            const next = h.socket();
            next.ws.head({
                epoch: 8,
                oldest: 0,
                head: encode(ansi).length,
                initialCols: 80,
                initialRows: 6,
            });
            await h.settle();
            expect(h.term.cols).toBe(80);
            expect(h.term.rows).toBe(6);
            expect(
                h.term.buffer.active.getLine(5).translateToString(true),
            ).toContain('RIGHT');
            expect(h.tab.drainedSeq).toBe(encode(ansi).length);
        } finally {
            h.dispose();
        }
    },
);

it.each([
    ['normal', 'start \x1b[38;2;200;50;10m你🙂 RED\x1b[0m\r\nnext'],
    ['alternate', 'before\r\n\x1b[?1049h\x1b[2J\x1b[3;4H你🙂\x1b[?1049l after'],
    [
        'parser continuation',
        'A\x1b]0;title\x07\x1b(0lqqk\x1b(B\x1b[31m你\x1b[0mB',
    ],
])(
    'byte-by-byte disconnect/reconnect preserves uninterrupted %s state',
    async (_name, program) => {
        const source = encode(program);
        const h = replayHarness(source);
        const reference = new Terminal({
            cols: 240,
            rows: 12,
            scrollback: 10000,
        });
        try {
            await write(reference, program);
            // The fresh parser starts at the recorded baseline, so the
            // fixture baseline matches the reference grid exactly.
            h.pty.ws.head({
                epoch: 7,
                oldest: 0,
                head: 0,
                initialCols: 240,
                initialRows: 12,
            });
            await h.settle();
            for (let i = 0; i < source.length; i++) {
                h.tab.ws.ws.output(i, source.slice(i, i + 1));
                await h.settle();
                h.tab.ws.ws.close();
                const next = h.socket();
                next.ws.head({ epoch: 7, oldest: 0, head: i + 1 });
                await h.settle();
            }
            expect(visible(h.term)).toEqual(visible(reference));
            expect(h.tape.join('')).toBe(program);
            expect(h.tab.drainedSeq).toBe(source.length);
            expect(h.tab.writePending).toBe(false);
            expect(h.tab.writeBuffer).toBe('');
        } finally {
            reference.dispose();
            h.dispose();
        }
    },
);

// A pane socket the server closed at the admitted token exp must not redial
// with that same expired token: maybeAutoReconnect keeps the backoff timer and
// waits for the due refresh before handing the tab to reconnectTab.
it('waits for a due refresh before redialing an expired pane', async () => {
    const h = replayHarness(encode(''));
    try {
        vi.useFakeTimers();
        h.manager.app = { config: { auto_reconnect: 'visible' } };
        h.manager.activePaneId = h.tab.paneId;
        h.manager.tabs.set(h.tab.paneId, h.tab);
        h.tab.isDead = true;
        h.tab.termContainer = { querySelector: () => null };
        const redial = vi.fn();
        h.manager.reconnectTab = redial;

        let releaseRefresh;
        const refresh = new Promise((resolve) => {
            releaseRefresh = resolve;
        });
        const refreshCalls = vi.fn(() => refresh);
        window.phiAccessAuth = { refreshAccessIfDue: refreshCalls };

        expect(h.manager.maybeAutoReconnect(h.tab)).toBe(true);
        // The backoff timer fires, but the redial waits on the refresh.
        await vi.advanceTimersByTimeAsync(
            h.tab.autoReconnectTimerDelay ?? 21000,
        );
        expect(refreshCalls).toHaveBeenCalledTimes(1);
        expect(redial).not.toHaveBeenCalled();

        releaseRefresh();
        await Promise.resolve();
        await Promise.resolve();
        expect(redial).toHaveBeenCalledTimes(1);
    } finally {
        delete window.phiAccessAuth;
        vi.useRealTimers();
    }
});

it('same-epoch reconnect holds live output behind its delta replay', async () => {
    const source = encode('OLDNEW');
    const h = replayHarness(source);
    try {
        h.term.resize(80, 24);
        h.pty.ws.head({ epoch: 7, oldest: 0, head: 3 });
        await h.settle();
        expect(h.tape.join('')).toContain('OLD');

        const next = h.socket();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const baseFetch = globalThis.fetch;
        let delayed = false;
        vi.stubGlobal('fetch', async (url, options) => {
            if (String(url).includes('/replay') && !delayed) {
                delayed = true;
                await gate;
            }
            return baseFetch(url, options);
        });
        next.ws.head({ epoch: 7, oldest: 0, head: 6 });
        next.ws.output(6, encode('LIVE'));
        expect(next.holding).toBe(true);
        release();
        await h.settle();
        const tape = h.tape.join('');
        expect(tape).toContain('NEW');
        expect(tape.indexOf('NEW')).toBeLessThan(tape.indexOf('LIVE'));
        expect(next.holding).toBe(false);
    } finally {
        h.dispose();
    }
});
