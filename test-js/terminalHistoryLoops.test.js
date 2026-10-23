// @vitest-environment jsdom
// Property test for the history-paging loop. The retention floor moves under
// a reader at any moment, so the invariants have to hold for every sequence
// of output, paging and reconnect, not for one hand-written scenario:
//
//   1. the tab always settles (no leaked load/parse/gate, no livelock);
//   2. one navigation action costs at most one socket close;
//   3. an action that repainted the view and then closed the socket must
//      leave the tab out of browsing mode. That pair is the replay loop: the
//      re-attach repaints the whole history and the next wheel event runs the
//      same miss again;
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

// Real terminal output is lines. The client arms history browsing from the
// rows it rendered (a pane with 10000 rows of scrollback keeps older bytes
// behind the view), so a single blob of bytes would never reach the code
// path that used to loop.
const LINE_BYTES = 20;
const filler = (n) => {
    const bytes = new Uint8Array(n).fill(0x4c);
    for (let i = LINE_BYTES - 1; i < n; i += LINE_BYTES) bytes[i] = 0x0a;
    return bytes;
};

// A server that keeps the newest `cap` bytes, like the retention window.
const server = (cap) => {
    const model = { oldest: 0, head: 0, cap, readsFail: false, burst: 512 << 10 };
    model.advance = (n) => {
        const from = model.head;
        model.head += n;
        model.oldest = Math.max(model.oldest, model.head - cap);
        return from;
    };
    // Same contract as Hub.Recording: the start is raised to the floor, the end
    // is lowered to the head, and a window the floor passed is refused.
    model.recording = (from, through) => {
        // A pane that cannot answer a range read: the client retries and
        // then gives up on the book.
        if (model.readsFail) return { ok: false, status: 503 };
        if (through <= model.oldest) return { ok: false, status: 400 };
        const start = Math.max(from, model.oldest);
        const end = Math.min(through, model.head);
        return recordingEnvelope(filler(Math.max(0, end - start)), start, end);
    };
    // Same contract as the /state endpoint: a frontier below the floor is a
    // permanent miss, anything else answers with the parser at that point.
    model.state = (through) => {
        if (model.failState) return { ok: false, status: 503 };
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
                // Build the answer first: the frontier is the server's head at
                // request time.
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

// A long session: the retained window holds more rows than the view, so the
// history controls arm at all. The server sends a checkpoint, so the client
// starts at the head and knows that older bytes exist.
const longSession = async (h, model) => {
    model.advance(512 << 10);
    h.pty.ws.head({
        epoch: 7,
        oldest: model.oldest,
        head: model.head,
        ckpt: { through: model.head, cols: 240, rows: 12, ansi: '' },
    });
    await h.settle();
    h.tab.paneOldest = model.oldest;
};

const SEEDS = [1, 2, 3, 5, 8, 13];
const OPS = 30;

// A browser pane runs one of two history modes, and the floor can move under
// both. Server state is what the browser uses today; the local archive is the
// fallback for a pane without a server checkpoint, and it is the path that
// replays recorded bytes.
const MODES = [
    { name: 'server-state', serverState: true },
    { name: 'local-archive', serverState: false },
];

for (const mode of MODES) {
    for (const seed of SEEDS) {
        it(`${mode.name} invariants hold for seed=${seed}`, async () => {
            const rng = prng(seed);
            const model = server(256 << 10);
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
                install(model);
                await longSession(h, model);
                h.tab._serverStateAvailable = mode.serverState;
                h.tab._historyOmitted = true;
                if (!mode.serverState) {
                    // The harness has to reach the state the bug lived in: a
                    // pane whose history is deeper than the view. Without this
                    // the whole sweep would be vacuous.
                    await h.manager._loadColdHistory(h.tab);
                    await h.settle();
                    expect(
                        Boolean(h.tab._historyOmitted),
                        'the page did not report older history behind the view',
                    ).toBe(true);
                }
                for (let step = 0; step < OPS; step++) {
                    const before = closes;
                    const painted = h.tape.length;
                    const op = Math.floor(rng() * 5);
                    const where = `${mode.name} seed=${seed} step=${step} op=${op}`;
                    const advance = async (fault = false) => {
                        const n = 1 + Math.floor(rng() * (48 << 10));
                        const from = model.advance(n);
                        pty.ws.output(from, filler(n));
                        // A busy pane answers transient errors instead. The
                        // local-archive path gives up on the book quickly; the
                        // server-state path retries for minutes, so it only
                        // sees the fault in the scenario test below.
                        model.readsFail = fault && !mode.serverState;
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
                        // in the middle and the pane stops answering, which is
                        // what stranded the replay.
                        await h.manager._loadColdHistory(h.tab);
                        await advance(true);
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
                    const reattaches = closes - before;
                    expect(reattaches, `${where} closed more than once`).toBeLessThanOrEqual(1);
                    const repainted = h.tape.length > painted;
                    if (reattaches > 0 && repainted && op !== 4) {
                        // A paging failure that repainted and then re-attached
                        // is the loop: the re-attach repaints the whole pane
                        // and, unlike a network drop, the client chose it.
                        // Staying in browsing mode let the next wheel event run
                        // the same miss again.
                        expect(
                            Boolean(h.tab._historyBrowsing),
                            `${where} repainted, re-attached and kept browsing`,
                        ).toBe(false);
                    }
                    // The frontier never runs ahead of the server and never falls
                    // behind what the socket already queued: a page that moves
                    // one without the other skipped or repeated a byte.
                    const queued = h.tab.queuedSeq ?? 0;
                    const drained = h.tab.drainedSeq ?? 0;
                    expect(queued, `${where} queued behind drained`).toBeGreaterThanOrEqual(drained);
                    expect(drained, `${where} drained ahead of the server head`).toBeLessThanOrEqual(model.head);
                    expect(Boolean(h.tab._gapInFlight), `${where} left a gap fetch in flight`).toBe(false);
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

it('a failed jump to the live tail cannot repeat itself', async () => {
    // The user's loop, in one scene: the reader sits in the archive view of a
    // long session (the local-archive path, no server checkpoint), the pane
    // keeps producing, and the server stops answering range reads. The old
    // code re-attached, the re-attach repainted the whole history, and the tab
    // stayed in browsing mode, so the next wheel event did it again.
    const model = server(256 << 10);
    const h = replayHarness(encode(''));
    let closes = 0;
    const original = h.pty.ws.close.bind(h.pty.ws);
    h.pty.ws.close = () => {
        closes += 1;
        return original();
    };
    try {
        install(model);
        await longSession(h, model);
        h.tab._serverStateAvailable = false;
        h.tab._historyOmitted = true;
        // The first page succeeds and arms the archive view.
        await h.manager._loadColdHistory(h.tab);
        await h.settle();
        expect(
            Boolean(h.tab._historyBrowsing),
            'the page did not enter the archive view, so the loop cannot run',
        ).toBe(true);
        // The pane keeps producing and stops answering range reads.
        model.advance(64 << 10);
        model.readsFail = true;
        await h.manager._restoreLatestHistory(h.tab);
        await h.settle();
        // At most one re-attach per action: a second one would repaint the
        // history again.
        expect(closes, 'the client re-attached more than once').toBeLessThanOrEqual(1);
        expect(
            Boolean(h.tab._historyBrowsing),
            'the tab stayed in browsing mode, so the next wheel event repeats the replay',
        ).toBe(false);
        // The reader can go back to the live tail without another failure.
        model.readsFail = false;
        await h.manager._restoreLatestHistory(h.tab);
        await h.settle();
        expect(Boolean(h.tab._historyBrowsing)).toBe(false);
    } finally {
        h.dispose();
    }
});

it('a paging loop stops even when the server never answers', async () => {
    const model = server(256 << 10);
    const h = replayHarness(encode(''));
    try {
        install(model);
        await longSession(h, model);
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
