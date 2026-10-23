// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    encode,
    recordingEnvelope,
    replayHarness,
} from './_terminalReplayHarness.js';

setupDomHarness();
afterEach(() => {
    vi.unstubAllGlobals();
});

function stateEnvelope(bytes, through, { epoch = 7, oldest = 0, cursor } = {}) {
    return recordingEnvelope(bytes, through, through, {
        epoch,
        oldest,
        head: through,
        ckpt: {
            kind: 'ansi-v1',
            through,
            cols: 240,
            rows: 12,
            len: bytes.length,
            ...(cursor === undefined ? {} : { event_cursor: cursor }),
        },
    });
}

const fail = (status) => ({ ok: false, status });

async function attached(source, headOpts = {}) {
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
            ...headOpts,
        },
        ansi,
    );
    await h.settle();
    h.tab.loadHistoryBtn = document.createElement('button');
    h.manager._updateHistoryButton(h.tab);
    return h;
}

it('expired ranges throw permanent failures while transient errors stay retryable', async () => {
    const h = replayHarness(encode('0123456789'));
    try {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fail(409)),
        );
        await expect(
            h.manager._fetchRecordingRangeOnce('pane', 0, 4, 7),
        ).rejects.toMatchObject({ historyPermanent: true });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fail(400)),
        );
        await expect(
            h.manager._fetchRecordingRangeOnce('pane', 0, 4, 7),
        ).rejects.toMatchObject({ historyPermanent: true });
        // An advanced start is an evicted prefix, not a delay.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => recordingEnvelope(encode('89'), 8, 10)),
        );
        await expect(
            h.manager._fetchRecordingRangeOnce('pane', 0, 10, 7),
        ).rejects.toMatchObject({ historyPermanent: true });
        // Transient failures return null so the existing retry paths run.
        const fetcher = vi.fn(async () => fail(503));
        vi.stubGlobal('fetch', fetcher);
        await expect(
            h.manager._fetchRecordingRangeOnce('pane', 0, 4, 7),
        ).resolves.toBe(null);
        await expect(
            h.manager._fetchRecordingRange('pane', 0, 4, 7),
        ).resolves.toBe(null);
        expect(fetcher).toHaveBeenCalledTimes(4);
        // Permanent failures skip the wrapper retries entirely.
        const permanent = vi.fn(async () => fail(409));
        vi.stubGlobal('fetch', permanent);
        await expect(
            h.manager._fetchRecordingRange('pane', 0, 4, 7),
        ).rejects.toMatchObject({ historyPermanent: true });
        expect(permanent).toHaveBeenCalledTimes(1);
    } finally {
        h.dispose();
    }
});

it('recording pages carry and chain the event cursor', async () => {
    const source = encode('0123456789abcdef');
    const h = replayHarness(source);
    const urls = [];
    try {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                const q = new URL(url, 'http://localhost').searchParams;
                urls.push(String(url));
                const from = Number(q.get('from'));
                const end = Math.min(Number(q.get('through')), from + 8);
                return recordingEnvelope(source.slice(from, end), from, end, {
                    event_cursor: `v1.7.${end}.${from}`,
                });
            }),
        );
        const range = await h.manager._fetchRecordingRange(
            'pane',
            0,
            16,
            7,
            'v1.7.0.0',
        );
        expect(new TextDecoder().decode(range.bytes)).toBe('0123456789abcdef');
        expect(range.endCursor).toBe('v1.7.16.8');
        expect(urls).toHaveLength(2);
        expect(
            new URL(urls[0], 'http://localhost').searchParams.get(
                'after_event_cursor',
            ),
        ).toBe('v1.7.0.0');
        expect(
            new URL(urls[1], 'http://localhost').searchParams.get(
                'after_event_cursor',
            ),
        ).toBe('v1.7.8.0');
    } finally {
        h.dispose();
    }
});

it('state history passes the checkpoint cursor to its range fetch', async () => {
    const source = encode('BOOK\r\n'.repeat(2000));
    const h = await attached(source);
    const urls = [];
    try {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                const u = String(url);
                urls.push(u);
                const q = new URL(u, 'http://localhost').searchParams;
                if (u.includes('/state?'))
                    return stateEnvelope(
                        encode('BOOK SCREEN'),
                        Number(q.get('through')),
                        {
                            cursor: 'v1.7.100.3',
                        },
                    );
                const from = Number(q.get('from')),
                    end = Number(q.get('through'));
                return recordingEnvelope(source.slice(from, end), from, end);
            }),
        );
        await h.manager._loadColdHistory(h.tab);
        const rangeUrl = new URL(urls[1], 'http://localhost');
        expect(rangeUrl.searchParams.get('after_event_cursor')).toBe(
            'v1.7.100.3',
        );
        expect(h.tab._historyBrowsing).toBe(true);
    } finally {
        h.dispose();
    }
});

it('a reconnect across the floor recovers through the live checkpoint', async () => {
    const live = encode('LIVE TAIL\r\n');
    const h = await attached(encode('old library\r\n'.repeat(500)));
    try {
        h.tab.drainedSeq = 50;
        h.tab.queuedSeq = 50;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                const u = String(url);
                if (u.includes('/state?')) return stateEnvelope(live, 1000);
                return fail(400);
            }),
        );
        const next = h.socket();
        next.ws.head({ epoch: 7, oldest: 100, head: 1000 });
        await h.settle();
        expect(next.ws.closed).not.toBe(true);
        expect(h.tab.drainedSeq).toBe(1000);
        expect(h.tab.paneOldest).toBe(0);
        expect(h.tab._bootstrapGate).toBe(null);
        expect(h.tape.join('')).toContain('LIVE TAIL');
    } finally {
        h.dispose();
    }
});

it('return to live falls back to live state when the saved frontier is evicted', async () => {
    const live = encode('BACK TO LIVE\r\n');
    const h = await attached(encode('archive\r\n'.repeat(500)));
    try {
        h.tab._historyBrowsing = true;
        h.tab._historyLiveState = {
            epoch: 7,
            head: 900,
            through: 50,
            cols: 240,
            rows: 12,
        };
        h.tab.paneOldest = 100;
        h.tab.ws.lastFrameEnd = 1000;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                const u = String(url);
                if (u.includes('/state?')) return stateEnvelope(live, 1000);
                return fail(409);
            }),
        );
        await h.manager._restoreLatestHistory(h.tab);
        await h.settle();
        expect(h.tab._historyBrowsing).toBe(false);
        expect(h.tab._historyLiveState).toBe(null);
        expect(h.tab.userFollowBottom).toBe(true);
        expect(h.tape.join('')).toContain('BACK TO LIVE');
    } finally {
        h.dispose();
    }
});

it('in-place latest recovery discards the saved state from the old history view', async () => {
    const source = encode('archive\r\n'.repeat(500));
    const h = await attached(source);
    const frontier = source.length + 100;
    try {
        h.tab._serverStateAvailable = false;
        h.tab._historyBrowsing = true;
        h.tab._historyLiveState = {
            epoch: 7,
            head: source.length,
            through: 50,
            cols: 240,
            rows: 12,
            ansi: 'SAVED OLD VIEW\r\n',
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) =>
                String(url).includes('/state?')
                    ? stateEnvelope(encode('RECOVERED LIVE VIEW\r\n'), frontier)
                    : fail(503),
            ),
        );
        await h.manager._restoreLatestHistory(h.tab);
        await h.settle();
        expect(h.tab._historyBrowsing).toBe(false);
        expect(h.tab._historyLiveState).toBe(null);
        expect(h.tab.drainedSeq).toBe(frontier);
        h.pty.ws.output(frontier, encode('AFTER RECOVERY\r\n'));
        await h.settle();
        expect(h.tape.join('')).toContain('RECOVERED LIVE VIEW');
        expect(h.tape.join('')).toContain('AFTER RECOVERY');
        // The next book must capture the recovered live frontier, not reuse
        // the old saved head and erase output received since that view.
        const ends = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                ends.push(
                    Number(
                        new URL(url, 'http://localhost').searchParams.get(
                            'through',
                        ),
                    ),
                );
                return fail(503);
            }),
        );
        const latest = h.tab.drainedSeq;
        await h.manager._loadColdHistory(h.tab);
        expect(ends[0]).toBe(latest);
        expect(h.pty.ws.closed).not.toBe(true);
    } finally {
        h.dispose();
    }
});

it('a live gap across the floor closes for an atomic reattach', async () => {
    const h = await attached(encode('live\r\n'.repeat(100)));
    try {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fail(409)),
        );
        await h.manager._onLiveGap(h.tab, h.tab.ws.liveSeq, 1000);
        expect(h.pty.ws.closed).toBe(true);
    } finally {
        h.dispose();
    }
});

it('cold history expiry reconnects to refresh the floor and ends loading', async () => {
    const h = await attached(encode('library\r\n'.repeat(500)));
    try {
        h.tab._serverStateAvailable = false;
        h.tab._historyOmitted = true;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fail(400)),
        );
        await h.manager._loadColdHistory(h.tab);
        expect(h.pty.ws.closed).toBe(true);
        expect(h.tab._historyLoading).toBe(false);
        expect(h.tab._bootstrapGate).toBe(null);
    } finally {
        h.dispose();
    }
});

it('old servers without cursors keep working without cursor parameters', async () => {
    const source = encode('BOOK\r\n'.repeat(2000));
    const h = await attached(source);
    const urls = [];
    try {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                const u = String(url);
                urls.push(u);
                const q = new URL(u, 'http://localhost').searchParams;
                if (u.includes('/state?'))
                    return stateEnvelope(
                        encode('BOOK SCREEN'),
                        Number(q.get('through')),
                    );
                const from = Number(q.get('from')),
                    end = Number(q.get('through'));
                return recordingEnvelope(source.slice(from, end), from, end);
            }),
        );
        await h.manager._loadColdHistory(h.tab);
        expect(h.tab._historyBrowsing).toBe(true);
        for (const u of urls) {
            expect(
                new URL(u, 'http://localhost').searchParams.get(
                    'after_event_cursor',
                ),
            ).toBe(null);
        }
    } finally {
        h.dispose();
    }
});
