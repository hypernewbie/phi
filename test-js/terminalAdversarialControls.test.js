// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { Terminal, parse, terminalState } from './_terminalOracle.js';
import { encode, replayHarness } from './_terminalReplayHarness.js';
setupDomHarness();

it.each([12, 13, 40, 80])(
    'raw parser calibration at %i columns survives the same resize cycle',
    async (cols) => {
        const a = new Terminal({ cols, rows: 12, allowProposedApi: true });
        const b = new Terminal({ cols, rows: 12, allowProposedApi: true });
        try {
            const source =
                '\x1b[4:3;58:5:196m' +
                'A'.repeat(cols) +
                '\x1b7\x1b[?1049hALT\x1b[?1049l\x1b8';
            await parse(a, source);
            await parse(b, source);
            for (const [width, height] of [
                [cols - 3, 14],
                [cols + 3, 12],
                [cols, 12],
            ]) {
                a.resize(width, height);
                b.resize(width, height);
            }
            await parse(a, 'FUTURE');
            await parse(b, 'FUTURE');
            expect(terminalState(a)).toEqual(terminalState(b));
        } finally {
            a.dispose();
            b.dispose();
        }
    },
);

it.each([2, 3])(
    'uninterrupted %i-range bootstrap preserves every byte and latest screen',
    async (ranges) => {
        const size = 2 * 1024 * 1024 * (ranges - 1);
        const paint = '\x1b[1;1HSTALE SCREEN\x1b[K';
        const source = encode(
            paint.repeat(Math.ceil(size / paint.length)).slice(0, size) +
                '\x1b[1;1HNEWEST RETAINED SCREEN\x1b[K',
        );
        const h = replayHarness(source);
        try {
            h.pty.ws.head({ epoch: 7, oldest: 0, head: source.length });
            await h.settle();
            const actual = encode(h.tape.join(''));
            const digest = (bytes) =>
                createHash('sha256').update(bytes).digest('hex');
            expect(digest(actual)).toBe(digest(source));
            expect(
                h.term.buffer.active
                    .getLine(h.term.buffer.active.baseY)
                    ?.translateToString(true),
            ).toBe('NEWEST RETAINED SCREEN');
            expect(h.tab.drainedSeq).toBe(source.length);
        } finally {
            h.dispose();
        }
    },
    15000,
);
