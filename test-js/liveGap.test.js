// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Live-gap healing (hot-v1 §6): a small missing interval must patch
// invisibly through the normal write queue; only an oversize interval
// abandons with an honest banner. This file exists because `d.bytes`
// (always undefined — the fetch returns `byteLength`) once made the
// patch branch dead, so EVERY gap dropped bytes with a banner.

setupDomHarness();

function ctx(fetchImpl) {
    const c = Object.create(TabManager.prototype);
    c._fetchRecordingRange = vi.fn(fetchImpl);
    c.writeToTerminal = vi.fn();
    return c;
}

function pty() {
    return {
        mode: 'hot',
        liveSeq: 100,
        lastFrameEnd: 110,
        applyGapPatch: vi.fn(),
        abandonGap: vi.fn(),
    };
}

function tab(p) {
    return { paneId: 'p', isDead: false, ws: p, queuedSeq: 100 };
}

describe('_onLiveGap', () => {
    it('patches a small gap through the write queue with no banner', async () => {
        const p = pty();
        const c = ctx(async () => ({
            start: 100,
            end: 105,
            byteLength: 5,
            text: 'hello',
        }));
        await c._onLiveGap(tab(p), 100, 105);
        expect(p.applyGapPatch).toHaveBeenCalledTimes(1);
        expect(p.applyGapPatch.mock.calls[0][0]).toEqual(
            new TextEncoder().encode('hello'),
        );
        expect(p.abandonGap).not.toHaveBeenCalled();
        expect(c.writeToTerminal).not.toHaveBeenCalled();
    });

    it('abandons an oversize gap with an honest banner', async () => {
        const p = pty();
        const c = ctx(async () => null);
        const t = tab(p);
        await c._onLiveGap(t, 100, 100 + 70 * 1024);
        expect(p.applyGapPatch).not.toHaveBeenCalled();
        expect(p.abandonGap).toHaveBeenCalledWith(100 + 70 * 1024);
        expect(c.writeToTerminal).toHaveBeenCalledTimes(1);
        expect(String(c.writeToTerminal.mock.calls[0][1])).toContain(
            'output bytes dropped',
        );
    });

    it('abandons when the fetch misses the range start', async () => {
        const p = pty();
        const c = ctx(async () => ({
            start: 0, // truncated: ring no longer holds `from`
            end: 105,
            byteLength: 5,
            text: 'hello',
        }));
        await c._onLiveGap(tab(p), 100, 105);
        expect(p.applyGapPatch).not.toHaveBeenCalled();
        expect(p.abandonGap).toHaveBeenCalledWith(105);
    });

    it('ignores non-hot sockets', async () => {
        const p = pty();
        p.mode = 'legacy';
        const c = ctx(async () => {
            throw new Error('must not fetch on legacy path');
        });
        await c._onLiveGap(tab(p), 100, 105);
        expect(p.abandonGap).not.toHaveBeenCalled();
        expect(c.writeToTerminal).not.toHaveBeenCalled();
    });

    it('serializes overlapping gap events: one fetch, one patch', async () => {
        // A backpressure burst fires onGap per dropped frame while the
        // first patch is still fetching. Concurrent patches would deliver
        // stale bytes at the new head (duplication plus loss); the second
        // event must wait, and the first patch's flush re-fires if a gap
        // remains, so dropping it converges instead of stalling.
        const p = pty();
        let resolveFetch;
        const gate = new Promise((r) => {
            resolveFetch = r;
        });
        let fetchCalls = 0;
        const c = ctx(async () => {
            fetchCalls++;
            await gate;
            return { start: 100, end: 105, byteLength: 5, text: 'hello' };
        });
        const t = tab(p);
        const first = c._onLiveGap(t, 100, 105);
        const second = c._onLiveGap(t, 100, 108);
        await second; // returns immediately without fetching
        expect(fetchCalls).toBe(1);
        resolveFetch();
        await first;
        expect(p.applyGapPatch).toHaveBeenCalledTimes(1);
        expect(p.abandonGap).not.toHaveBeenCalled();
        expect(t._gapInFlight).toBe(false);
    });

    it('abandons a zero-byte patch instead of re-firing forever', async () => {
        // An empty patch would not advance liveSeq; flushing would re-fire
        // the same gap and fetch it again in a hot loop.
        const p = pty();
        const c = ctx(async () => ({
            start: 100,
            end: 105,
            byteLength: 0,
            text: '',
        }));
        await c._onLiveGap(tab(p), 100, 105);
        expect(p.applyGapPatch).not.toHaveBeenCalled();
        expect(p.abandonGap).toHaveBeenCalledWith(105);
    });
});

describe('_trackBootstrap', () => {
    it('prunes settled entries so reconnects do not leak slots', async () => {
        const c = Object.create(TabManager.prototype);
        const tab = {};
        let resolveIt;
        const gate = new Promise((r) => {
            resolveIt = r;
        });
        c._trackBootstrap(tab, gate);
        expect(tab._pendingBootstraps.length).toBe(1);
        resolveIt();
        await gate;
        await new Promise((r) => setTimeout(r, 0));
        expect(tab._pendingBootstraps.length).toBe(0);
    });

    it('swallows rejections without unhandled errors', async () => {
        const c = Object.create(TabManager.prototype);
        const tab = {};
        // A rejection with only this tracker attached must not surface
        // as an unhandled rejection (vitest fails the run on those).
        c._trackBootstrap(tab, Promise.reject(new Error('boom')));
        await new Promise((r) => setTimeout(r, 10));
        expect(tab._pendingBootstraps.length).toBe(0);
    });
});

describe('_bootstrapDelta', () => {
    it('drops an oversize delta without touching the buffer or watermarks', async () => {
        const c = ctx(async () => ({
            start: 0,
            end: 70000,
            byteLength: 70000,
            text: 'x'.repeat(70000),
        }));
        const t = {
            isDead: false,
            paneId: 'p',
            queuedSeq: 0,
            drainedSeq: 0,
        };
        await c._bootstrapDelta(t, 0, 70000);
        expect(c.writeToTerminal).not.toHaveBeenCalled();
        expect(t.queuedSeq).toBe(0);
        expect(t.drainedSeq).toBe(0);
    });

    it('appends an in-bounds delta and advances the watermarks', async () => {
        const c = ctx(async () => ({
            start: 90,
            end: 100,
            byteLength: 10,
            text: '0123456789',
        }));
        const t = {
            isDead: false,
            paneId: 'p',
            queuedSeq: 90,
            drainedSeq: 90,
        };
        await c._bootstrapDelta(t, 90, 100);
        expect(c.writeToTerminal).toHaveBeenCalledWith(t, '0123456789');
        expect(t.queuedSeq).toBe(100);
        expect(t.drainedSeq).toBe(100);
    });
});
