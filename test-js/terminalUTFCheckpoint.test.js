// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { encode, replayHarness } from './_terminalReplayHarness.js';

setupDomHarness();

it.each([
    ['你好', 1],
    ['你好', 2],
    ['🙂', 1],
    ['🙂', 2],
    ['🙂', 3],
])(
    'checkpoint rewind preserves an incomplete %s glyph after %i bytes',
    async (glyph, split) => {
        const prefix = 'prefix ';
        const source = encode(prefix + glyph + ' ready\r\n');
        const cut = encode(prefix).length + split;
        const original = replayHarness(source);
        let restored;
        try {
            original.pty.ws.head({ epoch: 7, oldest: 0, head: 0 });
            original.pty.ws.output(0, source.slice(0, cut));
            await original.settle();
            original.tab.serializeAddon = { serialize: () => prefix };
            const upload = vi.fn(async () => ({ ok: true }));
            vi.stubGlobal('fetch', upload);
            original.manager._uploadCheckpoint(original.tab);
            expect(upload).toHaveBeenCalledOnce();
            const checkpoint = JSON.parse(upload.mock.calls[0][1].body);
            expect(checkpoint.through).toBe(encode(prefix).length);
            restored = replayHarness(source);
            restored.pty.ws.head({
                epoch: 7,
                oldest: 0,
                head: cut,
                ckpt: checkpoint,
            });
            restored.pty.ws.output(cut, source.slice(cut));
            await restored.settle();
            expect(
                restored.term.buffer.active.getLine(0).translateToString(true),
            ).toBe(prefix + glyph + ' ready');
            expect(restored.tab.drainedSeq).toBe(source.length);
        } finally {
            original.dispose();
            restored?.dispose();
        }
    },
);
