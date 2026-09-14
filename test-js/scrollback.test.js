// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// UX law: the live xterm keeps the full scrollback — normal scroll-up
// must show history with no button hunt and no mode switch. Open-path
// speed comes from the hot-v1 live-only attach (no 1 MiB replay) +
// checkpoint bootstrap, never from truncating the visible buffer.
// The earlier "replay truncation at xterm's 1000-line default" regression
// is now covered structurally here.
const terminalJsPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'web',
    'terminal.js',
);

describe('xterm scrollback configuration', () => {
    it('defines one LIVE_SCROLLBACK_ROWS constant at 10000', () => {
        const src = readFileSync(terminalJsPath, 'utf8');
        const match = src.match(/const LIVE_SCROLLBACK_ROWS = (\d+);/);
        expect(match).not.toBeNull();
        expect(Number(match[1])).toBe(10000);
    });

    it('creates live terminals from _liveScrollbackRows (mobile gate), not a literal', () => {
        const src = readFileSync(terminalJsPath, 'utf8');
        const ctorStart = src.indexOf('new window.Terminal({');
        expect(ctorStart).toBeGreaterThan(-1);
        const ctorEnd = src.indexOf('});', ctorStart);
        const ctorBody = src.slice(ctorStart, ctorEnd);
        expect(ctorBody).toContain('scrollback: this._liveScrollbackRows()');
        expect(ctorBody).not.toMatch(/scrollback:\s*\d/);
    });

    it('does not cap the live buffer at the 512-row experiment value', () => {
        const src = readFileSync(terminalJsPath, 'utf8');
        const ctorStart = src.indexOf('new window.Terminal({');
        const ctorEnd = src.indexOf('});', ctorStart);
        const ctorBody = src.slice(ctorStart, ctorEnd);
        expect(ctorBody).not.toMatch(/scrollback:\s*512\b/);
    });

    it('fast open does not depend on truncating scrollback: the checkpoint bootstrap exists', () => {
        const src = readFileSync(terminalJsPath, 'utf8');
        // Screen restore on attach (pre-open write) and quiet-tab uploads
        // are what keep attach fast without a 1 MiB replay.
        expect(src).toContain('_onAttachHead');
        expect(src).toContain('serialize({ scrollback: 0 })');
        expect(src).toContain('/checkpoint');
    });
});
