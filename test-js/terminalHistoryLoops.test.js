// @vitest-environment jsdom
// Property test for the history-paging loop. The retention floor moves under
// a reader at any moment, so the invariants have to hold for every sequence of
// output, paging and reconnect, not for one hand-written scenario:
//
//   1. the tab always settles (no leaked load/parse/gate, no livelock);
//   2. one navigation action costs at most one socket close;
//   3. a close leaves the tab out of browsing mode, so the next wheel event
//      cannot start the same action again. That pair is the replay loop;
//   4. the frontier never runs ahead of the server nor behind the queue, and
//      no gap fetch is left in flight.
//
// The server is modelled here rather than replayed, so any sequence of floors
// and heads can be produced cheaply. Seeds are fixed and printed on failure.
import { expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    encode,
    recordingEnvelope,
    replayHarness,
} from './_terminalReplayHarness.js';

setupDomHarness();

// mulberry32: deterministic, no dependency.
const prng = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const filler = (n) => new Uint8Array(n).fill(0x58);

// A server that keeps the newest `cap` bytes, like the retention window.
const server = (cap) => {
    const model = { oldest: 0, head: 0, cap, failReads: 0 };
    model.advance = (n) => {
        const from = model.head;
        model.head += n;
        model.oldest = Math.max(model.oldest, model.head - cap);
        // A busy pane can also answer transient errors. The client retries a
        // range three times, so an exhausted read fails the whole page.
        if (model.failReads > 0) model.failReads -= 1;
        return from;
    };
    // Same contract as Hub.Recording: the start is raised to the floor, the end
    // is lowered to the head, and a window the floor passed is refused.
    model.recording = (from, through) => {
        if (model.failReads > 0) {
            model.failReads -= 1;
            return { ok: false, status: 503 };
        }
        if (through <= model.oldest) return { ok: false, status: 400 };
        const start = Math.max(from, model.oldest);
        const end = Math.min(through, model.head);
        return recordingEnvelope(filler(Math.max(0, end - start)), start, end);
    };
    // Same contract as the /state endpoint: a frontier below the floor is a
    // permanent miss, anything else answers with the parser at that point.
    model.state = (through) => {
        const frontier = through === 'latest' ? model.head : Number(through);
        if (frontier < model.oldest) return { ok: false, status: 409 };
        const bytes = encode('LIVE\r\n');
        return recordingEnvelope(bytes, frontier, frontier, {
            oldest: model.oldest,
            head: frontier,
            ckpt: {
                kind: 'ansi-v1',
                through: frontier,
                cols: 240,
                rows: 12,
                len: bytes.length,
            },
        });
    };
    return model;
};

const install = (model, { stateBroken = false } = {}) => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
            const query = new URL(String(url), 'http://localhost').searchParams;
            if (String(url).includes('/state?')) {
                if (stateBroken) return { ok: false, status: 503 };
                return model.state(query.get('through'));
            }
            if (String(url).includes('/recording?')) {
                return model.recording(
                    Number(query.get('from')),
                    Number(query.get('through')),
                );
            }
            return { ok: false, status: 404 };
        }),
    );
};

// A settled tab is one with no load in flight. Undefined is as good as false:
// the flags only exist while something is running.
const settled = (tab) => {
    expect(Boolean(tab._historyLoading)).toBe(false);
    expect(Boolean(tab._historyParsing)).toBe(false);
    expect(tab._bootstrapGate ?? null).toBeNull();
    expect(tab._historyRequest ?? null).toBeNull();
};

const SEEDS = [1, 2, 3, 5, 8, 13];
const OPS = 30;

// A browser pane runs one of two history modes, and the floor can move under
// both. Server state is what the browser uses today; the local archive is the
// fallback for a pane without a server checkpoint.
const MODES = [
    { name: 'server-state', serverState: true },
    { name: 'local-archive', serverState: false },
];

for (const mode of MODES) {
    for (const seed of SEEDS) {
        it(`${mode.name} invariants hold for seed=${seed}`, async () => {
            const rng = prng(seed);
            const model = server(64 << 10);
            const h = replayHarness(encode(''));
            // Count closes instead of reading a sticky flag, and count them per
            // socket so a redial starts from zero again.
            let closes = 0;
            let pty = h.pty;
            const track = (socket) => {
                const original = socket.ws.close.bind(socket.ws);
                socket.ws.close = () => {
                    closes += 1;
                    return original();
                };
                return socket;
            };
            track(pty);
            try {
                model.advance(1000);
                pty.ws.head({ epoch: 7, oldest: model.oldest, head: model.head });
                await h.settle();
                // The reader is deep enough into the pane's output for paging
                // to be offered at all.
                h.tab._serverStateAvailable = mode.serverState;
                h.tab._historyOmitted = true;
                install(model);
                for (let step = 0; step < OPS; step++) {
                    const before = closes;
                    const op = Math.floor(rng() * 5);
                    const where = () => `${mode.name} seed=${seed} step=${step} op=${op}`;
                    const advance = async () => {
                        const n = 1 + Math.floor(rng() * (48 << 10));
                        // Sometimes the pane answers transient errors instead.
                        if (rng() < 0.3) model.failReads = 2 + Math.floor(rng() * 3);
                        const from = model.advance(n);
                        pty.ws.output(from, filler(n));
                        await h.settle();
                    };
                    if (op === 0) {
                        // Output arrives, so the floor moves.
                        await advance();
                    } else if (op === 1) {
                        await h.manager._loadColdHistory(h.tab);
                    } else if (op === 2) {
                        // The wheel path: jump back to the live tail.
                        await h.manager._restoreLatestHistory(h.tab);
                    } else if (op === 3) {
                        // What a reader actually does on a busy pane: read older
                        // history, keep working while output streams, then go
                        // back to the tail. The floor passes the saved frontier
                        // in the middle, which is what a paging miss needs.
                        await h.manager._loadColdHistory(h.tab);
                        await advance();
                        await h.manager._restoreLatestHistory(h.tab);
                    } else {
                        // A network drop: the client redials and gets a new head.
                        pty.ws.close();
                        pty = track(h.socket());
                        pty.ws.head({
                            epoch: 7,
                            oldest: model.oldest,
                            head: model.head,
                            ckpt: { through: model.head, cols: 240, rows: 12, ansi: 'LIVE\r\n' },
                        });
                    }
                    await h.settle();
                    settled(h.tab);
                    const where2 = where();
                    const reattaches = closes - before;
                    expect(reattaches, `${where2} closed more than once`).toBeLessThanOrEqual(1);
                    if (reattaches > 0 && op !== 4) {
                        // A paging failure that ends in a close is the loop: the
                        // re-attach repaints the whole pane and, unlike a network
                        // drop, the client chose it. Staying in browsing mode let
                        // the next wheel event run the same miss again.
                        expect(
                            Boolean(h.tab._historyBrowsing),
                            `${where2} closed after a paging failure but kept browsing`,
                        ).toBe(false);
                    }
                    // The frontier never runs ahead of the server and never falls
                    // behind what the socket already queued: a page that moves
                    // one without the other skipped or repeated a byte.
                    const queued = h.tab.queuedSeq ?? 0;
                    const drained = h.tab.drainedSeq ?? 0;
                    expect(queued, `${where2} queued behind drained`).toBeGreaterThanOrEqual(drained);
                    expect(drained, `${where2} drained ahead of the server head`).toBeLessThanOrEqual(model.head);
                    expect(Boolean(h.tab._gapInFlight), `${where2} left a gap fetch in flight`).toBe(false);
                }
                // The reader can still loop through after a whole run of churn.
                await h.manager._loadColdHistory(h.tab);
                await h.manager._restoreLatestHistory(h.tab);
                await h.settle();
                settled(h.tab);
                expect(Boolean(h.tab._historyBrowsing)).toBe(false);
            } finally {
                h.dispose();
            }
        });
    }
}

it('a paging loop stops even when the server never answers', async () => {
    const model = server(64 << 10);
    const h = replayHarness(encode(''));
    try {
        model.advance(4096);
        h.pty.ws.head({ epoch: 7, oldest: model.oldest, head: model.head });
        await h.settle();
        h.tab._serverStateAvailable = true;
        h.tab._historyOmitted = true;
        install(model, { stateBroken: true });
        // The retry ceiling is wall-clock, so drive the clock instead of
        // waiting out the backoff.
        vi.useFakeTimers();
        const before = h.pty.ws.closed;
        const paging = h.manager._loadColdHistory(h.tab);
        await vi.runAllTimersAsync();
        await paging;
        await h.settle();
        vi.useRealTimers();
        settled(h.tab);
        expect(h.pty.ws.closed).toBe(before);
        expect(Boolean(h.tab._historyBrowsing)).toBe(false);
    } finally {
        vi.useRealTimers();
        h.dispose();
    }
});