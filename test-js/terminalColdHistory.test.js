// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    encode,
    recordingEnvelope,
    replayHarness,
} from './_terminalReplayHarness.js';

setupDomHarness();

it('cold history holds simultaneous live output and releases it exactly once after replay', async () => {
    const before = Array.from({ length: 30 }, (_, i) => `ROW ${i}\r\n`).join(
        '',
    );
    const source = encode(before + 'LIVE TAIL\r\n');
    const head = encode(before).length;
    const h = replayHarness(source);
    try {
        h.pty.ws.head({
            epoch: 7,
            oldest: 0,
            head,
            ckpt: { through: head, cols: 240, rows: 12, ansi: 'ROW 29\r\n' },
        });
        await h.settle();
        expect(h.requests).toHaveLength(0);
        let complete;
        const gate = new Promise((resolve) => {
            complete = resolve;
        });
        const fetcher = vi.fn(async () => {
            await gate;
            return recordingEnvelope(source.slice(0, head), 0, head);
        });
        vi.stubGlobal('fetch', fetcher);
        const loading = h.manager._loadColdHistory(h.tab);
        await new Promise((resolve) => setTimeout(resolve, 0));
        h.pty.ws.output(head, source.slice(head));
        expect(h.pty.liveSeq).toBe(head);
        complete();
        await loading;
        await h.settle();
        const rows = Array.from(
            { length: h.term.buffer.active.length },
            (_, i) => h.term.buffer.active.getLine(i).translateToString(true),
        );
        expect(rows[0]).toBe('ROW 0');
        expect(rows.filter((row) => row === 'ROW 29')).toHaveLength(1);
        expect(rows.filter((row) => row === 'LIVE TAIL')).toHaveLength(1);
        expect(h.tab.drainedSeq).toBe(source.length);
        expect(h.tab._historyOmitted).toBe(false);
        expect(h.tab._bootstrapGate).toBe(null);
    } finally {
        h.dispose();
    }
});
