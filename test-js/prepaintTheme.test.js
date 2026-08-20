// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setupDomHarness } from './_dom.js';
import { ACCENT_COLORS, applyThemeTokens, runPrepaint } from '../web/theme.js';

setupDomHarness();

describe('theme.js & prepaint parity', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.removeAttribute('data-theme-color');
        document.documentElement.style.cssText = '';
        const existing = document.getElementById('phi-prepaint-appearance');
        if (existing) existing.remove();
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('exports all 22 accent color themes', () => {
        const keys = Object.keys(ACCENT_COLORS);
        expect(keys.length).toBe(22);
        expect(keys).toContain('purple');
        expect(keys).toContain('blue');
        expect(keys).toContain('green');
        expect(keys).toContain('amber');
        expect(keys).toContain('red');
        expect(keys).toContain('pink');
        expect(keys).toContain('teal');
        expect(keys).toContain('indigo');
        expect(keys).toContain('orange');
        expect(keys).toContain('cyan');
        expect(keys).toContain('rose');
        expect(keys).toContain('lime');
        expect(keys).toContain('white');
        expect(keys).toContain('gold');
        expect(keys).toContain('violet');
        expect(keys).toContain('emerald');
        expect(keys).toContain('neon');
        expect(keys).toContain('coral');
        expect(keys).toContain('fuchsia');
        expect(keys).toContain('canary');
        expect(keys).toContain('copper');
        expect(keys).toContain('mint');
    });

    it('applyThemeTokens applies CSS properties and data-theme-color attribute', () => {
        const theme = applyThemeTokens('cyan');
        expect(document.documentElement.getAttribute('data-theme-color')).toBe(
            'cyan',
        );
        expect(
            document.documentElement.style.getPropertyValue('--accent'),
        ).toBe(theme.accent);
        expect(
            document.documentElement.style.getPropertyValue('--accent-glow'),
        ).toBe(theme.accentGlow);
        expect(
            document.documentElement.style.getPropertyValue('--accent-dim'),
        ).toBe(theme.accentDim);
        expect(
            document.documentElement.style.getPropertyValue('--accent-bright'),
        ).toBe(theme.accentBright);
    });

    it('runPrepaint applies stored theme and font settings from localStorage', () => {
        localStorage.setItem('phi_theme_color', 'emerald');
        localStorage.setItem(
            'phi_appearance',
            JSON.stringify({
                ui_font_family: 'Inter, sans-serif',
                ui_font_size: 14,
            }),
        );

        runPrepaint();

        expect(document.documentElement.getAttribute('data-theme-color')).toBe(
            'emerald',
        );
        expect(
            document.documentElement.style.getPropertyValue('--accent'),
        ).toBe(ACCENT_COLORS.emerald.accent);

        const styleEl = document.getElementById('phi-prepaint-appearance');
        expect(styleEl).not.toBeNull();
        expect(styleEl?.textContent).toContain('font-family:Inter, sans-serif');
        expect(styleEl?.textContent).toContain('font-size:14px');
    });

    it('all html entry pages load prepaint.js, fonts.css, and style.css', () => {
        const webDir = path.join(__dirname, '..', 'web');
        const pages = ['index.html', 'md.html', 'config.html'];

        for (const page of pages) {
            const html = fs.readFileSync(path.join(webDir, page), 'utf8');
            expect(html).toContain('src="prepaint.js"');
            expect(html).toContain('href="vendor/fonts/fonts.css"');
            expect(html).toContain('href="style.css"');
            // Ensure no hardcoded ACCENT_COLORS maps remain in any HTML
            expect(html).not.toContain('const ACCENT_COLORS');
        }
    });
});
