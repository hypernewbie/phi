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
        for (const route of ['attach', 'reconnect', 'live-gap'])
            for (const chunked of [false, true]) {
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
            const h = replayHarness(
                source,
                ({ from, to, throughCursor, afterCursor }) => {
                    const end = chunked
                        ? Math.min(
                              to,
                              from + Math.max(1, Math.floor((to - from) / 2)),
                          )
                        : to;
                    const allowed =
                        !throughCursor || throughCursor.endsWith('.1');
                    const consumed = afterCursor?.endsWith('.1');
                    const ordinal = consumed || (allowed && cut <= end) ? 1 : 0;
                    return recordingEnvelope(
                        source.slice(from, end),
                        from,
                        end,
                        {
                            initial_cols: before[0],
                            initial_rows: before[1],
                            event_cursor: `v1.7.${end}.${ordinal}`,
                            through: to,
                            through_event_cursor: `v1.7.${to}.${allowed ? 1 : 0}`,
                            resizes:
                                allowed &&
                                !consumed &&
                                cut >= from &&
                                cut <= end
                                    ? [[cut, after[0], after[1]]]
                                    : [],
                        },
                    );
                },
            );
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
                    h.tab._replayCursor = `v1.7.${cut}.0`;
                    h.tab._termOpened = true;
                    h.tab.drainedSeq = cut;
                    h.tab.queuedSeq = cut;
                }
                h.pty.ws.head({
                    epoch: 7,
                    oldest: 0,
                    head: route === 'live-gap' ? cut : source.length,
                    initialCols: before[0],
                    initialRows: before[1],
                    eventCursor: `v1.7.${route === 'live-gap' ? cut : source.length}.${route === 'live-gap' ? 0 : 1}`,
                });
                await h.settle();
                if (route === 'live-gap') {
                    h.pty.ws.output(source.length, encode(''));
                    await h.manager._onLiveGap(h.tab, cut, source.length);
                    await h.settle();
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
