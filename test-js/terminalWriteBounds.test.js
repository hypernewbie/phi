// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { encode, replayHarness } from './_terminalReplayHarness.js';

setupDomHarness();

it('bounds each parser batch without dropping or splitting a surrogate pair', async () => {
    const text =
        'x'.repeat(65535) + '🙂你好\r\n' + 'remaining output\r\n'.repeat(8000);
    const source = encode(text);
    const h = replayHarness(source);
    try {
        h.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
        h.pty.ws.output(0, source);
        await h.settle();
        expect(h.tape.join('')).toBe(text);
        expect(h.tape.every((batch) => batch.length <= 65536)).toBe(true);
        expect(
            h.tape
                .slice(0, -1)
                .every((batch) => !/[\ud800-\udbff]$/.test(batch)),
        ).toBe(true);
        expect(h.requests).toHaveLength(0);
        expect(h.tab.drainedSeq).toBe(source.length);
    } finally {
        h.dispose();
    }
});
