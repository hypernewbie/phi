// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The structural fix for the resize-stall: every live fit/reflow is
// bounded by the live scrollback cap. Tests pin the constant in source
// and that hot-v1 still routes recording fetches instead of replay.
describe('live scrollback cap', () => {
    const src = readFileSync(join(process.cwd(), 'web', 'terminal.js'), 'utf8');

    it('live terminals are created with scrollback 512', () => {
        const all = [...src.matchAll(/scrollback:\s*(\d+)/g)].map((m) =>
            Number(m[1]),
        );
        expect(all).toContain(512);
    });

    it('the unbounded 10000-row value is gone', () => {
        expect(src).not.toContain('scrollback: 10000');
    });

    it('hot clients never receive the legacy replay path in PTYWebSocket', () => {
        const ws = readFileSync(join(process.cwd(), 'web', 'ws.js'), 'utf8');
        // The URL negotiates hot-v1 explicitly.
        expect(ws).toContain('term_proto=hot-v1');
    });

    it('legacy replay behavior (reset-on-first-byte) is still present for old servers', () => {
        // _paneData's legacy branch keeps the awaitingReplay reset so a
        // legacy server reconnect cannot double the scrollback.
        expect(src).toContain("pty.mode === 'legacy'");
        expect(src).toMatch(/awaitingReplay = false/);
    });
});
