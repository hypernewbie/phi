// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();
const vm = createHeadlessSandbox();
vm.ctx.module = { exports: {} };
vm.runSource(
    readFileSync(
        join(
            process.cwd(),
            'node_modules/@xterm/addon-serialize/lib/addon-serialize.js',
        ),
        'utf8',
    ),
    'serialize-addon.js',
);
const { SerializeAddon } = vm.ctx.module.exports;
const { Terminal } = vm;
const write = (term, data) =>
    new Promise((resolve) => term.write(data, resolve));

function state(term) {
    const b = term.buffer.active;
    return {
        type: b.type,
        cursorX: b.cursorX,
        cursorY: b.cursorY,
        baseY: b.baseY,
        lines: Array.from({ length: b.length }, (_, row) => {
            const line = b.getLine(row);
            return Array.from({ length: term.cols }, (_, col) => {
                const c = line.getCell(col);
                return [
                    c.getChars(),
                    c.getWidth(),
                    c.getFgColorMode(),
                    c.getFgColor(),
                    c.getBgColorMode(),
                    c.getBgColor(),
                    c.isBold(),
                    c.isItalic(),
                    c.isUnderline(),
                ];
            });
        }),
    };
}

const cases = [
    ['plain text calibration', 'prefix ', 'SUFFIX'],
    ['partial CSI introducer', 'prefix \x1b[', '31mRED\x1b[0m'],
    ['partial CSI parameters', 'prefix \x1b[38;2;255;0;', '0mRED\x1b[0m'],
    ['partial OSC title', 'prefix \x1b]0;par', 'tial\x07visible'],
    [
        'partial OSC hyperlink',
        'prefix \x1b]8;;https://example.',
        'com\x1b\\LINK\x1b]8;;\x1b\\',
    ],
    ['partial DCS string', 'prefix \x1bP$q', 'm\x1b\\visible'],
    ['saved cursor position', '\x1b[4;12H\x1b7\x1b[8;1Hprefix', '\x1b8SUFFIX'],
    [
        'saved cursor attributes',
        '\x1b[31m\x1b7\x1b[0m\x1b[8;1Hprefix',
        '\x1b8SUFFIX',
    ],
    ['active DEC G0 character set', 'prefix \x1b(0', 'lqqk'],
    ['active DEC G1 character set', 'prefix \x1b)0\x0e', 'lqqk'],
    ['custom tab stops', '\x1b[3g\x1b[1;4H\x1bH\x1b[1;1H', '\tX'],
    ['origin mode cursor', '\x1b[3;10r\x1b[?6h\x1b[4;10HPREFIX', 'SUFFIX'],
    ['scroll region cursor', '\x1b[3;10r\x1b[6;10HPREFIX', 'SUFFIX'],
];

// Same real parser and same future bytes, with and without the optimization.
// A checkpoint must preserve machine state, not just an attractive screenshot.
describe('checkpoint continuation is equivalent to uninterrupted xterm', () => {
    it('alternate snapshot scans history once and preserves both buffers', async () => {
        const baseline = new Terminal({
            cols: 40,
            rows: 12,
            scrollback: 10000,
            allowProposedApi: true,
        });
        const restored = new Terminal({
            cols: 40,
            rows: 12,
            scrollback: 10000,
            allowProposedApi: true,
        });
        const addon = new SerializeAddon();
        baseline.loadAddon(addon);
        const serialize = vi.spyOn(addon, 'serialize');
        const fetcher = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetcher);
        try {
            await write(
                baseline,
                'NORMAL HISTORY\r\n'.repeat(1000) +
                    '\x1b[?1049hALT SCREEN\x1b[3;5H\x1b[4:3;58:2::10:20:30m',
            );
            Object.create(TabManager.prototype)._uploadCheckpoint({
                paneId: 'p',
                paneEpoch: 7,
                drainedSeq: 100,
                ws: { mode: 'hot' },
                term: baseline,
                serializeAddon: addon,
            });
            expect(serialize).toHaveBeenCalledTimes(1);
            const checkpoint = JSON.parse(fetcher.mock.calls[0][1].body);
            await write(restored, checkpoint.ansi);
            expect(state(restored)).toEqual(state(baseline));
            for (const future of ['FUTURE ALT', '\x1b[?1049lFUTURE NORMAL']) {
                await write(baseline, future);
                await write(restored, future);
                expect(state(restored)).toEqual(state(baseline));
            }
        } finally {
            baseline.dispose();
            restored.dispose();
        }
    });

    it.each(cases)('%s', async (_name, prefix, suffix) => {
        const baseline = new Terminal({
            cols: 40,
            rows: 12,
            allowProposedApi: true,
        });
        const restored = new Terminal({
            cols: 40,
            rows: 12,
            allowProposedApi: true,
        });
        const addon = new SerializeAddon();
        baseline.loadAddon(addon);
        const fetcher = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetcher);
        try {
            await write(baseline, prefix);
            Object.create(TabManager.prototype)._uploadCheckpoint({
                paneId: 'p',
                paneEpoch: 7,
                drainedSeq: new TextEncoder().encode(prefix).length,
                ws: { mode: 'hot' },
                term: baseline,
                serializeAddon: addon,
            });
            expect(fetcher).toHaveBeenCalledOnce();
            const checkpoint = JSON.parse(fetcher.mock.calls[0][1].body);
            await write(restored, checkpoint.ansi);
            await write(baseline, suffix);
            await write(restored, suffix);
            expect(state(restored)).toEqual(state(baseline));
        } finally {
            baseline.dispose();
            restored.dispose();
        }
    });
});
