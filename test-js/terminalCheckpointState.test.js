// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

it('phone checkpoints bound copied history without reducing the live buffer or byte frontier', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const serialize = vi.fn(() => 'SCREEN');
    const fetcher = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const term = { cols: 80, rows: 24, options: { scrollback: 10000 } };
    Object.create(TabManager.prototype)._uploadCheckpoint({
        paneId: 'p',
        paneEpoch: 7,
        drainedSeq: 10000000,
        ws: { mode: 'hot' },
        term,
        serializeAddon: { serialize },
    });
    expect(serialize).toHaveBeenCalledWith({ scrollback: 256 });
    expect(term.options.scrollback).toBe(10000);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).through).toBe(10000000);
    vi.unstubAllGlobals();
});

it.each([
    ['multibyte text', '你'.repeat(800000)],
    ['mouse mode at the size boundary', 'x'.repeat(2 * 1024 * 1024)],
])('checkpoint budget counts transmitted bytes: %s', (_name, large) => {
    const manager = Object.create(TabManager.prototype);
    const fetcher = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    manager._uploadCheckpoint({
        paneId: 'p',
        paneEpoch: 7,
        drainedSeq: 100,
        serializeAddon: {
            serialize: ({ scrollback }) =>
                scrollback === 10000 ? large : 'SMALL',
        },
        ws: { mode: 'hot' },
        term: {
            cols: 80,
            rows: 24,
            buffer: { active: { baseY: 10000 } },
            _core: { mouseStateService: { activeEncoding: 'SGR' } },
        },
    });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(new TextEncoder().encode(body.ansi).length).toBeLessThanOrEqual(
        2 * 1024 * 1024,
    );
    expect(body.ansi).toContain('\x1b[?1006h');
});

it.each([
    ['SGR', '\x1b[?1006h'],
    ['SGR_PIXELS', '\x1b[?1016h'],
])(
    'checkpoint preserves %s mouse encoding, not only visible cells and tracking mode',
    (encoding, sequence) => {
        const manager = Object.create(TabManager.prototype);
        const fetcher = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetcher);
        const tab = {
            paneId: 'p',
            paneEpoch: 7,
            drainedSeq: 100,
            serializeAddon: { serialize: () => 'VISIBLE CELLS\x1b[?1002h' },
            ws: { mode: 'hot' },
            term: {
                cols: 80,
                rows: 24,
                _core: { mouseStateService: { activeEncoding: encoding } },
            },
        };
        manager._uploadCheckpoint(tab);
        const body = JSON.parse(fetcher.mock.calls[0][1].body);
        expect(body.ansi).toContain(sequence);
        expect(body.through).toBe(100);
    },
);
