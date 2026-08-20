import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const terminalJsSrc = readFileSync(
    path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'web',
        'terminal.js',
    ),
    'utf8',
);

// Non-direct mode: clicking the terminal focuses xterm's hidden helper
// textarea; the custom key event handler then redirects printable keydowns
// into the staged input textarea (append + focus + caret-to-end).
//
// Double-character regression: the handler moves focus to the input textarea
// MID-keydown, so the browser's default text insertion — which follows the
// currently focused element, not the keydown target — lands in the input
// textarea too. Without e.preventDefault() every redirected letter appears
// twice ("a" → "aa"). jsdom performs no default text insertion on keydown,
// so the doubling can't be reproduced behaviorally here; like the Ctrl+T
// check in f7InputBypass.test.js we assert on the handler's source instead.

function redirectBranch() {
    const start = terminalJsSrc.indexOf(
        '// In non-direct mode: redirect printable keystrokes',
    );
    expect(start, 'redirect branch marker comment not found').toBeGreaterThan(
        -1,
    );
    const end = terminalJsSrc.indexOf('return false;', start);
    expect(end, 'redirect branch has no return false').toBeGreaterThan(start);
    return terminalJsSrc.slice(start, end);
}

describe('non-direct-mode printable key redirect (terminal → input textarea)', () => {
    it('prevents the default insertion so the character is not doubled', () => {
        expect(redirectBranch()).toContain('e.preventDefault()');
    });

    it("dispatches a synthetic 'input' event so the textarea's input listeners still run", () => {
        // preventDefault also suppresses the native 'input' event; the staged
        // bar's listeners (spam-scroll, lastInputValue, autosize, prompt-
        // history cursor reset) must keep firing on redirected keystrokes.
        const branch = redirectBranch();
        expect(branch).toMatch(/dispatchEvent\(\s*new Event\(\s*'input'/);
        expect(branch).toContain('bubbles: true');
    });
});
