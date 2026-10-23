// @vitest-environment jsdom
// A moved retention floor must not turn one paging failure into a replay
// loop. The loop was: a history page fails after the terminal was reset ->
// the catch closed the WebSocket -> the re-attach repainted the whole view and
// left _historyBrowsing set -> the next wheel event paged again.
import { expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    encode,
    recordingEnvelope,
    replayHarness,
} from './_terminalReplayHarness.js';

setupDomHarness();

// A server state snapshot: header.head is the frontier, ckpt.through must
// match it, and oldest must not exceed the frontier.
const stateEnvelope = (oldest, through, text) =>
    recordingEnvelope(encode(text), through, through, {
        oldest,
        head: through,
        ckpt: {
            kind: 'ansi-v1',
            through,
            cols: 240,
            rows: 12,
            len: encode(text).length,
        },
    });

// A busy pane: live output arrived after the state snapshot, so the
// concurrent-tail replay must run and fail.
const busyPane = async (source) => {
    const h = replayHarness(source);
    const head = source.length;
    h.pty.ws.head({ epoch: 7, oldest: 0, head });
    await h.settle();
    h.pty.ws.output(head, encode('TAIL\r\n'));
    await h.settle();
    return { h, head };
};

it('a paging failure heals in place instead of re-attaching the socket', async () => {
    const source = encode('BOOK\r\n');
    const { h, head } = await busyPane(source);
    try {
        // First state request answers; the concurrent-tail replay cannot be
        // read, so the page fails after the terminal was already reset.
        let stateCalls = 0;
        const inner = h.fetcher;
        vi.stubGlobal(
            'fetch',
            vi.fn((url, options) => {
                const target = String(url);
                if (target.includes('/state?')) {
                    return stateCalls++ === 0
                        ? stateEnvelope(0, head, 'LIVE\r\n')
                        : stateEnvelope(0, head, 'LIVE\r\n');
                }
                if (target.includes('/recording?')) {
                    return { ok: false, status: 503 };
                }
                return inner(url, options);
            }),
        );
        const close = vi.spyOn(h.pty.ws, 'close');
        h.tab._historyBrowsing = true;
        h.tab.paneOldest = 0;

        await h.manager._loadStateHistory(h.tab, true);
        await h.settle();

        expect(h.tab._historyError).toBeTruthy();
        expect(close).not.toHaveBeenCalled();
        expect(h.tab._historyBrowsing).toBe(false);
        expect(h.tab._historyLoading).toBe(false);
        expect(h.tab.drainedSeq).toBe(head);
    } finally {
        h.dispose();
    }
});

it('a paging failure that cannot heal still leaves browsing mode', async () => {
    const source = encode('BOOK\r\n');
    const { h, head } = await busyPane(source);
    try {
        // The page's own state request answers; the heal that follows the
        // failure cannot, so there is no in-place recovery left.
        let stateCalls = 0;
        const inner = h.fetcher;
        vi.stubGlobal(
            'fetch',
            vi.fn((url, options) => {
                const target = String(url);
                if (target.includes('/state?')) {
                    return stateCalls++ === 0
                        ? stateEnvelope(0, head, 'LIVE\r\n')
                        : { ok: false, status: 503 };
                }
                if (target.includes('/recording?')) {
                    return { ok: false, status: 503 };
                }
                return inner(url, options);
            }),
        );
        const close = vi.spyOn(h.pty.ws, 'close');
        h.tab._historyBrowsing = true;

        await h.manager._loadStateHistory(h.tab, true);

        expect(close).toHaveBeenCalled();
        // The re-attach repaints everything. Staying in browsing mode is what
        // let the next wheel event start the same failure again.
        expect(h.tab._historyBrowsing).toBe(false);
        expect(h.tab._historyLoading).toBe(false);
    } finally {
        h.dispose();
    }
});

it('pages from the floor the server just reported, not the attach-time floor', async () => {
    const source = encode(
        Array.from({ length: 60000 }, (_, i) => `R${i}\r\n`).join(''),
    );
    const h = replayHarness(source);
    const head = source.length;
    try {
        h.pty.ws.head({ epoch: 7, oldest: 0, head });
        await h.settle();
        const floor = head - 200000; // the window rotated since the attach
        const inner = h.fetcher;
        vi.stubGlobal(
            'fetch',
            vi.fn((url, options) => {
                if (String(url).includes('/state?')) {
                    const through = Number(
                        new URL(url, 'http://localhost').searchParams.get(
                            'through',
                        ),
                    );
                    return stateEnvelope(floor, through, 'PAGE\r\n');
                }
                return inner(url, options);
            }),
        );
        h.tab.paneOldest = 0; // stale floor captured at the attach
        h.tab._historyWindowEnd = head;

        await h.manager._loadStateHistory(h.tab, false);
        await h.settle();

        expect(h.tab._historyBrowsing).toBe(true);
        expect(h.tab.paneOldest).toBe(floor);
        expect(h.tab._historyLoading).toBe(false);
    } finally {
        h.dispose();
    }
});

it('jump-to-latest on an evicted frontier heals instead of repeating the replay', async () => {
    // The reader is in a frozen archived view whose frontier the retention
    // floor has passed. Scrolling down re-enters the restore path on every
    // wheel event, so failing by re-attaching replays the pane forever.
    const source = encode('BOOK\r\n');
    const h = replayHarness(source);
    const head = source.length;
    try {
        h.pty.ws.head({ epoch: 7, oldest: 0, head });
        await h.settle();
        h.pty.ws.output(head, encode('TAIL\r\n'));
        await h.settle();
        h.tab._serverStateAvailable = false;
        h.tab._historyBrowsing = true;
        h.tab._historyLiveState = {
            epoch: 7,
            cols: 240,
            rows: 12,
            through: head,
            head,
            ansi: 'BOOK\r\n',
        };
        const inner = h.fetcher;
        vi.stubGlobal(
            'fetch',
            vi.fn((url, options) => {
                const target = String(url);
                if (target.includes('/state?'))
                    return stateEnvelope(0, head, 'LIVE\r\n');
                if (target.includes('/recording?'))
                    return { ok: false, status: 503 };
                return inner(url, options);
            }),
        );
        const close = vi.spyOn(h.pty.ws, 'close');

        await h.manager._restoreLatestHistory(h.tab);
        await h.settle();

        expect(close).not.toHaveBeenCalled();
        expect(h.tab._historyBrowsing).toBe(false);
        expect(h.tab._historyLoading).toBe(false);
        expect(h.tab.drainedSeq).toBe(head);
    } finally {
        h.dispose();
    }
});

it.each(['state', 'recording'])(
    'a failed %s request preserves an existing history view until live state is restored',
    async (endpoint) => {
        const source = encode('OLDER ROW\r\n'.repeat(15000));
        const head = source.length;
        const h = replayHarness(source);
        try {
            h.pty.ws.head({
                epoch: 7,
                oldest: 0,
                head,
                ckpt: {
                    through: head,
                    cols: 240,
                    rows: 12,
                    ansi: 'CURRENT\r\n',
                },
            });
            await h.settle();
            h.tab._serverStateAvailable = true;
            let fail = false;
            const inner = h.fetcher;
            vi.stubGlobal(
                'fetch',
                vi.fn((url, options) => {
                    const target = String(url);
                    const query = new URL(target, 'http://localhost')
                        .searchParams;
                    if (fail && target.includes(`/${endpoint}?`))
                        return { ok: false, status: 409 };
                    if (target.includes('/state?')) {
                        const latest = query.get('through') === 'latest';
                        return stateEnvelope(
                            0,
                            latest
                                ? h.pty.lastFrameEnd
                                : Number(query.get('through')),
                            latest
                                ? 'MISSED LIVE OUTPUT\r\nNEW LIVE OUTPUT\r\n'
                                : 'HISTORICAL CHECKPOINT\r\n',
                        );
                    }
                    return inner(url, options);
                }),
            );
            const close = vi.spyOn(h.pty.ws, 'close');
            await h.manager._loadStateHistory(h.tab);
            await h.settle();
            expect(h.tab._historyBrowsing).toBe(true);
            const saved = h.tab._historyLiveState;
            const skipped = encode('MISSED LIVE OUTPUT\r\n');
            h.pty.ws.output(head, skipped);
            await h.settle();
            const painted = h.tape.join('');
            fail = true;
            await h.manager._loadStateHistory(h.tab);
            await h.settle();
            expect(h.tab._historyError).toMatch(/unavailable/i);
            expect(h.tab._historyBrowsing).toBe(true);
            expect(h.tab._historyLiveState).toBe(saved);
            expect(h.tape.join('')).toBe(painted);
            expect(h.tab._historyLoading).toBe(false);
            h.pty.ws.output(
                head + skipped.length,
                encode('NEW LIVE OUTPUT\r\n'),
            );
            await h.settle();
            expect(h.tape.join('')).toBe(painted);
            fail = false;
            await h.manager._restoreLatestHistory(h.tab);
            await h.settle();
            expect(h.tab._historyBrowsing).toBe(false);
            expect(h.tab._historyLiveState).toBeNull();
            expect(h.tape.join('')).toContain('MISSED LIVE OUTPUT');
            expect(h.tape.join('')).toContain('NEW LIVE OUTPUT');
            expect(close).not.toHaveBeenCalled();
        } finally {
            h.dispose();
        }
    },
);

it('gives up on a permanently unavailable span instead of retrying forever', async () => {
    const h = replayHarness(encode('X\r\n'));
    const controller = new AbortController();
    const read = vi.fn(async () => null);
    try {
        vi.useFakeTimers();
        const settled = expect(
            h.manager._historyRead(h.tab, read, controller.signal),
        ).rejects.toThrow(/unavailable/i);
        await vi.runAllTimersAsync();
        await settled;
        expect(read.mock.calls.length).toBeGreaterThan(1);
        expect(read.mock.calls.length).toBeLessThanOrEqual(8);
    } finally {
        vi.useRealTimers();
        h.dispose();
    }
});
