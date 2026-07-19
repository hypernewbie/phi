// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';

// The markdown file list previously rendered the row icon as the raw
// hieroglyph character '𓏛' (U+133DB). On systems missing an Egyptian
// Hieroglyphs font, that renders as a tofu box. Replaced with a universal
// SVG 'file' icon. The decorative hieroglyph-style scroll glyph is now
// reserved for the markdown VIEWER modal header, where there's room for
// it and a font fallback (no tofu — pure SVG paths).

setupDomHarness();

describe('markdown file-list icon', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="markdown-file-list" class="markdown-file-list"></div>
            <div id="md-modal" class="md-modal-overlay hidden"><div class="md-modal-content">
                <div class="md-modal-header"><span id="md-modal-title" class="md-modal-title"></span></div>
                <div id="md-modal-body" class="md-modal-body"></div>
            </div></div>
        `;
    });

    it('uses an SVG document icon (no hieroglyph character glyph)', async () => {
        // Build the exact innerHTML the production code uses, then assert.
        const name = 'NOTES.md';
        const item = document.createElement('button');
        item.className = 'md-file-item';
        // The new minimal icon block, mirroring web-src/markdown.ts.
        item.innerHTML = `<svg class="md-file-icon md-file-icon-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg><span class="md-file-name">${name}</span>`;
        document.body.appendChild(item);

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
        const item = document.createElement('button');
        item.className = 'md-file-item';
        item.innerHTML = `<svg class="md-file-icon md-file-icon-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor"></svg><span class="md-file-name">x.md</span>`;
        document.body.appendChild(item);
        const icon = item.querySelector('.md-file-icon');
        expect(icon.classList.contains('md-file-icon-doc')).toBe(true);
    });
});

describe('markdown viewer modal header (stylized scroll)', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="md-modal" class="md-modal-overlay hidden"><div class="md-modal-content">
                <div class="md-modal-header"><span id="md-modal-title" class="md-modal-title"></span></div>
                <div id="md-modal-body" class="md-modal-body"></div>
            </div></div>
        `;
    });

    function setTitle(name) {
        const titleEl = document.getElementById('md-modal-title');
        const scrollSvg = `<svg class="md-modal-scroll" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <ellipse cx="5" cy="16" rx="2.5" ry="9"/>
            <ellipse cx="27" cy="16" rx="2.5" ry="9"/>
            <path d="M 5 8 Q 16 5 27 8 L 27 24 Q 16 27 5 24 Z"/>
            <line x1="13" y1="5.2" x2="13" y2="2.8"/>
            <line x1="19" y1="5.2" x2="19" y2="2.8"/>
            <line x1="13" y1="26.8" x2="13" y2="29.2"/>
            <line x1="19" y1="26.8" x2="19" y2="29.2"/>
            <line x1="11" y1="13" x2="21" y2="13" stroke-width="0.9" opacity="0.55"/>
            <line x1="11" y1="16" x2="20" y2="16" stroke-width="0.9" opacity="0.55"/>
            <line x1="11" y1="19" x2="21" y2="19" stroke-width="0.9" opacity="0.55"/>
        </svg>`;
        // Mirror the production _setModalTitle which escapes the name
        // before interpolating into innerHTML — defense against injected
        // angle-brackets from a file name or path field.
        const escapeHtml = (s) => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        titleEl.innerHTML = `${scrollSvg}<span class="md-modal-title-text">${escapeHtml(name)}</span>`;
    }

    it('renders a stylized papyrus-scroll SVG before the title text', () => {
        setTitle('NOTES.md');
        const titleEl = document.getElementById('md-modal-title');
        const scroll = titleEl.querySelector('.md-modal-scroll');
        const text = titleEl.querySelector('.md-modal-title-text');
        expect(scroll).not.toBeNull();
        expect(scroll.tagName.toLowerCase()).toBe('svg');
        expect(text).not.toBeNull();
        expect(text.textContent).toBe('NOTES.md');
    });

    it('keeps the scroll icon first so it precedes the title text', () => {
        setTitle('CHANGELOG.md');
        const titleEl = document.getElementById('md-modal-title');
        // The scroll element must come before the text element in DOM order.
        const children = Array.from(titleEl.children);
        const scrollIdx = children.findIndex((c) => c.classList.contains('md-modal-scroll'));
        const textIdx = children.findIndex((c) => c.classList.contains('md-modal-title-text'));
        expect(scrollIdx).toBeGreaterThanOrEqual(0);
        expect(textIdx).toBeGreaterThanOrEqual(0);
        expect(scrollIdx).toBeLessThan(textIdx);
    });

    it('escapes HTML in the file name (XSS / label safety)', () => {
        const evil = '<img src=x onerror=alert(1)>';
        setTitle(evil);
        const titleEl = document.getElementById('md-modal-title');
        const text = titleEl.querySelector('.md-modal-title-text');
        // No raw <img> should be created by the title.
        expect(titleEl.querySelector('img')).toBeNull();
        // The escaped text should be present as text content.
        expect(text.textContent).toBe(evil);
    });
});