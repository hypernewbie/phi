// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
//
// Smoke test: every front-end ES module under web/ must import
// without throwing. Catches SyntaxError, duplicate-const,
// missing-import, etc. at CI time rather than when a user
// hits the broken path in production.
//
// On 2026-07-14 a duplicate `const isMobile` inside
// diff.js initTerminal() broke the entire front-end module
// graph silently — config stopped loading, no error toast,
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
            // jsdom env is fine here — we're only testing that the
            // module graph resolves and parses, not running it.
            await expect(import(mod)).resolves.toBeDefined();
        });
    }
});