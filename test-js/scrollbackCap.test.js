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

    it('no archive sidecar remains in the live terminal', () => {
        // The overlay era is over: history lives in the live 10000-row
        // scrollback via normal scroll-up. No button, no overlay, no
        // worker/IndexedDB pipeline behind the terminal.
        for (const token of [
            '_toggleArchive',
            '_closeArchive',
            '_loadArchiveRows',
            'archiveBtn',
            'archiveOverlay',
            'startArchiveWorker',
            'HistoryStore',
        ]) {
            expect(src).not.toContain(token);
        }
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
