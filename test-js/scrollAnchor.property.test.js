// @vitest-environment jsdom
// Property suite for the reader anchor: a wheel gesture during a write backlog
// must keep the reader on the line they were reading.
//
// Anchor is the fixture line printed at the top of the viewport ("WHEEL nnnnnn"),
// never viewportY. A content marker survives recycling and reflow; an index does
// not, which is how the original jump-to-top bug hid from index-based tests.
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    encode,
    recordingEnvelope,
    replayHarness,
} from './_terminalReplayHarness.js';

setupDomHarness();

// One fixture line is one row: "WHEEL 000123 " + 40 chars + CRLF.
const LINE = 'WHEEL 000000 '.length + 40 + 2;
const chunkFor = (from, count) => {
    const lines = [];
    for (let i = 0; i < count; i++) {
        lines.push(
            `WHEEL ${String(from + i).padStart(6, '0')} ${'X'.repeat(40)}`,
        );
    }
    return encode(`${lines.join('\r\n')}\r\n`);
};

// Emits the fixture's numbered lines in ascending order, advancing the server
// model by the exact byte count so the client's sequence checks stay honest.
function writer(h, model) {
    let line = 0;
    const emit = (count) => {
        const from = model.advance(count * LINE);
        h.pty.ws.output(from, chunkFor(line, count));
        line += count;
    };
    emit.line = () => line;
    return emit;
}

// Minimal server model: the client may ask for a state checkpoint or a
// recording window at any time; both return numbered filler lines.
function serverModel(cap) {
    const model = { oldest: 0, head: 0, cap };
    model.advance = (n) => {
        const from = model.head;
        model.head += n;
        model.oldest = Math.max(model.oldest, model.head - cap);
        return from;
    };
    model.recording = (from, through) => {
        const start = Math.max(from, model.oldest);
        const end = Math.min(through, model.head);
        return recordingEnvelope(
            end > start
                ? chunkFor(0, Math.ceil((end - start) / LINE)).subarray(
                      0,
                      end - start,
                  )
                : new Uint8Array(0),
            start,
            end,
        );
    };
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
}

function installFetch(model) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
            const q = new URL(String(url), 'http://localhost').searchParams;
            if (String(url).includes('/state?'))
                return model.state(q.get('through'));
            if (String(url).includes('/recording?')) {
                return model.recording(
                    Number(q.get('from')),
                    Number(q.get('through')),
                );
            }
            return { ok: false, status: 404 };
        }),
    );
}

// The fixture line currently at the top of the viewport.
function topMarker(term) {
    const buffer = term.buffer.active;
    for (let i = buffer.viewportY; i < buffer.viewportY + term.rows; i++) {
        const text = buffer.getLine(i)?.translateToString(true) ?? '';
        const match = /WHEEL (\d{6})/.exec(text);
        if (match) return Number(match[1]);
    }
    return null;
}

function state(h) {
    const buffer = h.tab.term.buffer.active;
    return {
        top: topMarker(h.tab.term),
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        atBottom: buffer.viewportY >= buffer.baseY,
    };
}

async function paint(h, model, lines) {
    h.pty.ws.head({
        epoch: 7,
        oldest: model.oldest,
        head: model.head,
        ckpt: { through: model.head, cols: 240, rows: 12, ansi: '' },
    });
    await h.settle();
    const emit = writer(h, model);
    const step = 512;
    for (let done = 0; done < lines; done += step) {
        emit(Math.min(step, lines - done));
        await h.settle();
    }
    return emit;
}

// One real wheel notch, applied the way xterm applies it: the DOM listener only
// cancels follow, and the buffer scroll raises onScroll, which is where the
// production subscription anchors.
function wheel(h, rows) {
    h.manager._cancelScrollFollowForUserScroll(h.tab);
    h.tab.term.scrollLines(-rows);
}

// attachTab's reader-anchor subscriptions. The harness bypasses attachTab, so
// cases that expect anchoring call the same methods the subscriptions call, and
// the subscription registrations stay covered by the browser spec.
function installAnchorWiring(h) {
    h.tab.term.onScroll(() => h.manager._readerAnchorScroll(h.tab));
    h.tab.term.onResize(() => h.manager._clearReaderAnchor(h.tab));
}

// Deliver output frames without draining: this is the backlog that makes the
// viewport slide under the reader.
function queuedOutput(emit, frames, linesPerFrame) {
    for (let i = 0; i < frames; i++) emit(linesPerFrame);
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildOps(rng, count) {
    const ops = [];
    for (let i = 0; i < count; i++) {
        const roll = rng();
        if (roll < 0.3)
            ops.push({ kind: 'wheelUp', rows: 1 + Math.floor(rng() * 20) });
        else if (roll < 0.4)
            ops.push({ kind: 'wheelDown', rows: 1 + Math.floor(rng() * 20) });
        else if (roll < 0.55)
            ops.push({
                kind: 'queued',
                frames: 1 + Math.floor(rng() * 8),
                lines: 200 + Math.floor(rng() * 600),
            });
        else if (roll < 0.7)
            ops.push({ kind: 'write', lines: 100 + Math.floor(rng() * 900) });
        else if (roll < 0.8) ops.push({ kind: 'settle' });
        else ops.push({ kind: 'settle' });
    }
    return ops;
}

async function runOps(seed, ops) {
    const model = serverModel(1 << 24);
    const h = replayHarness(encode(''));
    const notices = [];
    h.manager.app = { showToast: (message) => notices.push(message) };
    installFetch(model);
    try {
        const emit = await paint(h, model, 15000);
        installAnchorWiring(h);
        for (const op of ops) {
            const before = state(h);
            const noticesBefore = notices.length;
            if (op.kind === 'wheelUp' || op.kind === 'wheelDown') {
                wheel(h, op.kind === 'wheelUp' ? op.rows : -op.rows);
            } else if (op.kind === 'queued') {
                queuedOutput(emit, op.frames, op.lines);
            } else if (op.kind === 'write') {
                emit(op.lines);
            }
            await h.settle();
            const after = state(h);
            const verdict = check(
                op,
                before,
                after,
                noticesBefore,
                notices.length,
            );
            if (verdict) {
                return {
                    ok: false,
                    seed,
                    op,
                    before,
                    after,
                    notices: notices.slice(),
                    reason: verdict,
                };
            }
        }
        return { ok: true, seed };
    } finally {
        h.dispose();
    }
}

// Invariants, all expressed in fixture-line numbers (content, not index).
function check(op, before, after, noticesBefore, noticesAfter) {
    if (before.top === null || after.top === null) return null;
    const moved = after.top - before.top; // positive = newer content on screen

    if (op.kind === 'wheelUp') {
        if (moved > 0) return `wheel up showed newer content (${moved})`;
        if (moved < -op.rows)
            return `wheel up moved ${-moved} rows, asked ${op.rows}`;
        if (moved === 0 && before.viewportY > 0)
            return 'wheel up was undone by the restore';
        return null;
    }
    if (op.kind === 'wheelDown') {
        if (moved < 0) return `wheel down showed older content (${moved})`;
        if (moved > op.rows)
            return `wheel down moved ${moved} rows, asked ${op.rows}`;
        return null;
    }
    // Data ops. At the tail, following new output is the point; only a reader
    // who scrolled up has a position that must not move.
    if (before.atBottom) return null;
    if (after.atBottom) {
        // Only legal when the reading position left the buffer during THIS op,
        // and it must be announced rather than silently shown as a jump.
        return noticesAfter > noticesBefore
            ? null
            : 'landed at live output without a fresh notice';
    }
    return moved === 0 ? null : `reading position drifted by ${moved} lines`;
}

describe('reader anchor property', () => {
    const seeds = Array.from({ length: 25 }, (_, i) => i + 1);

    for (const seed of seeds) {
        it(`keeps the reading position (seed ${seed})`, async () => {
            const rng = mulberry32(seed);
            const ops = buildOps(rng, 12);
            const result = await runOps(seed, ops);
            if (!result.ok) {
                throw new Error(
                    `seed ${result.seed} failed on ${JSON.stringify(result.op)}\n` +
                        `  before=${JSON.stringify(result.before)} after=${JSON.stringify(result.after)}\n` +
                        `  reason=${result.reason}\n` +
                        `  ops=${JSON.stringify(ops)}`,
                );
            }
            expect(result.ok).toBe(true);
        });
    }
});

describe('reader anchor unit cases', () => {
    it('repeated notches accumulate and are not undone', async () => {
        const model = serverModel(1 << 24);
        const h = replayHarness(encode(''));
        h.manager.app = { showToast: vi.fn() };
        installFetch(model);
        try {
            await paint(h, model, 15000);
            installAnchorWiring(h);
            const start = topMarker(h.tab.term);
            wheel(h, 5);
            await h.settle();
            wheel(h, 7);
            await h.settle();
            const now = topMarker(h.tab.term);
            expect(start - now).toBe(12);
        } finally {
            h.dispose();
        }
    });

    it('does not anchor on the alternate screen', async () => {
        const model = serverModel(1 << 24);
        const h = replayHarness(encode(''));
        installFetch(model);
        try {
            await paint(h, model, 15000);
            // A full-screen TUI takes the alternate buffer: no scrollback, so a
            // reader anchor there would be meaningless.
            await new Promise((resolve) =>
                h.tab.term.write('\x1b[?1049h', resolve),
            );
            h.tab.term.scrollLines(-5);
            h.manager._captureReaderAnchor(h.tab);
            expect(h.tab.term._phiReaderAnchor ?? null).toBe(null);
            await new Promise((resolve) =>
                h.tab.term.write('\x1b[?1049l', resolve),
            );
            h.manager._captureReaderAnchor(h.tab);
            expect(h.tab.term._phiReaderAnchor).toBeTruthy();
        } finally {
            h.dispose();
        }
    });

    it('announces an expired anchor instead of jumping silently', async () => {
        const model = serverModel(1 << 14);
        const h = replayHarness(encode(''));
        const showToast = vi.fn();
        h.manager.app = { showToast };
        installFetch(model);
        try {
            const emit = await paint(h, model, 15000);
            installAnchorWiring(h);
            wheel(h, 30);
            await h.settle();
            // More lines than the whole scrollback: the reader's row leaves the buffer.
            for (let i = 0; i < 4; i++) emit(6000);
            await h.settle();
            const now = state(h);
            expect(now.atBottom).toBe(true);
            expect(showToast).toHaveBeenCalledTimes(1);
        } finally {
            h.dispose();
        }
    });

    it('keeps the second of two notches, not the first', async () => {
        const model = serverModel(1 << 24);
        const h = replayHarness(encode(''));
        h.manager.app = { showToast: vi.fn() };
        installFetch(model);
        try {
            const emit = await paint(h, model, 15000);
            installAnchorWiring(h);
            wheel(h, 5);
            await h.settle();
            const first = topMarker(h.tab.term);
            wheel(h, 9);
            await h.settle();
            const second = topMarker(h.tab.term);
            expect(first - second).toBe(9);
            emit(400);
            await h.settle();
            expect(topMarker(h.tab.term)).toBe(second);
        } finally {
            h.dispose();
        }
    });

    it('does not anchor while browsing history', async () => {
        const model = serverModel(1 << 24);
        const h = replayHarness(encode(''));
        installFetch(model);
        try {
            await paint(h, model, 15000);
            h.tab._historyBrowsing = true;
            h.tab.term.scrollLines(-5);
            h.manager._captureReaderAnchor(h.tab);
            expect(h.tab.term._phiReaderAnchor ?? null).toBe(null);
        } finally {
            h.dispose();
        }
    });

    it('keyboard scrolling after a notch is not undone by output', async () => {
        const model = serverModel(1 << 24);
        const h = replayHarness(encode(''));
        h.manager.app = { showToast: vi.fn() };
        installFetch(model);
        try {
            const emit = await paint(h, model, 15000);
            installAnchorWiring(h);
            wheel(h, 3);
            await h.settle();
            // PageUp: the buffer scroll, not a DOM listener, is what moves the
            // view, so the subscription has to re-anchor here.
            h.tab.term.scrollLines(-20);
            await h.settle();
            const afterKeys = topMarker(h.tab.term);
            emit(300);
            await h.settle();
            expect(topMarker(h.tab.term)).toBe(afterKeys);
        } finally {
            h.dispose();
        }
    });

    it('a reset during reading clears the anchor without a notice', async () => {
        const model = serverModel(1 << 24);
        const h = replayHarness(encode(''));
        const showToast = vi.fn();
        h.manager.app = { showToast };
        installFetch(model);
        try {
            const emit = await paint(h, model, 15000);
            installAnchorWiring(h);
            wheel(h, 40);
            await h.settle();
            const { resetTerminalState } = await import(
                '../web/terminal-state.js'
            );
            resetTerminalState(h.tab.term);
            expect(h.tab.term._phiReaderAnchor ?? null).toBe(null);
            emit(300);
            await h.settle();
            expect(showToast).not.toHaveBeenCalled();
            expect(state(h).atBottom).toBe(true);
        } finally {
            h.dispose();
        }
    });

    it('expires the anchor through the real subscription, not a replaced row', async () => {
        const model = serverModel(1 << 14);
        const h = replayHarness(encode(''));
        const showToast = vi.fn();
        h.manager.app = { showToast };
        installFetch(model);
        try {
            const emit = await paint(h, model, 15000);
            installAnchorWiring(h);
            wheel(h, 30);
            await h.settle();
            const anchored = h.tab.term._phiReaderAnchor.marker.line;
            expect(anchored).toBe(h.tab.term.buffer.active.viewportY);

            // Output must not re-anchor per parsed row: the marker keeps tracking
            // the reader's row while recycling consumes it.
            emit(6000);
            await h.settle();
            expect(h.tab.term._phiReaderAnchor.marker.isDisposed).toBe(false);
            expect(h.tab.term._phiReaderAnchor.marker.line).toBeLessThan(
                anchored,
            );
            expect(h.tab.term._phiReaderAnchor.marker.line).toBe(
                h.tab.term.buffer.active.viewportY,
            );

            for (let i = 0; i < 3; i++) emit(6000);
            await h.settle();
            expect(state(h).atBottom).toBe(true);
            expect(showToast).toHaveBeenCalledTimes(1);
        } finally {
            h.dispose();
        }
    });

    it('a wheel during a pending backlog keeps the row the notch landed on', async () => {
        const model = serverModel(1 << 24);
        const h = replayHarness(encode(''));
        h.manager.app = { showToast: vi.fn() };
        installFetch(model);
        try {
            const emit = await paint(h, model, 15000);
            installAnchorWiring(h);
            // Queue frames without draining: the gesture lands while the parser
            // still owes rows, which is the case the browser hit.
            queuedOutput(emit, 6, 500);
            wheel(h, 4);
            const landed = topMarker(h.tab.term);
            emit(500);
            await h.settle();
            expect(topMarker(h.tab.term)).toBe(landed);
        } finally {
            h.dispose();
        }
    });

    it('a resize drops the anchor instead of reporting expiry', async () => {
        const model = serverModel(1 << 24);
        const h = replayHarness(encode(''));
        const showToast = vi.fn();
        h.manager.app = { showToast };
        installFetch(model);
        try {
            const emit = await paint(h, model, 15000);
            installAnchorWiring(h);
            wheel(h, 40);
            await h.settle();
            expect(h.tab.term._phiReaderAnchor).toBeTruthy();
            // Reflow can dispose the anchored row's marker while its text stays
            // in the buffer, so this is a move the app caused, not expiry.
            h.tab.term.resize(120, 30);
            await h.settle();
            expect(h.tab.term._phiReaderAnchor ?? null).toBe(null);
            emit(400);
            await h.settle();
            expect(showToast).not.toHaveBeenCalled();
        } finally {
            h.dispose();
        }
    });

    it('a scroll after a hidden expiry anchors the row it lands on', async () => {
        const model = serverModel(1 << 14);
        const h = replayHarness(encode(''));
        const showToast = vi.fn();
        h.manager.app = { showToast };
        installFetch(model);
        try {
            const emit = await paint(h, model, 15000);
            installAnchorWiring(h);
            wheel(h, 30);
            await h.settle();
            // Hidden pane: the batch expires the anchor, but the restore (and so
            // the notice and the jump to live output) is skipped.
            const visible = h.manager._terminalPanelVisible.bind(h.manager);
            h.manager._terminalPanelVisible = () => false;
            for (let i = 0; i < 4; i++) emit(6000);
            await h.settle();
            h.manager._terminalPanelVisible = visible;
            expect(h.tab.term._phiReaderAnchor.marker.isDisposed).toBe(true);
            expect(h.tab.term.buffer.active.viewportY).toBe(0);

            // The reader moves toward the bottom. That is a new gesture, not
            // recycling, so it must anchor the row it landed on (far enough from
            // the oldest row to survive the next batch).
            h.tab.term.scrollLines(5000);
            await h.settle();
            const moved = h.tab.term._phiReaderAnchor;
            expect(moved?.marker.isDisposed).toBe(false);
            emit(300);
            await h.settle();
            expect(showToast).not.toHaveBeenCalled();
            expect(state(h).atBottom).toBe(false);
            expect(h.tab.term.buffer.active.viewportY).toBe(moved.marker.line);
        } finally {
            h.dispose();
        }
    });
});
