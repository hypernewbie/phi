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

it('transient failures retry twice, then stay a null the caller reconnects on', async () => {
    const fetcher = vi.fn(async () => {
        throw new Error('disconnected');
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await manager()._fetchReplayPages('p', 0, 4, 7)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockClear();
    let calls = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            calls++;
            if (calls < 3) throw new Error('disconnected');
            return recordingEnvelope(encode('data'), 0, 4);
        }),
    );
    const page = await manager()._fetchReplayPages('p', 0, 4, 7);
    expect(page?.end).toBe(4);
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
