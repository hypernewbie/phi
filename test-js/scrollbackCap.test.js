// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// UX law (2026-09-13 regression): the live terminal keeps the full
// scrollback. The 512-row cap hid history behind an archive button and
// broke normal scroll-up — lag on a genuine resize is accepted cost,
// missing history is not. Open-path speed comes from the hot-v1
// live-only attach + checkpoint bootstrap, never from truncation.
// These tests pin the restored constant and the still-live hot path.
describe('live scrollback restored', () => {
    const src = readFileSync(join(process.cwd(), 'web', 'terminal.js'), 'utf8');

    it('live terminals are created with scrollback 10000', () => {
        const all = [...src.matchAll(/scrollback:\s*(\d+)/g)].map((m) =>
            Number(m[1]),
        );
        expect(all).toContain(10000);
    });

    it('the 512-row cap value is gone from the live constructor', () => {
        const ctorStart = src.indexOf('new window.Terminal({');
        expect(ctorStart).toBeGreaterThan(-1);
        const ctorEnd = src.indexOf('});', ctorStart);
        const ctorBody = src.slice(ctorStart, ctorEnd);
        expect(ctorBody).not.toMatch(/scrollback:\s*512\b/);
    });

    it('the archive button gates on recording presence, not a 512-row tail', () => {
        // head - oldest > 512 mixed byte seqs with row counts; any
        // recording now qualifies since scroll-up covers recent history.
        expect(src).not.toContain('head - oldest > 512');
        expect(src).toContain('head > oldest');
    });

    it('the archive loads from the oldest retained byte, not a 64 KiB tail', () => {
        // A 64 KiB window would duplicate what's already visible via
        // scroll-up; the archive is strictly beyond-scrollback history.
        expect(src).not.toContain('head - 65536');
        expect(src).toContain('const from = tabInfo.paneOldest;');
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
