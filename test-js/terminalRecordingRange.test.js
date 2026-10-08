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
        expect(String(url)).toContain('epoch=7');
        return recordingEnvelope(encode('data'), 0, 4, { resizes });
    });
    vi.stubGlobal('fetch', fetcher);
    expect((await m._fetchRecordingRange('p', 0, 4, 7)).resizes).toEqual(
        resizes,
    );
    // Geometry metadata can change at the same output frontier. Byte-only
    // cache validation cannot authorize reusing an older geometry header.
    resizes = [
        [0, 80, 24],
        [4, 120, 40],
    ];
    expect((await m._fetchRecordingRange('p', 0, 4, 7)).resizes).toEqual(
        resizes,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(m._recChunkCache).toBeUndefined();
});

it('positive-progress response parts form an exact source interval', async () => {
    const data = encode('0123456789abcdefghij');
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
            const q = new URL(url, 'http://localhost').searchParams;
            const start = Number(q.get('from'));
            const end = Math.min(start + 10, Number(q.get('through')));
            return recordingEnvelope(data.slice(start, end), start, end);
        }),
    );
    const range = await manager()._fetchRecordingRange('p', 0, 20, 7);
    expect(Array.from(range.bytes)).toEqual(Array.from(data));
    expect([range.start, range.end, range.byteLength]).toEqual([0, 20, 20]);
});

it('a requested book succeeds even when the server returns more than 68 positive-progress parts', async () => {
    const data = encode('a'.repeat(90));
    const fetcher = vi.fn(async (url) => {
        const from = Number(
            new URL(url, 'http://localhost').searchParams.get('from'),
        );
        return recordingEnvelope(data.slice(from, from + 1), from, from + 1);
    });
    vi.stubGlobal('fetch', fetcher);
    const range = await manager()._fetchRecordingRangeOnce(
        'p',
        0,
        data.length,
        7,
    );
    expect(Array.from(range?.bytes || [])).toEqual(Array.from(data));
    expect(fetcher).toHaveBeenCalledTimes(90);
});

it.each([
    ['skipped prefix', { start: 1 }],
    ['epoch mismatch', { epoch: 8 }],
    ['unsafe epoch', { epoch: Number.MAX_SAFE_INTEGER + 1 }],
    ['wrong byte length', { end: 5 }],
    ['no progress', { end: 0 }],
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
])('invalid recording %s is rejected before parsing', async (_label, extra) => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => recordingEnvelope(encode('data'), 0, 4, extra)),
    );
    expect(await manager()._fetchRecordingRangeOnce('p', 0, 4, 7)).toBeNull();
});

it.each([204, 409, 500])(
    'HTTP %i cannot authorize skipping source bytes',
    async (status) => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: status === 204, status })),
        );
        expect(
            await manager()._fetchRecordingRangeOnce('p', 0, 4, 7),
        ).toBeNull();
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
    expect(await manager()._fetchRecordingRangeOnce('p', 0, 4, 7)).toBeNull();
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('disconnected');
        }),
    );
    expect(await manager()._fetchRecordingRangeOnce('p', 0, 4, 7)).toBeNull();
});
