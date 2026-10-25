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

    it('live terminals resolve scrollback through the mobile gate', () => {
        const all = [...src.matchAll(/scrollback:\s*([^,\n]+)/g)].map((m) =>
            m[1].trim(),
        );
        expect(all).toContain('this._liveScrollbackRows()');
        expect(all.some((v) => /^\d+$/.test(v) && Number(v) < 10000)).toBe(
            false,
        );
    });

    it('no sub-10000 scrollback literal remains anywhere in the live path', () => {
        const ctorStart = src.indexOf('new window.Terminal({');
        expect(ctorStart).toBeGreaterThan(-1);
        const ctorEnd = src.indexOf('});', ctorStart);
        const ctorBody = src.slice(ctorStart, ctorEnd);
        expect(ctorBody).not.toMatch(/scrollback:\s*512\b/);
        expect(ctorBody).not.toMatch(/scrollback:\s*\d/);
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

    it('pane sockets negotiate the protobuf subprotocol in PTYWebSocket', () => {
        const protocols = readFileSync(
            join(process.cwd(), 'web', 'ws-protocols.js'),
            'utf8',
        );
        const ws = readFileSync(join(process.cwd(), 'web', 'ws.js'), 'utf8');
        // The shared tokens module carries the versioned subprotocol
        // and the pane socket imports it; the query string no longer
        // carries protocol selection.
        expect(protocols).toContain('phi.terminal.protobuf.v1');
        expect(ws).toContain('ws-protocols.js');
        expect(ws).not.toContain('term_proto');
    });

    it('no legacy wire-mode branch remains in the pane data path', () => {
        // Old servers fail the subprotocol check instead of delivering
        // legacy frames, so the legacy mode branch is gone.
        expect(src).not.toContain("pty.mode === 'legacy'");
    });
});
