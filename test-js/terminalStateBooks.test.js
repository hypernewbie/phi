// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    encode,
    recordingEnvelope,
    replayHarness,
} from './_terminalReplayHarness.js';
import { HISTORY_BOOK_BYTES } from '../web/terminal-history.js';
setupDomHarness();
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function stateEnvelope(bytes, through, epoch = 7) {
    return recordingEnvelope(bytes, through, through, {
        epoch,
        oldest: 0,
        head: through,
        ckpt: {
            kind: 'ansi-v1',
            through,
            cols: 240,
            rows: 12,
            len: bytes.length,
        },
    });
}
function rows(term) {
    return Array.from(
        { length: term.buffer.active.length },
        (_, i) => term.buffer.active.getLine(i)?.translateToString(true) || '',
    );
}
async function attached(source) {
    const h = replayHarness(source);
    h.manager._queuePanelFit = vi.fn();
    h.manager.app = { showToast: vi.fn() };
    const ansi = encode('LIVE SCREEN');
    h.pty.ws.head(
        {
            epoch: 7,
            oldest: 0,
            head: source.length,
            ckpt: {
                kind: 'ansi-v1',
                through: source.length,
                cols: 240,
                rows: 12,
                len: ansi.length,
            },
        },
        ansi,
    );
    await h.settle();
    h.tab.loadHistoryBtn = document.createElement('button');
    h.manager._updateHistoryButton(h.tab);
    return h;
}

it('a book starts from server parser state, preserving rendition and split UTF-8 without the library', async () => {
    const glyph = encode('🙂');
    const suffix = encode(
        ' BOOK_START\r\n' + 'short numbered row\r\n'.repeat(4000),
    );
    const tail = new Uint8Array(HISTORY_BOOK_BYTES);
    tail.set(glyph.subarray(2));
    tail.set(suffix.subarray(0, tail.length - 2), 2);
    const archive = encode('older library\r\n'.repeat(30000));
    const source = new Uint8Array(archive.length + tail.length);
    source.set(archive);
    source.set(tail, archive.length);
    const state = new Uint8Array(encode('\x1b[31m').length + 2);
    state.set(encode('\x1b[31m'));
    state.set(glyph.subarray(0, 2), state.length - 2);
    const h = await attached(source);
    const requests = [];
    try {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                const q = new URL(url, 'http://localhost').searchParams;
                requests.push(String(url));
                if (String(url).includes('/state?'))
                    return stateEnvelope(state, Number(q.get('through')));
                const from = Number(q.get('from')),
                    end = Number(q.get('through'));
                return recordingEnvelope(source.slice(from, end), from, end);
            }),
        );
        await h.manager._loadColdHistory(h.tab);
        expect(rows(h.term)).toContain('🙂 BOOK_START');
        expect(rows(h.term).join('\n')).not.toContain('\ufffd');
        const first = h.term.buffer.active.getLine(0).getCell(0);
        expect(first.getFgColor()).toBe(1);
        expect(requests).toHaveLength(2);
        expect(
            new URL(requests[1], 'http://localhost').searchParams.get('from'),
        ).toBe(String(archive.length));
        expect(h.tab._historyWindowStart).toBe(archive.length);
        expect(h.tab._historyBrowsing).toBe(true);
        expect(h.tab.drainedSeq).toBe(source.length);
        expect(h.manager._queuePanelFit).toHaveBeenLastCalledWith(h.tab, {
            forceResize: true,
        });
    } finally {
        h.dispose();
    }
});

it.each([
    { cols: 0 },
    { kind: 'unsupported' },
    { through: Number.MAX_SAFE_INTEGER },
])(
    'malformed snapshot %j closes instead of requesting the library',
    async (invalid) => {
        const h = await attached(encode('retained archive\r\n'.repeat(10000)));
        try {
            const next = h.socket(),
                bytes = encode('invalid state');
            next.ws.head(
                {
                    epoch: 7,
                    oldest: 0,
                    head: h.tab.drainedSeq,
                    ckpt: {
                        kind: 'ansi-v1',
                        through: h.tab.drainedSeq,
                        cols: 240,
                        rows: 12,
                        len: bytes.length,
                        ...invalid,
                    },
                },
                bytes,
            );
            await h.settle();
            expect(next.ws.closed).toBe(true);
            expect(h.requests).toHaveLength(0);
        } finally {
            h.dispose();
        }
    },
);

it('same-epoch reconnect replaces a damaged current parser with authoritative state', async () => {
    const h = await attached(encode('retained archive\r\n'.repeat(10000)));
    try {
        await new Promise((resolve) =>
            h.term.write('\x1b]0;unterminated local OSC', resolve),
        );
        const next = h.socket();
        const bytes = encode('AUTHORITATIVE CURRENT');
        next.ws.head(
            {
                epoch: 7,
                oldest: 0,
                head: h.tab.drainedSeq,
                ckpt: {
                    kind: 'ansi-v1',
                    through: h.tab.drainedSeq,
                    cols: 240,
                    rows: 12,
                    len: bytes.length,
                },
            },
            bytes,
        );
        await h.settle();
        expect(rows(h.term)).toContain('AUTHORITATIVE CURRENT');
        expect(h.requests).toHaveLength(0);
    } finally {
        h.dispose();
    }
});

it('explicit Refresh replaces a historical or corrupt view with bounded authoritative state', async () => {
    const h = await attached(encode('retained archive\r\n'.repeat(10000)));
    try {
        h.tab._historyBrowsing = true;
        h.tab._historyLiveState = { through: h.tab.drainedSeq };
        h.tab._forceStateRefresh = true;
        await new Promise((resolve) =>
            h.term.write('STALE BOOK\r\n'.repeat(100), resolve),
        );
        h.term.scrollToTop();
        const next = h.socket(),
            bytes = encode('REFRESHED LIVE');
        next.ws.head(
            {
                epoch: 7,
                oldest: 0,
                head: h.tab.drainedSeq,
                ckpt: {
                    kind: 'ansi-v1',
                    through: h.tab.drainedSeq,
                    cols: 240,
                    rows: 12,
                    len: bytes.length,
                },
            },
            bytes,
        );
        await h.settle();
        expect(rows(h.term)).toContain('REFRESHED LIVE');
        expect(rows(h.term).join('\n')).not.toContain('STALE BOOK');
        expect(h.tab._historyBrowsing).toBe(false);
        expect(h.tab._forceStateRefresh).toBe(false);
        expect(h.requests).toHaveLength(0);
    } finally {
        h.dispose();
    }
});

it('same-epoch reconnect preserves a visible local history book', async () => {
    const h = await attached(encode('retained archive\r\n'.repeat(10000)));
    try {
        const output = encode('VISIBLE HISTORY\r\n'.repeat(100));
        h.pty.ws.output(h.pty.liveSeq, output);
        await h.settle();
        h.term.scrollToTop();
        const before = rows(h.term);
        const next = h.socket();
        const bytes = encode('DIFFERENT CURRENT SCREEN');
        next.ws.head(
            {
                epoch: 7,
                oldest: 0,
                head: h.tab.drainedSeq,
                ckpt: {
                    kind: 'ansi-v1',
                    through: h.tab.drainedSeq,
                    cols: 240,
                    rows: 12,
                    len: bytes.length,
                },
            },
            bytes,
        );
        await h.settle();
        expect(rows(h.term)).toEqual(before);
    } finally {
        h.dispose();
    }
});

it('reconnecting an archived view restores the manual button without replacing the book', async () => {
    const h = await attached(encode('archive\r\n'.repeat(10000)));
    try {
        h.tab._historyBrowsing = true;
        const before = rows(h.term);
        h.tab.isDead = true;
        h.manager._updateHistoryButton(h.tab);
        expect(h.tab.loadHistoryBtn.classList.contains('hidden')).toBe(true);
        h.tab.isDead = false;
        const next = h.socket();
        const bytes = encode('DIFFERENT LIVE SCREEN');
        next.ws.head(
            {
                epoch: 7,
                oldest: 0,
                head: h.tab.drainedSeq,
                ckpt: {
                    kind: 'ansi-v1',
                    through: h.tab.drainedSeq,
                    cols: 240,
                    rows: 12,
                    len: bytes.length,
                },
            },
            bytes,
        );
        await h.settle();
        expect(rows(h.term)).toEqual(before);
        expect(h.tab.loadHistoryBtn.classList.contains('hidden')).toBe(false);
        expect(h.tab.loadHistoryBtn.disabled).toBe(false);
        expect(h.requests).toHaveLength(0);
    } finally {
        h.dispose();
    }
});

it('returning to live requests only a bounded latest state and adopts its exact frontier', async () => {
    const source = encode('archive\r\n'.repeat(20000));
    const h = await attached(source);
    try {
        h.tab._historyBrowsing = true;
        h.tab._historyLiveState = { epoch: 7, through: 10, head: 10 };
        const frontier = source.length + 18_000_000;
        const fetcher = vi.fn(async (url) => {
            expect(String(url)).toContain('through=latest');
            expect(String(url)).toContain('kind=ansi-v1');
            return stateEnvelope(encode('FRESH CURRENT SCREEN'), frontier);
        });
        vi.stubGlobal('fetch', fetcher);
        await h.manager._restoreLatestHistory(h.tab);
        expect(rows(h.term)).toContain('FRESH CURRENT SCREEN');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(h.pty.liveSeq).toBe(frontier);
        expect(h.tab.drainedSeq).toBe(frontier);
        expect(h.tab._historyBrowsing).toBe(false);
        h.pty.ws.output(frontier, encode(' LIVE_CONTINUES'));
        await h.settle();
        expect(rows(h.term)).toContain('FRESH CURRENT SCREEN LIVE_CONTINUES');
    } finally {
        h.dispose();
    }
});

it('transient failures retry the same requested book beyond three attempts', async () => {
    const h = await attached(encode('archive\r\n'.repeat(10000)));
    try {
        vi.useFakeTimers();
        let attempts = 0;
        const fetcher = vi.fn(async (url) => {
            const q = new URL(url, 'http://localhost').searchParams;
            if (String(url).includes('/state?')) {
                if (++attempts <= 4) return { ok: false, status: 503 };
                return stateEnvelope(
                    encode('BOOK STATE\r\n'),
                    Number(q.get('through')),
                );
            }
            const from = Number(q.get('from')),
                end = Number(q.get('through'));
            return recordingEnvelope(encode('x'.repeat(end - from)), from, end);
        });
        vi.stubGlobal('fetch', fetcher);
        const pending = h.manager._loadColdHistory(h.tab);
        await vi.runAllTimersAsync();
        await pending;
        expect(attempts).toBe(5);
        const states = fetcher.mock.calls
            .filter(([url]) => String(url).includes('/state?'))
            .map(([url]) => url);
        expect(new Set(states).size).toBe(1);
        expect(h.tab._historyError).toBeNull();
        expect(h.tab._historyBrowsing).toBe(true);
        expect(h.manager.app.showToast).toHaveBeenCalledTimes(1);
    } finally {
        h.dispose();
    }
});

it('permanent epoch rejection preserves the current view and reports the undelivered request', async () => {
    const h = await attached(encode('archive\r\n'.repeat(10000)));
    try {
        const before = rows(h.term);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 409 })),
        );
        await h.manager._loadColdHistory(h.tab);
        expect(rows(h.term)).toEqual(before);
        expect(h.tab._historyLoading).toBe(false);
        expect(h.tab._historyError).toContain('409');
        expect(h.tab.loadHistoryBtn.disabled).toBe(false);
        expect(h.tab.loadHistoryBtn.getAttribute('aria-busy')).toBe('false');
        expect(h.manager.app.showToast).toHaveBeenCalledWith(
            expect.stringContaining('not skipped'),
            expect.objectContaining({ type: 'error' }),
        );
    } finally {
        h.dispose();
    }
});

it('canceling a slow history request does not hold live frames or reset the current view', async () => {
    const source = encode('archive\r\n'.repeat(10000));
    const h = await attached(source);
    try {
        let entered;
        const admission = new Promise((resolve) => {
            entered = resolve;
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(
                (_url, options) =>
                    new Promise((_resolve, reject) => {
                        entered();
                        options.signal.addEventListener(
                            'abort',
                            () => reject(options.signal.reason),
                            { once: true },
                        );
                    }),
            ),
        );
        const pending = h.manager._loadColdHistory(h.tab);
        await admission;
        expect(h.tab.loadHistoryBtn.disabled).toBe(true);
        expect(h.tab.loadHistoryBtn.getAttribute('aria-busy')).toBe('true');
        await h.manager._loadColdHistory(h.tab);
        expect(fetch).toHaveBeenCalledOnce();
        h.pty.ws.output(source.length, encode(' LIVE_WHILE_WAITING'));
        await h.settle();
        expect(rows(h.term)).toContain('LIVE SCREEN LIVE_WHILE_WAITING');
        h.manager._cancelHistoryRequest(h.tab);
        await pending;
        expect(h.tab._historyLoading).toBe(false);
        expect(h.tab._historyBrowsing).not.toBe(true);
        expect(h.tab.loadHistoryBtn.disabled).toBe(false);
        expect(h.tab.loadHistoryBtn.getAttribute('aria-busy')).toBe('false');
        expect(h.manager.app.showToast).not.toHaveBeenCalled();
    } finally {
        h.dispose();
    }
});
