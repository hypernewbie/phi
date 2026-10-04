// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import {
    encode,
    recordingEnvelope,
    replayHarness,
} from './_terminalReplayHarness.js';

setupDomHarness();
const { Terminal } = createHeadlessSandbox();
const write = (term, text) =>
    new Promise((resolve) => term.write(text, resolve));
function screen(term) {
    const b = term.buffer.active;
    return {
        cols: term.cols,
        rows: term.rows,
        type: b.type,
        cursor: [b.cursorX, b.cursorY],
        lines: Array.from({ length: b.length }, (_, i) =>
            b.getLine(i).translateToString(true),
        ),
    };
}
const sizes = [
    [
        [80, 24],
        [120, 40],
    ],
    [
        [120, 40],
        [80, 24],
    ],
    [
        [80, 24],
        [80, 36],
    ],
    [
        [80, 36],
        [80, 24],
    ],
];
const programs = {
    'cursor-addressed redraw': (rows, tag) =>
        '\x1b[2J' +
        Array.from(
            { length: rows },
            (_, i) => `\x1b[${i + 1};1H${tag} ROW ${i}`,
        ).join(''),
    'alternate redraw': (rows, tag) =>
        '\x1b[?1049h\x1b[2J' +
        Array.from(
            { length: rows },
            (_, i) => `\x1b[${i + 1};1H${tag} ROW ${i}`,
        ).join(''),
    'wrapped transcript': (rows, tag) =>
        Array.from(
            { length: rows },
            (_, i) => `${tag} ROW ${i} ${'wide text '.repeat(14)}\r\n`,
        ).join(''),
    'scroll-region redraw': (rows, tag) =>
        `\x1b[2;${rows - 1}r\x1b[?6h\x1b[H${tag} REGION\r\n` +
        `${tag} CONTENT\r\n`.repeat(rows),
};
const cases = [];
for (const [name, program] of Object.entries(programs))
    for (const [before, after] of sizes)
        for (const route of ['attach', 'reconnect', 'cold-scroll', 'live-gap'])
            for (const chunked of [false, true]) {
                if (route === 'cold-scroll' && name === 'alternate redraw')
                    continue;
                cases.push({
                    name: `${name}; ${before}->${after}; ${route}; ${chunked ? 'split' : 'whole'}`,
                    program,
                    before,
                    after,
                    route,
                    chunked,
                });
            }

describe('retained terminal lifecycle preserves the geometry that produced each byte', () => {
    it.each(cases)(
        '$name',
        async ({ program, before, after, route, chunked }) => {
            const prefix = program(before[1], 'OLD');
            const suffix = program(after[1], 'LATEST');
            const source = encode(prefix + suffix);
            const cut = encode(prefix).length;
            const markers = [
                [0, before[0], before[1]],
                [cut, after[0], after[1]],
            ];
            const h = replayHarness(source, ({ from, to }) => {
                const end = chunked
                    ? Math.min(
                          to,
                          from + Math.max(1, Math.floor((to - from) / 2)),
                      )
                    : to;
                return recordingEnvelope(source.slice(from, end), from, end, {
                    resizes: markers.filter((m) => m[0] <= end),
                });
            });
            const reference = new Terminal({
                cols: before[0],
                rows: before[1],
                scrollback: 100000,
            });
            try {
                await write(reference, prefix);
                reference.resize(...after);
                await write(reference, suffix);
                h.term.resize(...after);
                if (route === 'reconnect' || route === 'live-gap') {
                    h.term.resize(...before);
                    await write(h.term, prefix);
                    if (route === 'reconnect') h.term.resize(...after);
                    h.tab._termOpened = true;
                    h.tab.drainedSeq = cut;
                    h.tab.queuedSeq = cut;
                }
                h.pty.ws.head({
                    epoch: 7,
                    oldest: 0,
                    head: route === 'live-gap' ? cut : source.length,
                });
                await h.settle();
                if (route === 'live-gap') {
                    h.pty.ws.output(source.length, encode(''));
                    await h.manager._onLiveGap(h.tab, cut, source.length);
                    await h.settle();
                }
                if (route === 'cold-scroll') {
                    h.tab._historyOmitted = true;
                    await h.manager._loadColdHistory(h.tab);
                }
                expect(screen(h.term)).toEqual(screen(reference));
                expect(h.tab.drainedSeq).toBe(source.length);
            } finally {
                reference.dispose();
                h.dispose();
            }
        },
    );
});

it('a fullscreen TUI wheel never resets its live screen to replay historical redraws', async () => {
    const source = encode('\x1b[?1049h\x1b[?1000h\x1b[?1006hLATEST FULLSCREEN');
    const h = replayHarness(source);
    try {
        h.pty.ws.head({ epoch: 7, oldest: 0, head: source.length });
        await h.settle();
        const before = screen(h.term);
        const requests = h.requests.length;
        h.tab._historyOmitted = true;
        await h.manager._loadColdHistory(h.tab);
        expect(h.requests.length).toBe(requests);
        expect(screen(h.term)).toEqual(before);
    } finally {
        h.dispose();
    }
});
