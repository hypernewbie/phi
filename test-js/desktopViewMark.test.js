// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markDesktopView } from '../web/desktop.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL_HREF = window.location.href;

afterEach(() => {
    window.history.replaceState(null, '', ORIGINAL_HREF);
    document.documentElement.removeAttribute('data-phi-desktop');
});

describe('markDesktopView (?desktop=1 document hook)', () => {
    it('marks the document element in desktop-marked profile pages', () => {
        window.history.replaceState(null, '', '/?desktop=1');
        markDesktopView();
        expect(document.documentElement.hasAttribute('data-phi-desktop')).toBe(true);
    });

    it('does not mark the document in a plain browser', () => {
        markDesktopView();
        expect(document.documentElement.hasAttribute('data-phi-desktop')).toBe(false);
    });

    it('ignores desktop values other than 1', () => {
        window.history.replaceState(null, '', '/?desktop=0');
        markDesktopView();
        expect(document.documentElement.hasAttribute('data-phi-desktop')).toBe(false);
    });
});

describe('desktop body beheading source contract', () => {
    const css = readFileSync(join(ROOT, 'web/style.css'), 'utf8');
    const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');

    it('hides the remote page\'s own header in desktop mode (the host renders the vendored header locally)', () => {
        const rule = css.match(/html\[data-phi-desktop\]\s*\.app-header\s*\{([\s\S]*?)\}/);
        expect(rule).not.toBeNull();
        expect(rule[1]).toContain('display: none');
    });

    it('pins the desktop page to the viewport (host-sized body, no scroll)', () => {
        const rule = css.match(/html\[data-phi-desktop\]\s*body\s*\{([\s\S]*?)\}/);
        expect(rule).not.toBeNull();
        expect(rule[1]).toContain('overflow: hidden');
        expect(rule[1]).toContain('height: 100vh');
    });

    it('leaves no web-side header slots or drag hacks (the header is gone from the body)', () => {
        // The old title/caption slot-lane geometry must not come back: the
        // remote page is beheaded, so it reserves nothing.
        expect(css).not.toContain('--desktop-title-slot-width');
        expect(css).not.toContain('--desktop-caption-slot-width');
        expect(css).not.toContain('padding-right: 138px');
    });

    it('keeps header controls interactive and leaves the left gutter to the native rail', () => {
        // The profile view is offset natively (right of the rail gutter),
        // so the desktop-gated page must not add a web-side left margin.
        expect(css).not.toMatch(/html\[data-phi-desktop\]\s*\.main-layout/);
    });

    it('ships exactly one header and no inline drag hacks in the page', () => {
        expect(html.match(/class="app-header"/g)).toHaveLength(1);
        expect(html).not.toContain('-webkit-app-region');
    });

    it('keeps the real remote project, Kanban, and Diff controls in the page', () => {
        expect(html).toContain('id="workspace-select"');
        expect(html).toContain('id="header-kanban-btn"');
        expect(html).toContain('id="header-diff-toggle-btn"');
    });
});
