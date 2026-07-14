// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
//
// Smoke test: every front-end ES module under web/ must import
// without throwing. Catches SyntaxError, duplicate-const,
// missing-import, etc. at CI time rather than when a user
// hits the broken path in production.
//
// On 2026-07-14 a duplicate `const isMobile` inside
// diff.js initTerminal() broke the entire front-end module
// graph silently - config stopped loading, no error toast,
// empty UI. A node --check on the file would have caught it;
// this test runs that check across all web/*.js files.
//
// jsdom env so app.js's top-level `window.addEventListener`
// resolves instead of throwing at import time.

// Modules that import from `ws.js`, `util.js`, etc. need their
// relative siblings to resolve. Node will follow the same
// resolution the browser does via the `<script type="module">`
// tags in index.html, so we import from a real entry point
// rather than each file in isolation.
const entryPoints = [
    '../web/diff.js',
    '../web/markdown.js',
    '../web/app.js',
    '../web/terminal.js',
    '../web/sessions.js',
    '../web/kanban.js',
    '../web/sync.js',
    '../web/ws.js',
    '../web/util.js',
];

describe('front-end ES modules parse cleanly', () => {
    for (const mod of entryPoints) {
        it(`${mod} imports without error`, async () => {
            // jsdom env is fine here - we're only testing that the
            // module graph resolves and parses, not running it.
            await expect(import(mod)).resolves.toBeDefined();
        });
    }
});

// Variable-before-initialization (TDZ) guard. On 2026-07-14 a
// scroll-to-bottom button block was placed after term.open() but
// before `const tabInfo = { ... }` inside createTab()'s main
// terminal branch, so `tabInfo.scrollToBottomBtn = ...` ran in
// the TDZ and every spawn-new-session crashed with
// "Cannot access 'tabInfo' before initialization".
//
// Scope: createTab() has an early-return branch for review/kanban
// that declares its own tabInfo. The main terminal branch declares
// tabInfo AFTER term.open(). Anything that assigns to a tabInfo
// property between `term.open(termContainer)` and the main-branch
// `const tabInfo = { ... }` is a TDZ trap.
//
// We find the slice from the first `term.open(termContainer)`
// inside createTab() to the next `const tabInfo`, and assert no
// `tabInfo.X = ...` assignment exists in that slice.
describe('no TDZ trap between term.open() and the next const tabInfo in createTab()', () => {
    it('terminal.js: tabInfo.X = ... assignments only come after both const tabInfo declarations', () => {
        const src = fs.readFileSync('web/terminal.js', 'utf8');
        const startMatch = src.match(/\n    createTab\(/);
        expect(startMatch, 'createTab() not found').toBeTruthy();
        const createStart = startMatch.index + 1;
        const openIdx = src.indexOf('{', createStart);
        let depth = 1;
        let i = openIdx + 1;
        while (depth > 0 && i < src.length) {
            const ch = src[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            i++;
        }
        const body = src.slice(openIdx, i);

        // Find the slice AFTER the first `term.open(termContainer)`
        // (that's the spot where the original bug lived).
        const termOpenIdx = body.indexOf('term.open(termContainer)');
        expect(termOpenIdx, 'no term.open(termContainer) inside createTab()').toBeGreaterThan(0);
        const afterOpen = body.slice(termOpenIdx);
        // Find the next `const tabInfo` after that.
        const nextDecl = afterOpen.indexOf('const tabInfo');
        expect(nextDecl, 'no const tabInfo after term.open()').toBeGreaterThan(0);
        const slice = afterOpen.slice(0, nextDecl);

        // Strip line + block comments so the heuristic doesn't false-fire
        // on documentation that mentions `tabInfo.X = ...`.
        const stripped = slice
            .split('\n')
            .map(l => l.replace(/\/\/.*$/, ''))
            .join('\n')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        expect(
            /\btabInfo\.\w+\s*=/.test(stripped),
            'tabInfo.X = ... assignment found between term.open() and the next const tabInfo (TDZ trap)',
        ).toBe(false);
    });
});