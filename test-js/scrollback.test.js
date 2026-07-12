// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Regression guard for the "scrollback truncates replay" hardening finding:
// the server can replay up to `terminal.replayBufferBytes` (default 1MiB) of
// output on reconnect, but xterm.js defaults to a 1000-line client-side
// scrollback buffer, silently discarding everything above that on the very
// terminal that's supposed to show it. There's no practical way to exercise
// the real `new window.Terminal(...)` construction path in jsdom (it needs a
// canvas/WebGL-capable Terminal + FitAddon + SearchAddon), so — matching the
// existing source-assertion pattern used for the initGlobalShortcuts wiring
// regression guard — this asserts the option is present in source directly.

const terminalJsPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'web', 'terminal.js'
);

describe('xterm scrollback configuration', () => {
    it('sets an explicit scrollback of at least 10000 lines on the Terminal constructor', () => {
        const src = readFileSync(terminalJsPath, 'utf8');
        const ctorStart = src.indexOf('new window.Terminal({');
        expect(ctorStart).toBeGreaterThan(-1);
        const ctorEnd = src.indexOf('});', ctorStart);
        const ctorBody = src.slice(ctorStart, ctorEnd);

        const match = ctorBody.match(/scrollback:\s*(\d+)/);
        expect(match).not.toBeNull();
        expect(Number(match[1])).toBeGreaterThanOrEqual(10000);
    });
});
