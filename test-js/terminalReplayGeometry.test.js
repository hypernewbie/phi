// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    replayHarness,
    recordingEnvelope,
    encode,
} from './_terminalReplayHarness.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';

setupDomHarness();
let h;
afterEach(() => {
    h?.dispose();
    h = null;
    vi.unstubAllGlobals();
});

it('cancels a stalled replay fetch without waiting for the network timeout', async () => {
    h = replayHarness(new Uint8Array());
    h.tab.termContainer = document.createElement('div');
    document.body.appendChild(h.tab.termContainer);
    h.manager._fitVisibleTerminal = () => {};
    let signal;
    h.fetcher.mockImplementation(
        (_url, options) =>
            new Promise((_resolve, reject) => {
                signal = options.signal;
                signal.addEventListener('abort', () =>
                    reject(new DOMException('Cancelled', 'AbortError')),
                );
            }),
    );
    h.pty.ws.head({ epoch: 7, oldest: 0, head: 300000 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const cancel = h.tab.termContainer.querySelector('.replay-progress-cancel');
    expect(cancel).not.toBeNull();
    cancel.click();
    await h.settle();
    expect(signal.aborted).toBe(true);
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(h.tab.termContainer.querySelector('.replay-progress')).toBeNull();
    expect(h.tab.drainedSeq).toBe(300000);
    h.pty.ws.output(300000, encode('live'));
    await h.settle();
    expect(h.tape.join('')).toContain('live');
    h.tab.termContainer.remove();
});

it('cancels an oversized decompressed replay body before reading more chunks', async () => {
    h = replayHarness(new Uint8Array());
    const cancel = vi.fn();
    h.fetcher.mockImplementation(async () => ({
        ok: true,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(4 + 65536 + (2 << 20) + 1));
            },
            cancel,
        }),
    }));
    const page = await h.manager._fetchReplayPagesOnce(
        'p',
        0,
        1,
        7,
        undefined,
        { throughCursor: 'v1.7.1.0' },
    );
    expect(page).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
});

it.each([false, true])(
    'cold replay forwards startup replies only for a fresh pane (fresh=%s)',
    async (fresh) => {
        const source = encode('A\x1b[6n');
        h = replayHarness(source);
        h.tab._freshReplay = fresh;
        const replies = [];
        h.term.onData((data) => {
            if (!h.tab._historyParsing) replies.push(data);
        });
        h.pty.ws.head({ epoch: 7, oldest: 0, head: source.length });
        await h.settle();
        expect(replies).toEqual(fresh ? ['\x1b[1;2R'] : []);
        h.pty.ws.output(source.length, encode('\x1b[6n'));
        await h.settle();
        expect(replies.at(-1)).toBe('\x1b[1;2R');
    },
);

it.each([false, true])(
    'keeps the last view until the replacement epoch has a verified page (success=%s)',
    async (success) => {
        h = replayHarness(encode('NEW'));
        await new Promise((resolve) => h.term.write('CACHED', resolve));
        h.tab._termOpened = true;
        h.tab.queuedSeq = h.tab.drainedSeq = 6;
        let finish;
        h.fetcher.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        h.pty.ws.head({ epoch: 8, oldest: 0, head: 3 });
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(h.term.buffer.active.getLine(0).translateToString(true)).toBe(
            'CACHED',
        );
        finish(
            success
                ? recordingEnvelope(encode('NEW'), 0, 3, {
                      epoch: 8,
                      event_cursor: 'v1.8.3.0',
                      through_event_cursor: 'v1.8.3.0',
                  })
                : new Response('stale fence', { status: 409 }),
        );
        await h.settle();
        expect(h.term.buffer.active.getLine(0).translateToString(true)).toBe(
            success ? 'NEW' : 'CACHED',
        );
        expect(!!h.pty.ws.closed).toBe(!success);
    },
);

it('keeps a failed cold prefix silent but replies to later missing live queries', async () => {
    const old = encode('A\x1b[6n');
    const all = encode('A\x1b[6n\x1b[6nL');
    h = replayHarness(old);
    const replies = [];
    h.term.onData((data) => {
        if (!h.tab._historyParsing) replies.push(data);
    });
    h.fetcher.mockImplementation(async (url) => {
        const from = Number(
            new URL(url, 'http://localhost').searchParams.get('from'),
        );
        return from === 0
            ? recordingEnvelope(old.subarray(0, 1), 0, 1, {
                  through: old.length,
                  through_event_cursor: `v1.7.${old.length}.0`,
                  event_cursor: 'v1.7.1.0',
              })
            : new Response('retry attach', { status: 409 });
    });
    h.pty.ws.head({ epoch: 7, oldest: 0, head: old.length });
    await h.settle();
    expect(h.tab.drainedSeq).toBe(1);
    h.fetcher.mockClear();
    h.fetcher.mockImplementation(async (url) => {
        const q = new URL(url, 'http://localhost').searchParams;
        const from = Number(q.get('from')),
            through = Number(q.get('through'));
        return recordingEnvelope(all.subarray(from, through), from, through, {
            through,
            through_event_cursor: `v1.7.${through}.0`,
            event_cursor: `v1.7.${through}.0`,
        });
    });
    const next = h.socket();
    next.ws.head({ epoch: 7, oldest: 0, head: all.length });
    await h.settle();
    expect(
        h.fetcher.mock.calls.map(([url]) =>
            Number(
                new URL(url, 'http://localhost').searchParams.get('through'),
            ),
        ),
    ).toEqual([old.length, all.length]);
    expect(replies).toEqual(['\x1b[1;2R']);
    expect(h.tab.drainedSeq).toBe(all.length);
    expect(h.term.buffer.active.getLine(0).translateToString(true)).toBe('AL');
});

it('drains the final byte/event fence without resolving latest again', async () => {
    h = replayHarness(new Uint8Array());
    h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
    await h.settle();
    const queries = [];
    h.fetcher.mockImplementation(async (url) => {
        const q = new URL(url, 'http://localhost').searchParams;
        queries.push(q);
        const first = q.get('through') === 'latest';
        return recordingEnvelope(
            encode(first ? 'AB' : 'CD'),
            first ? 0 : 2,
            first ? 2 : 4,
            {
                event_cursor: `v1.7.${first ? 2 : 4}.1`,
                through: 4,
                through_event_cursor: 'v1.7.4.1',
                resizes: first ? [[2, 100, 12]] : [],
            },
        );
    });
    await h.manager._drainReplayTail(h.tab, h.pty);
    expect(queries.map((q) => q.get('through'))).toEqual(['latest', '4']);
    expect(queries[1].get('through_event_cursor')).toBe('v1.7.4.1');
    expect(queries[1].get('after_event_cursor')).toBe('v1.7.2.1');
    expect(h.tape.join('')).toBe('ABCD');
    expect(h.tab.drainedSeq).toBe(4);
    expect(h.tab._replayCursor).toBe('v1.7.4.1');
});

function geometry(seq, cols, ordinal) {
    const frame = TerminalServerFrame.encode(
        TerminalServerFrame.fromPartial({
            payload: {
                $case: 'geometry',
                value: {
                    atSeq: BigInt(seq),
                    cols,
                    rows: 12,
                    eventCursor: `v1.7.${seq}.${ordinal}`,
                },
            },
        }),
    ).finish();
    h.pty.ws.onmessage({ data: new Uint8Array(frame).buffer });
}

it('parses resize-only pages through the geometry fence at byte head zero', async () => {
    h = replayHarness(new Uint8Array());
    h.manager._fitVisibleTerminal = () => {};
    h.fetcher.mockImplementation(async (url) => {
        const q = new URL(url, 'http://localhost').searchParams;
        const first = q.get('after_event_cursor') === 'v1.7.0.0';
        return recordingEnvelope(new Uint8Array(), 0, 0, {
            event_cursor: first ? 'v1.7.0.256' : 'v1.7.0.300',
            resizes: Array.from({ length: first ? 256 : 44 }, (_, i) => [
                0,
                first ? 80 + i : 100 + i,
                12,
            ]),
        });
    });
    h.pty.ws.head({ epoch: 7, oldest: 0, head: 0, eventCursor: 'v1.7.0.300' });
    await h.settle();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.term.cols).toBe(143);
    expect(h.tab._replayCursor).toBe('v1.7.0.300');
    expect(h.pty.ws.closed).not.toBe(true);
});

it('retains the parsed geometry cursor across a same-epoch reconnect', async () => {
    h = replayHarness(new Uint8Array());
    h.manager._fitVisibleTerminal = () => {};
    h.tab._termOpened = true;
    h.tab._replayCursor = 'v1.7.0.256';
    h.fetcher.mockImplementation(async (url) => {
        expect(
            new URL(url, 'http://localhost').searchParams.get(
                'after_event_cursor',
            ),
        ).toBe('v1.7.0.256');
        return recordingEnvelope(new Uint8Array(), 0, 0, {
            event_cursor: 'v1.7.0.257',
            resizes: [[0, 100, 12]],
        });
    });
    h.pty.ws.head({ epoch: 7, oldest: 0, head: 0, eventCursor: 'v1.7.0.257' });
    await h.settle();
    expect(h.term.cols).toBe(100);
    expect(h.tab._replayCursor).toBe('v1.7.0.257');
});

it('does not admit queued messages after a held-stream overflow closes the socket', async () => {
    h = replayHarness(new Uint8Array());
    h.manager._fitVisibleTerminal = () => {};
    h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
    await h.settle();
    h.pty.hold();
    for (let i = 0; i < 257; i++) h.pty.ws.output(i, encode('X'));
    expect(h.pty.ws.closed).toBe(true);
    // Browsers may dispatch already-queued messages before onclose runs.
    h.pty.ws.output(0, encode('WRONG'));
    await h.settle();
    expect(h.tape.join('')).toBe('');
    expect(h.tab.drainedSeq).toBe(0);
});

it.each([false, true])(
    'retains the parsed byte/resize position when a page is interrupted (gap=%s)',
    async (gap) => {
        h = replayHarness(new Uint8Array());
        h.manager._fitVisibleTerminal = () => {};
        h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
        await h.settle();
        let current = true;
        const write = h.term.write.bind(h.term);
        h.term.write = (text, done) =>
            write(text, () => {
                current = false;
                done?.();
            });
        const applied = await h.manager._parseRecordingRange(
            h.tab,
            {
                start: 0,
                end: 2,
                bytes: encode('AB'),
                resizes: [[0, 100, 12]],
            },
            () => current,
            gap ? (bytes) => h.pty.applyGapPatch(bytes) : undefined,
            h.pty,
            false,
        );
        expect(applied).toBe(false);
        expect(h.tab.drainedSeq).toBe(2);
        expect(h.term.cols).toBe(100);
        // The next attach reconstructs its after cursor from this ordinal and
        // drainedSeq. Losing the ordinal produces a permanent server-side 400.
        expect(h.tab._replayCursor).toBe('v1.7.0.1');
    },
);

it.each(['live', 'replay', 'fit'])(
    'keeps the reading row across %s geometry',
    async (path) => {
        const source = encode(
            Array.from({ length: 200 }, (_, n) => `${n}\r\n`).join(''),
        );
        h = replayHarness(source);
        h.manager._terminalPanelVisible = () => true;
        h.pty.ws.head({ epoch: 7, oldest: 0, head: source.length });
        await h.settle();
        h.term.onScroll(() => h.manager._readerAnchorScroll(h.tab));
        h.term.scrollToLine(110);
        h.manager._captureReaderAnchor(h.tab);
        const reading = () =>
            h.term.buffer.active
                .getLine(h.term.buffer.active.viewportY)
                .translateToString(true);
        const before = reading();
        if (path === 'live')
            await h.manager._adoptLiveGeometry(h.tab, {
                at_seq: source.length,
                cols: 80,
                rows: 22,
                event_cursor: `v1.7.${source.length}.1`,
            });
        else if (path === 'replay')
            await h.manager._parseRecordingRange(
                h.tab,
                {
                    start: source.length,
                    end: source.length,
                    bytes: new Uint8Array(),
                    resizes: [[source.length, 80, 22]],
                },
                () => true,
            );
        else {
            h.tab.fitAddon = { fit: () => h.term.resize(80, 22) };
            h.manager._fitVisibleTerminal(h.tab);
        }
        expect(reading()).toBe(before);
    },
);

it('holds output and geometry together until each preceding write has parsed', async () => {
    h = replayHarness(new Uint8Array());
    h.manager._fitVisibleTerminal = () => {};
    h.pty.ws.head({
        epoch: 7,
        oldest: 0,
        head: 0,
        initialCols: 80,
        initialRows: 12,
    });
    await h.settle();
    const order = [];
    const write = h.term.write.bind(h.term);
    h.term.write = (text, done) => {
        order.push(`write:${h.term.cols}:${text}`);
        write(text, () => {
            order.push(`parsed:${text}`);
            done?.();
        });
    };
    const resize = h.term.resize.bind(h.term);
    h.term.resize = (cols, rows) => {
        order.push(`resize:${cols}`);
        resize(cols, rows);
    };
    h.pty.ws.output(0, encode('before'));
    geometry(6, 100, 1);
    h.pty.ws.output(6, encode('middle'));
    geometry(12, 120, 2);
    h.pty.ws.output(12, encode('after'));
    await h.settle();
    expect(order).toEqual([
        'write:80:before',
        'parsed:before',
        'resize:100',
        'write:100:middle',
        'parsed:middle',
        'resize:120',
        'write:120:after',
        'parsed:after',
    ]);
    expect(h.tab._replayCursor).toBe('v1.7.12.2');
    // Contiguous frames held behind geometry are not missing output.
    // Starting a gap replay here races the geometry's cursor update.
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.pty.ws.closed).not.toBe(true);
});
