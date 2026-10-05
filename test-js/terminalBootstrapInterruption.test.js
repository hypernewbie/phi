// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { encode, replayHarness } from './_terminalReplayHarness.js';
setupDomHarness();
const RANGE = 2 * 1024 * 1024;
const paint = '\x1b[1;1HSTALE SCREEN\x1b[K';
const scenarios = [];
for (const ranges of [2, 3])
    for (const pauseBatch of [1, 3])
        for (const tail of ['', '\r\nLIVE AFTER RECONNECT'])
            scenarios.push({
                name: `${ranges} recording ranges; interrupt parser batch ${pauseBatch}; ${tail ? 'new live bytes' : 'no new bytes'}`,
                ranges,
                pauseBatch,
                tail,
            });

it.each(scenarios)(
    '$name: reconnect must not trust an advertised but unparsed head',
    async ({ ranges, pauseBatch, tail }) => {
        const prefix = paint
            .repeat(Math.ceil((RANGE * (ranges - 1)) / paint.length))
            .slice(0, RANGE * (ranges - 1));
        const before = encode(`${prefix}\x1b[1;1HNEWEST RETAINED SCREEN\x1b[K`);
        const source = encode(`${new TextDecoder().decode(before)}${tail}`);
        const h = replayHarness(source);
        let releaseParser;
        let notifyPaused;
        const paused = new Promise((resolve) => {
            notifyPaused = resolve;
        });
        const write = h.term.write.bind(h.term);
        let batches = 0;
        h.term.write = (text, callback) =>
            write(text, () => {
                batches++;
                if (batches === pauseBatch) {
                    releaseParser = callback;
                    notifyPaused();
                } else callback?.();
            });
        try {
            h.pty.ws.head({ epoch: 7, oldest: 0, head: before.length });
            await paused;
            expect(h.tab.writePending).toBe(true);
            expect(h.tab.drainedSeq).toBeLessThan(before.length);
            const next = h.socket();
            next.ws.head({ epoch: 7, oldest: 0, head: source.length });
            releaseParser();
            await h.settle();
            // Parser callback ownership, recording requests, and actual bytes
            // must agree. "head" in ATTACH_HEAD is not a parse completion.
            const rendered = encode(h.tape.join(''));
            const digest = (bytes) =>
                createHash('sha256').update(bytes).digest('hex');
            const visible = Array.from({ length: h.term.rows }, (_, i) =>
                h.term.buffer.active
                    .getLine(h.term.buffer.active.baseY + i)
                    ?.translateToString(true),
            ).join('\n');
            const violations = [];
            if (rendered.length !== source.length)
                violations.push(
                    `parser received ${rendered.length} bytes; expected ${source.length}`,
                );
            if (digest(rendered) !== digest(source))
                violations.push(
                    'parser input digest differs from retained recording',
                );
            if (!visible.includes('NEWEST RETAINED SCREEN'))
                violations.push('newest retained screen is not visible');
            if (h.tab.drainedSeq !== rendered.length)
                violations.push(
                    `drained frontier is ${h.tab.drainedSeq}; parser received ${rendered.length} bytes`,
                );
            expect(violations).toEqual([]);
        } finally {
            releaseParser?.();
            h.dispose();
        }
    },
    15000,
);
