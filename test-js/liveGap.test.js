// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager, termPerfLogSlowFit } from '../web/terminal.js';

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
            bytes: new TextEncoder().encode('hello'),
        }));
        await c._onLiveGap(tab(p), 100, 105);
        expect(p.applyGapPatch).toHaveBeenCalledTimes(1);
        expect(p.applyGapPatch.mock.calls[0][0]).toEqual(
            new TextEncoder().encode('hello'),
        );
        expect(p.abandonGap).not.toHaveBeenCalled();
        expect(c.writeToTerminal).not.toHaveBeenCalled();
    });

    it('patches raw bytes untouched, even when invalid as UTF-8', async () => {
        // A text round-trip would replace 0xFF 0xFE with U+FFFD pairs,
        // corrupting content and drifting every seq that follows.
        const raw = new Uint8Array([0xff, 0xfe]);
        const p = pty();
        const c = ctx(async () => ({
            start: 100,
            end: 102,
            byteLength: 2,
            bytes: raw,
            text: '\uFFFD\uFFFD',
        }));
        await c._onLiveGap(tab(p), 100, 102);
        expect(p.applyGapPatch).toHaveBeenCalledTimes(1);
        expect(p.applyGapPatch.mock.calls[0][0]).toBe(raw);
        expect(p.abandonGap).not.toHaveBeenCalled();
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
            bytes: new TextEncoder().encode('hello'),
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
            return {
                start: 100,
                end: 105,
                byteLength: 5,
                text: 'hello',
                bytes: new TextEncoder().encode('hello'),
            };
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

    it('a gate-waiter whose hole healed meanwhile dissolves silently', async () => {
        const p = pty();
        let resolveGate;
        const gate = new Promise((r) => {
            resolveGate = r;
        });
        const fetchMock = vi.fn(async () => ({
            start: 100,
            end: 108,
            byteLength: 8,
            bytes: new TextEncoder().encode('stale!!!'),
            text: 'stale!!!',
        }));
        const c = ctx(fetchMock);
        const t = tab(p);
        t._bootstrapGate = gate;
        const call = c._onLiveGap(t, 100, 108);
        // A flush-stop re-fire patched ahead while this event waited.
        p.liveSeq = 102;
        resolveGate();
        await call;
        expect(fetchMock).not.toHaveBeenCalled();
        expect(p.applyGapPatch).not.toHaveBeenCalled();
        expect(p.abandonGap).not.toHaveBeenCalled();
    });

    it('dissolves when a newer bootstrap generation begins mid-fetch', async () => {
        const p = pty();
        let resolveFetch;
        const gate = new Promise((r) => {
            resolveFetch = r;
        });
        const c = ctx(() => gate);
        const t = tab(p);
        t._bootstrapGen = 1;
        const call = c._onLiveGap(t, 100, 105);
        t._bootstrapGen = 2;
        resolveFetch({
            start: 100,
            end: 105,
            byteLength: 5,
            text: 'stale',
            bytes: new TextEncoder().encode('stale'),
        });
        await call;
        expect(p.applyGapPatch).not.toHaveBeenCalled();
        expect(p.abandonGap).not.toHaveBeenCalled();
        expect(c.writeToTerminal).not.toHaveBeenCalled();
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

describe('output-dropped control', () => {
    it('renders a local banner without touching seq accounting', () => {
        // The server sends this 0x02 off the byte stream precisely so a
        // slow-client warning never perturbs liveSeq / watermarks.
        const c = Object.create(TabManager.prototype);
        c.writeToTerminal = vi.fn();
        const tab = { paneId: 'p', queuedSeq: 100, drainedSeq: 100 };
        c.handleControlMessage(tab, { type: 'output-dropped' });
        expect(c.writeToTerminal).toHaveBeenCalledTimes(1);
        expect(String(c.writeToTerminal.mock.calls[0][1])).toContain(
            'slow client',
        );
        expect(tab.queuedSeq).toBe(100);
        expect(tab.drainedSeq).toBe(100);
    });
});

describe('perf readout without devtools', () => {
    it('logs one greppable line for attach latency on first write', () => {
        const c = Object.create(TabManager.prototype);
        c.updateDocumentTitle = vi.fn();
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const tab = {
                isDead: false,
                writeBuffer: '',
                writePending: false,
                userFollowBottom: true,
                term: {
                    buffer: { active: { viewportY: 0, baseY: 0 } },
                    write(d, cb) {
                        if (cb) cb();
                    },
                    scrollToBottom: vi.fn(),
                    _core: { viewport: { syncScrollArea: vi.fn() } },
                },
                _perfAttachAt: performance.now() - 100,
            };
            c.writeToTerminal(tab, 'hi');
            expect(info).toHaveBeenCalledTimes(1);
            expect(String(info.mock.calls[0][0])).toMatch(
                /\[phi-perf\] attach-to-first-write: \d+ms/,
            );
            // Second write stays silent: one line per attach.
            c.writeToTerminal(tab, 'hi');
            expect(info).toHaveBeenCalledTimes(1);
        } finally {
            info.mockRestore();
        }
    });

    it('warns only on genuinely slow fits (>=50ms)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            termPerfLogSlowFit(49.9, 80, 24, 100);
            expect(warn).not.toHaveBeenCalled();
            termPerfLogSlowFit(50, 80, 24, 10000);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toBe(
                '[phi-perf] slow fit: 50ms grid=80x24 buf=10000',
            );
        } finally {
            warn.mockRestore();
        }
    });
});

describe('_bootstrapDelta watermarks wait for parse', () => {
    function drainTab() {
        const callbacks = [];
        const tab = {
            isDead: false,
            writeBuffer: '',
            writePending: false,
            userFollowBottom: true,
            term: {
                buffer: { active: { viewportY: 0, baseY: 0 } },
                write(d, cb) {
                    callbacks.push(cb);
                },
                scrollToBottom: vi.fn(),
                _core: { viewport: { syncScrollArea: vi.fn() } },
            },
            queuedSeq: 90,
            drainedSeq: 90,
            paneId: 'p',
            ws: { mode: 'hot' },
        };
        return { tab, callbacks };
    }

    it('does not advance watermarks until xterm parses the delta', async () => {
        const c = Object.create(TabManager.prototype);
        c.updateDocumentTitle = vi.fn();
        c._scheduleCheckpointUpload = vi.fn();
        c._fetchRecordingRange = vi.fn(async () => ({
            start: 90,
            end: 100,
            byteLength: 10,
            bytes: new TextEncoder().encode('0123456789'),
            text: '0123456789',
        }));
        const released = vi.fn();
        const { tab, callbacks } = drainTab();
        const p = c._bootstrapDelta(tab, 90, 100, undefined, released);
        await new Promise((r) => setTimeout(r, 0));
        // Enqueued and released, but xterm has not parsed: watermarks
        // must still show the honest pre-parse frontier.
        expect(released).toHaveBeenCalledTimes(1);
        expect(tab.drainedSeq).toBe(90);
        expect(tab.queuedSeq).toBe(90);
        expect(callbacks.length).toBe(1);
        callbacks.shift()();
        await p;
        expect(tab.queuedSeq).toBe(100);
        expect(tab.drainedSeq).toBe(100);
    });
});

describe('write drain advances the checkpoint watermark', () => {
    function drainTab(mode) {
        const stored = [];
        return {
            tab: {
                isDead: false,
                writeBuffer: '',
                writePending: false,
                userFollowBottom: true,
                term: {
                    buffer: { active: { viewportY: 5, baseY: 5 } },
                    write(d, cb) {
                        stored.push(d);
                        if (cb) cb();
                    },
                    scrollToBottom: vi.fn(),
                    _core: { viewport: { syncScrollArea: vi.fn() } },
                },
                queuedSeq: 100,
                drainedSeq: 50,
                ws: { mode },
            },
            stored,
        };
    }

    it('hot: drained batch advances drainedSeq and schedules an upload', () => {
        const c = Object.create(TabManager.prototype);
        c.updateDocumentTitle = vi.fn();
        c._scheduleCheckpointUpload = vi.fn();
        const { tab, stored } = drainTab('hot');
        c.writeToTerminal(tab, 'hi');
        expect(stored).toEqual(['hi']);
        expect(tab.drainedSeq).toBe(100);
        expect(c._scheduleCheckpointUpload).toHaveBeenCalledWith(tab);
    });

    it('legacy: drained batch leaves the hot watermark alone', () => {
        const c = Object.create(TabManager.prototype);
        c.updateDocumentTitle = vi.fn();
        c._scheduleCheckpointUpload = vi.fn();
        const { tab } = drainTab('legacy');
        c.writeToTerminal(tab, 'hi');
        expect(tab.drainedSeq).toBe(50);
        expect(c._scheduleCheckpointUpload).not.toHaveBeenCalled();
    });
});

describe('bootstrap gate', () => {
    it('a gap patch waits for the in-flight delta so order holds', async () => {
        // Gap during attach fetch: patch bytes are newer than the delta
        // and must enqueue after it, never before.
        const p = pty();
        let resolveGate;
        const gate = new Promise((r) => {
            resolveGate = r;
        });
        const fetchMock = vi.fn(async () => ({
            start: 100,
            end: 105,
            byteLength: 5,
            text: 'hello',
            bytes: new TextEncoder().encode('hello'),
        }));
        const c = ctx(fetchMock);
        const t = tab(p);
        t._bootstrapGate = gate;
        const gapCall = c._onLiveGap(t, 100, 105);
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchMock).not.toHaveBeenCalled();
        resolveGate();
        await gapCall;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(p.applyGapPatch).toHaveBeenCalledTimes(1);
    });

    it('a swapped socket during the gate wait aborts the patch', async () => {
        const p = pty();
        const fetchMock = vi.fn(async () => ({
            start: 100,
            end: 105,
            byteLength: 5,
            text: 'hello',
            bytes: new TextEncoder().encode('hello'),
        }));
        const c = ctx(fetchMock);
        const t = tab(p);
        let resolveGate;
        t._bootstrapGate = new Promise((r) => {
            resolveGate = r;
        });
        const gapCall = c._onLiveGap(t, 100, 105);
        t.ws = { mode: 'hot' }; // reconnect won the race
        resolveGate();
        await gapCall;
        expect(fetchMock).not.toHaveBeenCalled();
        expect(p.applyGapPatch).not.toHaveBeenCalled();
    });
});

function recordingEnvelope(text, start, end) {
    const bytes = new TextEncoder().encode(text);
    const json = new TextEncoder().encode(
        JSON.stringify({ epoch: 7, start, end, resizes: [] }),
    );
    const buf = new Uint8Array(4 + json.byteLength + bytes.byteLength);
    new DataView(buf.buffer).setUint32(0, json.byteLength, false);
    buf.set(json, 4);
    buf.set(bytes, 4 + json.byteLength);
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(0) };
}

describe('recording fetch', () => {
    it('bounds the fetch with a timeout so delivery startup cannot hang', async () => {
        const c = Object.create(TabManager.prototype);
        let seenInit;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                seenInit = init;
                return recordingEnvelope('delta', 0, 5);
            }),
        );
        try {
            const d = await c._fetchRecordingRange('p', 0, 5);
            expect(d.text).toBe('delta');
            expect(seenInit?.signal instanceof AbortSignal).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('degrades without a timeout on browsers lacking AbortSignal.timeout', async () => {
        const c = Object.create(TabManager.prototype);
        const realTimeout = AbortSignal.timeout;
        let seenInit;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                seenInit = init;
                return recordingEnvelope('delta', 0, 5);
            }),
        );
        try {
            Object.defineProperty(AbortSignal, 'timeout', {
                configurable: true,
                value: undefined,
            });
            const d = await c._fetchRecordingRange('p', 0, 5);
            expect(d.text).toBe('delta');
            expect(seenInit?.signal).toBe(undefined);
        } finally {
            Object.defineProperty(AbortSignal, 'timeout', {
                configurable: true,
                value: realTimeout,
            });
            vi.unstubAllGlobals();
        }
    });
});

describe('_bootstrappedRelease generation', () => {
    it('a superseded bootstrap writes nothing and releases nothing', async () => {
        const c = Object.create(TabManager.prototype);
        c.writeToTerminal = vi.fn();
        const resolvers = [];
        c._fetchRecordingRange = vi.fn(
            () =>
                new Promise((r) => {
                    resolvers.push(r);
                }),
        );
        const pty = { mode: 'hot', release: vi.fn() };
        const tab = {
            isDead: false,
            paneId: 'p',
            paneEpoch: 7,
            ws: pty,
            queuedSeq: 100,
            writeBuffer: '',
            writePending: false,
        };
        c._bootstrappedRelease(tab, pty, 0, 100);
        c._bootstrappedRelease(tab, pty, 50, 100);
        resolvers[0]({ start: 0, end: 100, byteLength: 5, text: 'STALE' });
        await new Promise((r) => setTimeout(r, 0));
        resolvers[1]({ start: 50, end: 100, byteLength: 5, text: 'FRESH' });
        await Promise.all(tab._pendingBootstraps || []);
        await new Promise((r) => setTimeout(r, 0));
        const texts = c.writeToTerminal.mock.calls.map((call) => call[1]);
        expect(texts).toEqual(['FRESH']);
        expect(pty.release).toHaveBeenCalledTimes(1);
        expect(tab._bootstrapGate).toBe(null);
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
            writeBuffer: '',
            writePending: false,
        };
        await c._bootstrapDelta(t, 90, 100);
        expect(c.writeToTerminal).toHaveBeenCalledWith(t, '0123456789');
        expect(t.queuedSeq).toBe(100);
        expect(t.drainedSeq).toBe(100);
    });
});
