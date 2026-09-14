// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { TabManager, fnv1a64Hex } from '../web/terminal.js';

// Concept 4 (cold path): hash-cache negotiation for recording fetches.
// The client declares cached chunks via `have`; the server skips verified
// prefixes (204 when fully known). Assembly always starts at `from` or
// the call returns null, so _bootstrapDelta/_onLiveGap keep their exact
// d.start === from contract. Vectors match pkg/ws ChunkHash bit-for-bit.

function envelope(start, end, text, epoch = 7) {
    const payload = new TextEncoder().encode(text);
    const hdr = new TextEncoder().encode(
        JSON.stringify({ epoch, start, end, resizes: [] }),
    );
    const buf = new Uint8Array(4 + hdr.byteLength + payload.byteLength);
    new DataView(buf.buffer).setUint32(0, hdr.byteLength, false);
    buf.set(hdr, 4);
    buf.set(payload, 4 + hdr.byteLength);
    return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(0),
    };
}

function tm() {
    return Object.create(TabManager.prototype);
}

describe('fnv1a64Hex vectors (must match Go ChunkHash)', () => {
    const enc = (s) => new TextEncoder().encode(s);
    it('empty', () => {
        expect(fnv1a64Hex(enc(''))).toBe('cbf29ce484222325');
    });
    it('foobar', () => {
        expect(fnv1a64Hex(enc('foobar'))).toBe('85944171f73967e8');
    });
    it('a', () => {
        expect(fnv1a64Hex(enc('a'))).toBe('af63dc4c8601ec8c');
    });
});

describe('_fetchRecordingRange hash-cache loop', () => {
    it('cold fetch sends no have param and caches the chunk', async () => {
        const seen = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                seen.push(String(url));
                return envelope(0, 10, '0123456789');
            }),
        );
        const c = tm();
        const d = await c._fetchRecordingRange('p', 0, 10, 7);
        expect(d).not.toBeNull();
        expect(d.start).toBe(0);
        expect(d.text).toBe('0123456789');
        expect(seen[0]).not.toContain('have=');
        // Chunk is cached: the next call declares it with its hash.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                seen.push(String(url));
                return envelope(0, 10, '0123456789');
            }),
        );
        await c._fetchRecordingRange('p', 0, 10, 7);
        expect(seen[1]).toContain('have=0:10:');
        expect(seen[1]).toContain(
            fnv1a64Hex(new TextEncoder().encode('0123456789')),
        );
    });

    it('204 assembles wholly from cache with start === from', async () => {
        const c = tm();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => envelope(0, 10, '0123456789')),
        );
        await c._fetchRecordingRange('p', 0, 10, 7);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 204 })),
        );
        const d = await c._fetchRecordingRange('p', 0, 10, 7);
        expect(d).not.toBeNull();
        expect(d.start).toBe(0);
        expect(d.end).toBe(10);
        expect(d.text).toBe('0123456789');
    });

    it('cached prefix plus server suffix assemble to a from-anchored span', async () => {
        const c = tm();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => envelope(0, 10, '0123456789')),
        );
        await c._fetchRecordingRange('p', 0, 10, 7);
        // Server skips the verified [0,10) prefix, returns the suffix.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                expect(String(url)).toContain('from=0');
                expect(String(url)).toContain('have=0:10:');
                return envelope(10, 20, 'abcdefghij');
            }),
        );
        const d = await c._fetchRecordingRange('p', 0, 20, 7);
        expect(d).not.toBeNull();
        expect(d.start).toBe(0);
        expect(d.end).toBe(20);
        expect(d.text).toBe('0123456789abcdefghij');
    });

    it('epoch change neither declares nor reads stale chunks', async () => {
        const c = tm();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => envelope(0, 10, '0123456789')),
        );
        await c._fetchRecordingRange('p', 0, 10, 7);
        const seen = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                seen.push(String(url));
                return envelope(0, 10, '0123456789');
            }),
        );
        await c._fetchRecordingRange('p', 0, 10, 8);
        expect(seen[0]).not.toContain('have=');
        // Storing under the new epoch pruned the old one: epoch 7 now cold.
        const seen2 = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                seen2.push(String(url));
                return envelope(0, 10, '0123456789');
            }),
        );
        await c._fetchRecordingRange('p', 0, 10, 7);
        expect(seen2[0]).not.toContain('have=');
    });

    it('non-ok and malformed responses stay null (fallback preserved)', async () => {
        const c = tm();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 500 })),
        );
        expect(await c._fetchRecordingRange('p', 0, 10, 7)).toBeNull();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
            })),
        );
        expect(await c._fetchRecordingRange('p', 0, 10, 7)).toBeNull();
    });

    it('server span not anchored at the cursor returns null (truncation guard)', async () => {
        const c = tm();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => envelope(5, 10, '56789')),
        );
        expect(await c._fetchRecordingRange('p', 0, 10, 7)).toBeNull();
    });

    it('a stuck server that makes no progress returns null instead of looping', async () => {
        const c = tm();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => envelope(0, 0, '')),
        );
        expect(await c._fetchRecordingRange('p', 0, 10, 7)).toBeNull();
    });
});
