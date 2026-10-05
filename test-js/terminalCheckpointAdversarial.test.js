// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import {
    Terminal,
    SerializeAddon,
    firstDifference,
    parse,
    terminalState,
} from './_terminalOracle.js';
import { TabManager } from '../web/terminal.js';
import { encode, replayHarness } from './_terminalReplayHarness.js';
setupDomHarness();

const SIZE = { cols: 12, rows: 6 };
const cases = [
    {
        name: 'plain output calibration',
        prefix: 'plain prefix ',
        future: 'future text',
    },
    {
        name: 'right-margin pending wrap before future output',
        prefix: 'A'.repeat(SIZE.cols),
        future: 'X',
    },
    {
        name: 'wide glyph pending wrap before future output',
        prefix: '界'.repeat(SIZE.cols / 2),
        future: 'X',
    },
    {
        name: 'future cells retain non-default underline style',
        prefix: '\x1b[4:3mPREFIX',
        future: 'FUTURE',
    },
    {
        name: 'future cells retain underline color',
        prefix: '\x1b[4;58:5:196mPREFIX',
        future: 'FUTURE',
    },
    {
        name: 'normal-buffer tab stops survive an active alternate screen',
        prefix: '\x1b[3g\x1b[1;4H\x1bH\x1b[?1049hALT',
        future: '\x1b[?1049l\x1b[1;1H\tX',
    },
    {
        name: 'normal-buffer scroll region survives an active alternate screen',
        prefix: '\x1b[2;5r\x1b[?6h\x1b[?1049hALT',
        future: '\x1b[?1049l\x1b[H\r\nFUTURE',
    },
];

describe('checkpoint continuation matches uninterrupted xterm', () => {
    it('raw recording fallback preserves continuation when no checkpoint exists', async () => {
        const source =
            '\x1b[4:3;58:5:196mPREFIX\x1b[0m' +
            '\x1b[1;1HRAW FALLBACK COMPLETE\x1b[K';
        const expected = new Terminal({
            cols: 240,
            rows: 12,
            scrollback: 10000,
            allowProposedApi: true,
        });
        const harness = replayHarness(encode(source));
        try {
            await parse(expected, source);
            harness.pty.ws.head({
                epoch: 7,
                oldest: 0,
                head: encode(source).length,
            });
            await harness.settle();
            const difference = firstDifference(
                terminalState(expected),
                terminalState(harness.term),
            );
            expect(difference).toBeNull();
            expect(harness.tab.drainedSeq).toBe(encode(source).length);
        } finally {
            expected.dispose();
            harness.dispose();
            vi.unstubAllGlobals();
        }
    });

    it.each(cases)('$name', async ({ prefix, future }) => {
        const options = { ...SIZE, scrollback: 100, allowProposedApi: true };
        const baseline = new Terminal(options);
        const restored = new Terminal(options);
        const addon = new SerializeAddon();
        baseline.loadAddon(addon);
        const fetcher = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetcher);

        try {
            await parse(baseline, prefix);
            Object.create(TabManager.prototype)._uploadCheckpoint({
                paneId: 'checkpoint-contract',
                paneEpoch: 7,
                drainedSeq: new TextEncoder().encode(prefix).length,
                ws: { mode: 'hot' },
                term: baseline,
                serializeAddon: addon,
            });

            const request = fetcher.mock.calls.find(([url]) =>
                String(url).endsWith('/checkpoint'),
            );
            // Checkpoint omission is safe when the caller replays the retained
            // raw prefix. If published, the actual production snapshot is used.
            expect(
                request,
                'the supported state case must exercise the production checkpoint',
            ).toBeDefined();
            const continuation = request
                ? JSON.parse(request[1].body).ansi
                : prefix;
            await parse(restored, continuation);

            await parse(baseline, future);
            await parse(restored, future);
            const difference = firstDifference(
                terminalState(baseline),
                terminalState(restored),
            );
            expect(
                difference,
                difference
                    ? `first terminal-state mismatch: ${JSON.stringify(difference)}`
                    : undefined,
            ).toBeNull();
        } finally {
            baseline.dispose();
            restored.dispose();
            vi.unstubAllGlobals();
        }
    });
});
