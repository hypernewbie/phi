// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { encode, recordingEnvelope } from './_terminalReplayHarness.js';

setupDomHarness();
afterEach(() => vi.unstubAllGlobals());
const manager = () => Object.create(TabManager.prototype);

it('recovery reads bytes and current geometry without hashes or cached-prefix negotiation', async () => {
    const m = manager();
    let resizes = [[0, 80, 24]];
    const fetcher = vi.fn(async (url) => {
        expect(String(url)).not.toContain('have=');
        expect(String(url)).toContain('/replay?');
        expect(String(url)).toContain('epoch=7');
        return recordingEnvelope(encode('data'), 0, 4, { resizes });
    });
    vi.stubGlobal('fetch', fetcher);
    expect((await m._fetchReplayPages('p', 0, 4, 7)).resizes).toEqual(resizes);
    // Geometry metadata can change at the same output frontier. Byte-only
    // cache validation cannot authorize reusing an older geometry header.
    resizes = [
        [0, 80, 24],
        [4, 120, 40],
    ];
    expect((await m._fetchReplayPages('p', 0, 4, 7)).resizes).toEqual(resizes);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(m._recChunkCache).toBeUndefined();
});

it('one request per call: the caller pages, parses, and chains between responses', async () => {
    const data = encode('0123456789abcdefghij');
    const fetcher = vi.fn(async (url) => {
        const q = new URL(url, 'http://localhost').searchParams;
        const start = Number(q.get('from'));
        const end = Math.min(start + 10, Number(q.get('through')));
        return recordingEnvelope(data.slice(start, end), start, end);
    });
    vi.stubGlobal('fetch', fetcher);
    // Mimic the bootstrap loop: advance the start, chain the end cursor.
    const seen = [];
    let cursor = 0;
    let chained;
    for (let i = 0; i < 3; i++) {
        const page = await manager()._fetchReplayPages('p', cursor, 20, 7, {
            afterCursor: chained,
        });
        seen.push(page);
        cursor = page.end;
        chained = page.endCursor;
        if (cursor >= 20) break;
    }
    expect(cursor).toBe(20);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(Array.from(seen[0].bytes)).toEqual(Array.from(data.slice(0, 10)));
    expect(Array.from(seen[1].bytes)).toEqual(Array.from(data.slice(10, 20)));
    // The second request chains the first page's end cursor.
    expect(String(fetcher.mock.calls[1][0])).toContain(
        `after_event_cursor=${encodeURIComponent(seen[0].endCursor)}`,
    );
});

it('a failed read leaves retry decisions to the bounded recovery episode', async () => {
    const fetcher = vi.fn(async () => {
        throw new Error('disconnected');
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await manager()._fetchReplayPages('p', 0, 4, 7)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
});

it('a skipped prefix stays a transient null, never an admitted gap', async () => {
    // A server that skips prefixes is not obeyed and not trusted: the
    // caller retries, then reattaches for a fresh certified head.
    vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
            recordingEnvelope(encode('data'), 0, 4, { start: 1 }),
        ),
    );
    expect(await manager()._fetchReplayPagesOnce('p', 0, 4, 7)).toBeNull();
});

it('latest mode trims an overrunning page to the requested end', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
            expect(String(url)).toContain('through=latest');
            return recordingEnvelope(encode('0123456789'), 0, 10);
        }),
    );
    const page = await manager()._fetchReplayPagesOnce(
        'p',
        0,
        5,
        7,
        undefined,
        {
            latest: true,
        },
    );
    expect([page.start, page.end, page.byteLength]).toEqual([0, 5, 5]);
    expect(Array.from(page.bytes)).toEqual(Array.from(encode('01234')));
});

it.each([
    ['epoch mismatch', { epoch: 8 }],
    ['unsafe epoch', { epoch: Number.MAX_SAFE_INTEGER + 1 }],
    ['wrong byte length', { end: 5 }],
    ['no progress', { end: 0, event_cursor: undefined }],
    ['missing geometry event', { event_cursor: 'v1.7.4.1' }],
    [
        'uncounted geometry event',
        { event_cursor: 'v1.7.4.0', resizes: [[2, 100, 30]] },
    ],
    [
        'too many geometry events',
        {
            event_cursor: 'v1.7.4.257',
            resizes: Array.from({ length: 257 }, () => [2, 100, 30]),
        },
    ],
    ['marker past end', { resizes: [[5, 80, 24]] }],
    ['zero columns', { resizes: [[0, 0, 24]] }],
    ['noninteger rows', { resizes: [[0, 80, 1.5]] }],
    ['unbounded columns', { resizes: [[0, 65536, 24]] }],
    [
        'unsorted geometry',
        {
            resizes: [
                [4, 80, 24],
                [0, 120, 40],
            ],
        },
    ],
])('invalid replay %s is rejected before parsing', async (_label, extra) => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => recordingEnvelope(encode('data'), 0, 4, extra)),
    );
    expect(await manager()._fetchReplayPagesOnce('p', 0, 4, 7)).toBeNull();
});

it('fenced pages must certify the exact requested byte and geometry target', async () => {
    for (const extra of [
        { through: 5, through_event_cursor: 'v1.7.5.1' },
        { through_event_cursor: 'v1.7.4.2' },
        { through_event_cursor: undefined },
    ]) {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                recordingEnvelope(encode('data'), 0, 4, {
                    event_cursor: 'v1.7.4.1',
                    resizes: [[2, 100, 30]],
                    ...extra,
                }),
            ),
        );
        expect(
            await manager()._fetchReplayPagesOnce('p', 0, 4, 7, undefined, {
                afterCursor: 'v1.7.0.0',
                throughCursor: 'v1.7.4.1',
            }),
        ).toBeNull();
    }
});

it.each([204, 500])(
    'HTTP %i cannot authorize skipping source bytes',
    async (status) => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: status === 204, status })),
        );
        expect(await manager()._fetchReplayPagesOnce('p', 0, 4, 7)).toBeNull();
    },
);

it.each([400, 404, 409, 413])(
    'HTTP %i ends the range with a typed permanent failure',
    async (status) => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status })),
        );
        await expect(
            manager()._fetchReplayPagesOnce('p', 0, 4, 7),
        ).rejects.toMatchObject({
            historyPermanent: true,
        });
    },
);

it('only a same-epoch certified 409 can replace a replay frontier', async () => {
    const valid = {
        epoch: 7,
        oldest: 2,
        head: 4,
        floor_cols: 80,
        floor_rows: 24,
        head_cols: 100,
        head_rows: 30,
        floor_event_cursor: 'v1.7.2.1',
        event_cursor: 'v1.7.4.2',
    };
    for (const [status, info, accepted] of [
        [409, valid, true],
        [404, valid, false],
        [409, { ...valid, epoch: 8 }, false],
        [409, { ...valid, floor_event_cursor: 'v1.7.1.1' }, false],
        [409, { ...valid, event_cursor: 'v1.7.4.0' }, false],
        [409, { ...valid, floor_event_cursor: undefined }, false],
    ]) {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response('replay expired', {
                        status,
                        headers: {
                            'X-Phi-Replay-Window': JSON.stringify(info),
                        },
                    }),
            ),
        );
        try {
            await manager()._fetchReplayPages('p', 0, 4, 7);
            throw new Error('refusal accepted as data');
        } catch (error) {
            expect(error.historyPermanent).toBe(true);
            expect(Boolean(error.replayWindow)).toBe(accepted);
        }
    }
});

it('the response body shares the remaining episode deadline', async () => {
    vi.useFakeTimers();
    try {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, { signal }) => ({
                ok: true,
                status: 200,
                arrayBuffer: () =>
                    new Promise((_resolve, reject) =>
                        signal.addEventListener(
                            'abort',
                            () =>
                                reject(
                                    new DOMException('aborted', 'AbortError'),
                                ),
                            { once: true },
                        ),
                    ),
            })),
        );
        const read = manager()._fetchReplayPages('p', 0, 4, 7, {
            deadline: Date.now() + 100,
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(await read).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});

it('malformed envelopes and network failures leave the interval unfilled', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([0, 1]).buffer,
        })),
    );
    expect(await manager()._fetchReplayPagesOnce('p', 0, 4, 7)).toBeNull();
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('disconnected');
        }),
    );
    expect(await manager()._fetchReplayPagesOnce('p', 0, 4, 7)).toBeNull();
});
