// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Updated for TERMPERF (temp/TERMPERF.md §4): the live xterm no longer
// needs to hold the server's whole replay ring — the hot-v1 attach
// restores the screen from a bounded checkpoint + <=64KiB delta, and the
// recording archive owns deep history. The original regression this file
// guarded (replay truncation at xterm's 1000-line default) is now covered
// structurally: 512 rows is explicitly configured, and the bootstrap
// path that makes a small live buffer safe is present in source.

const terminalJsPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'web',
    'terminal.js',
);

describe('xterm scrollback configuration', () => {
    it('sets an explicit bounded scrollback of 512 lines on the Terminal constructor', () => {
        const src = readFileSync(terminalJsPath, 'utf8');
        const ctorStart = src.indexOf('new window.Terminal({');
        expect(ctorStart).toBeGreaterThan(-1);
        const ctorEnd = src.indexOf('});', ctorStart);
        const ctorBody = src.slice(ctorStart, ctorEnd);

        const match = ctorBody.match(/scrollback:\s*(\d+)/);
        expect(match).not.toBeNull();
        expect(Number(match[1])).toBe(512);
    });

    it('the bounded live buffer is safe: the checkpoint bootstrap exists', () => {
        const src = readFileSync(terminalJsPath, 'utf8');
        // Screen restore on attach (pre-open write) and quiet-tab uploads
        // are what keep a 512-row live terminal complete.
        expect(src).toContain('_onAttachHead');
        expect(src).toContain('serialize({ scrollback: 0 })');
        expect(src).toContain('/checkpoint');
    });
});
