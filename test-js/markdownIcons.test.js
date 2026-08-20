// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// The markdown file list previously rendered the row icon as the raw
// hieroglyph character '𓏛' (U+133DB). On systems missing an Egyptian
// Hieroglyphs font, that renders as a tofu box. Replaced with a universal
// SVG 'file' icon. The decorative hieroglyph-style scroll glyph is now
// reserved for the markdown VIEWER modal header, where there's room for
// it and a font fallback (no tofu — pure SVG paths).
//
// These tests drive the real _renderFileList / _setModalTitle methods on
// MarkdownManager (web/markdown.js) instead of hand-typed HTML fixtures,
// so a regression in production (e.g. the hieroglyph glyph reappearing, or
// _setModalTitle dropping its escapeHtml call) actually fails these tests.

setupDomHarness();

// Minimum-DOM stub for MarkdownManager construction — the ids its
// constructor/_setupEventListeners dereference directly (same list as
// mdOpenNewWindow.test.js / mdChangedRefresh.test.js), plus the containers
// _renderFileList and _setModalTitle write into.
function makeMm() {
    document.body.innerHTML = `
        <div id="markdown-file-list"></div>
        <div id="md-modal" class="hidden"></div>
        <div id="md-modal-title"></div>
        <div id="md-modal-body"></div>
        <button id="md-modal-close"></button>
    `;
    const app = {
        showToast: vi.fn(),
        markdownDirs: ['.'],
        sessionsManager: { activeCWD: '/w' },
    };
    return new MarkdownManager(app);
}

describe('markdown file-list icon', () => {
    it('uses an SVG document icon (no hieroglyph character glyph)', () => {
        const mm = makeMm();
        mm._renderFileList([
            { name: 'NOTES.md', path: '/w/NOTES.md', dir: '.' },
        ]);

        const item = mm.fileListEl.querySelector('.md-file-item');
        const icon = item.querySelector('.md-file-icon');
        expect(icon).not.toBeNull();
        // Must be a real SVG element — a hieroglyph character rendered as
        // text would NOT have the SVGElement tag.
        expect(icon.tagName.toLowerCase()).toBe('svg');
        // Must not contain the raw hieroglyph character that previously
        // lived here (the prior failure mode). Anything containing 𓏛
        // would be a regression.
        expect(item.textContent).not.toContain('𓏛');
        expect(item.innerHTML).not.toContain('𓏛');
        expect(item.innerHTML).not.toMatch(/[\u{13000}-\u{137FF}]/u);
    });

    it('has class md-file-icon-doc so it picks up the small doc styling', () => {
        const mm = makeMm();
        mm._renderFileList([{ name: 'x.md', path: '/w/x.md', dir: '.' }]);

        const icon = mm.fileListEl.querySelector('.md-file-icon');
        expect(icon.classList.contains('md-file-icon-doc')).toBe(true);
    });
});

describe('markdown viewer modal header (stylized scroll)', () => {
    it('renders a stylized papyrus-scroll SVG before the title text', () => {
        const mm = makeMm();
        mm._setModalTitle('NOTES.md');

        const titleEl = mm.modalTitle;
        const scroll = titleEl.querySelector('.md-modal-scroll');
        const text = titleEl.querySelector('.md-modal-title-text');
        expect(scroll).not.toBeNull();
        expect(scroll.tagName.toLowerCase()).toBe('svg');
        expect(text).not.toBeNull();
        expect(text.textContent).toBe('NOTES.md');
    });

    it('keeps the scroll icon first so it precedes the title text', () => {
        const mm = makeMm();
        mm._setModalTitle('CHANGELOG.md');

        const titleEl = mm.modalTitle;
        // The scroll element must come before the text element in DOM order.
        const children = Array.from(titleEl.children);
        const scrollIdx = children.findIndex((c) =>
            c.classList.contains('md-modal-scroll'),
        );
        const textIdx = children.findIndex((c) =>
            c.classList.contains('md-modal-title-text'),
        );
        expect(scrollIdx).toBeGreaterThanOrEqual(0);
        expect(textIdx).toBeGreaterThanOrEqual(0);
        expect(scrollIdx).toBeLessThan(textIdx);
    });

    it('escapes HTML in the file name (XSS / label safety)', () => {
        const mm = makeMm();
        const evil = '<img src=x onerror=alert(1)>';
        mm._setModalTitle(evil);

        const titleEl = mm.modalTitle;
        const text = titleEl.querySelector('.md-modal-title-text');
        // No raw <img> should be created by the title.
        expect(titleEl.querySelector('img')).toBeNull();
        // The escaped text should be present as text content.
        expect(text.textContent).toBe(evil);
    });
});
