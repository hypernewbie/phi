// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';
import { getTerminalTheme } from '../web/terminal.js';
import { openSettingsModal } from '../web/settings.js';

setupDomHarness();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(
    path.join(__dirname, '../web/index.html'),
    'utf8',
);
const styleCss = readFileSync(path.join(__dirname, '../web/style.css'), 'utf8');

describe('Terminal custom background image', () => {
    beforeEach(() => {
        document.body.className = '';
        document.body.innerHTML = `
            <div id="terminals-wrapper" class="terminals-wrapper">
                <div id="terminal-bg-layer" class="terminal-bg-layer"></div>
                <div id="terminal-bg-overlay" class="terminal-bg-overlay"></div>
                <div id="empty-state" class="empty-state hidden"></div>
            </div>
        `;
        localStorage.clear();
        vi.restoreAllMocks();
    });

    describe('DOM & CSS invariants', () => {
        it('web/index.html contains #terminal-bg-layer and #terminal-bg-overlay in #terminals-wrapper', () => {
            expect(indexHtml).toContain('id="terminal-bg-layer"');
            expect(indexHtml).toContain('id="terminal-bg-overlay"');
            const wrapperStart = indexHtml.indexOf('id="terminals-wrapper"');
            const bgLayerPos = indexHtml.indexOf('id="terminal-bg-layer"');
            const bgOverlayPos = indexHtml.indexOf('id="terminal-bg-overlay"');
            const emptyStatePos = indexHtml.indexOf('id="empty-state"');
            expect(wrapperStart).toBeGreaterThan(-1);
            expect(bgLayerPos).toBeGreaterThan(wrapperStart);
            expect(bgOverlayPos).toBeGreaterThan(bgLayerPos);
            expect(emptyStatePos).toBeGreaterThan(bgOverlayPos);
        });

        it('web/style.css defines layer, overlay, and transparent xterm rules under body.has-terminal-bg', () => {
            expect(styleCss).toContain('.terminal-bg-layer');
            expect(styleCss).toContain('.terminal-bg-overlay');
            expect(styleCss).toContain(
                'body.has-terminal-bg .terminal-bg-layer',
            );
            expect(styleCss).toContain(
                'body.has-terminal-bg .terminal-bg-overlay',
            );
            expect(styleCss).toMatch(
                /body\.has-terminal-bg[\s\S]*?\.xterm-viewport[\s\S]*?background-color:\s*transparent\s*!important/,
            );
        });
    });

    describe('getTerminalTheme transparency', () => {
        it('returns solid dark background (#08080a) by default when no background is active', () => {
            document.body.classList.remove('has-terminal-bg');
            const theme = getTerminalTheme('bash');
            expect(theme.background).toBe('#08080a');
        });

        it('returns transparent background when body has has-terminal-bg class', () => {
            document.body.classList.add('has-terminal-bg');
            const theme = getTerminalTheme('bash');
            expect(theme.background).toBe('rgba(0, 0, 0, 0)');
        });

        it('respects explicit hasCustomBg argument in getTerminalTheme', () => {
            document.body.classList.remove('has-terminal-bg');
            const themeExplicitTrue = getTerminalTheme(
                'bash',
                null,
                null,
                null,
                true,
            );
            expect(themeExplicitTrue.background).toBe('rgba(0, 0, 0, 0)');

            document.body.classList.add('has-terminal-bg');
            const themeExplicitFalse = getTerminalTheme(
                'bash',
                null,
                null,
                null,
                false,
            );
            expect(themeExplicitFalse.background).toBe('#08080a');
        });

        it('returns transparent background for agy coder when custom background is active', () => {
            document.body.classList.add('has-terminal-bg');
            const theme = getTerminalTheme('agy', null, {
                agy_theme_ansi: true,
            });
            expect(theme.background).toBe('rgba(0, 0, 0, 0)');
        });
    });

    describe('App background methods and state', () => {
        function buildTestApp() {
            const app = Object.create(App.prototype);
            app.terminalBgName = '';
            app.terminalBgDarkness = 98;
            app.terminalBgBlur = 0;
            app._terminalBgObjectUrl = null;
            app.tabManager = {
                applyThemeToAllActiveTerminals: vi.fn(),
            };
            app._deleteCustomBg = vi.fn().mockResolvedValue(undefined);
            return app;
        }

        it('applyTerminalBg activates body class, updates DOM styles, and notifies tabManager', () => {
            const app = buildTestApp();
            app.terminalBgName = 'wallpaper.png';
            app.terminalBgDarkness = 95;
            app.terminalBgBlur = 8;

            const fakeBlob = new Blob(['img data'], { type: 'image/png' });
            // Mock URL.createObjectURL / revokeObjectURL
            const origCreate = URL.createObjectURL;
            const origRevoke = URL.revokeObjectURL;
            URL.createObjectURL = vi.fn(() => 'blob:phi-test-bg-url');
            URL.revokeObjectURL = vi.fn();

            try {
                app.applyTerminalBg(fakeBlob);

                expect(
                    document.body.classList.contains('has-terminal-bg'),
                ).toBe(true);
                const bgLayer = document.getElementById('terminal-bg-layer');
                const bgOverlay = document.getElementById(
                    'terminal-bg-overlay',
                );

                expect(bgLayer.style.backgroundImage).toBe(
                    'url("blob:phi-test-bg-url")',
                );
                expect(bgLayer.style.filter).toBe('blur(8px)');
                expect(bgOverlay.style.opacity).toBe('0.95');
                expect(
                    app.tabManager.applyThemeToAllActiveTerminals,
                ).toHaveBeenCalled();
            } finally {
                URL.createObjectURL = origCreate;
                URL.revokeObjectURL = origRevoke;
            }
        });

        it('clearCustomBgDOM removes body class, clears inline styles, and notifies tabManager', () => {
            const app = buildTestApp();
            document.body.classList.add('has-terminal-bg');
            const bgLayer = document.getElementById('terminal-bg-layer');
            const bgOverlay = document.getElementById('terminal-bg-overlay');
            bgLayer.style.backgroundImage = 'url("blob:old")';
            bgLayer.style.filter = 'blur(10px)';
            bgOverlay.style.opacity = '0.9';

            app.clearCustomBgDOM();

            expect(document.body.classList.contains('has-terminal-bg')).toBe(
                false,
            );
            expect(bgLayer.style.backgroundImage).toBe('');
            expect(bgLayer.style.filter).toBe('');
            expect(bgOverlay.style.opacity).toBe('');
            expect(
                app.tabManager.applyThemeToAllActiveTerminals,
            ).toHaveBeenCalled();
        });

        it('clearCustomBg resets state and writes to localStorage', async () => {
            const app = buildTestApp();
            app.terminalBgName = 'test.jpg';
            document.body.classList.add('has-terminal-bg');

            await app.clearCustomBg();

            expect(app.terminalBgName).toBe('');
            expect(app._deleteCustomBg).toHaveBeenCalled();
            expect(document.body.classList.contains('has-terminal-bg')).toBe(
                false,
            );

            const saved = JSON.parse(
                localStorage.getItem('phi_appearance') || '{}',
            );
            expect(saved.terminal_bg_name).toBe('');
        });

        it('_saveAppearanceLocal persists terminal_bg_name, darkness, and blur', () => {
            const app = buildTestApp();
            app.terminalBgName = 'custom-art.webp';
            app.terminalBgDarkness = 97;
            app.terminalBgBlur = 12;

            app._saveAppearanceLocal();

            const saved = JSON.parse(
                localStorage.getItem('phi_appearance') || '{}',
            );
            expect(saved.terminal_bg_name).toBe('custom-art.webp');
            expect(saved.terminal_bg_darkness).toBe(97);
            expect(saved.terminal_bg_blur).toBe(12);
        });
    });

    describe('Settings Appearance UI', () => {
        function buildSettingsApp(overrides = {}) {
            const app = Object.create(App.prototype);
            app.terminalBgName = overrides.terminalBgName || '';
            app.terminalBgDarkness = overrides.terminalBgDarkness ?? 98;
            app.terminalBgBlur = overrides.terminalBgBlur ?? 0;
            app._terminalBgObjectUrl = null;
            app.showToast = vi.fn();
            app._saveAppearanceLocal = vi.fn();
            app._putCustomBg = vi.fn().mockResolvedValue(undefined);
            app.applyTerminalBg = vi.fn();
            app.applyTerminalBgStyles = vi.fn();
            app.clearCustomBg = vi.fn().mockResolvedValue(undefined);
            app.tabManager = {
                applyFontToAllActiveTerminals: vi.fn(),
                applyTerminalFontSizeToAll: vi.fn(),
                applyThemeToAllActiveTerminals: vi.fn(),
            };
            app.applyUIFont = vi.fn();
            app.persistAppearance = vi.fn().mockResolvedValue(undefined);
            return app;
        }

        it('renders background upload, darkness, and blur inputs in Settings modal', () => {
            const app = buildSettingsApp();
            openSettingsModal(app, {}, { standalone: true });

            const fileInp = document.getElementById('settings-bg-upload');
            const darknessInp = document.getElementById('settings-bg-darkness');
            const blurInp = document.getElementById('settings-bg-blur');

            expect(fileInp).toBeTruthy();
            expect(fileInp.accept).toContain('image/');
            expect(darknessInp).toBeTruthy();
            expect(darknessInp.value).toBe('98');
            expect(blurInp).toBeTruthy();
            expect(blurInp.value).toBe('0');
        });

        it('renders Remove button when terminalBgName is set and triggers clearCustomBg', async () => {
            const app = buildSettingsApp({ terminalBgName: 'forest.jpg' });
            openSettingsModal(app, {}, { standalone: true });

            const removeBtn = document.getElementById('settings-bg-remove');
            expect(removeBtn).toBeTruthy();

            removeBtn.click();
            await new Promise((r) => setTimeout(r, 0));

            expect(app.clearCustomBg).toHaveBeenCalled();
            expect(document.getElementById('settings-bg-remove')).toBeNull();
        });

        it('reset button clears custom background and resets darkness and blur', async () => {
            const app = buildSettingsApp({
                terminalBgName: 'sunset.png',
                terminalBgDarkness: 80,
                terminalBgBlur: 15,
            });
            openSettingsModal(app, {}, { standalone: true });

            const resetBtn = Array.from(
                document.querySelectorAll('button'),
            ).find((b) => b.textContent === 'Reset appearance');
            expect(resetBtn).toBeTruthy();

            resetBtn.click();
            await new Promise((r) => setTimeout(r, 0));

            expect(app.clearCustomBg).toHaveBeenCalled();
            expect(app.terminalBgName).toBe('');
            expect(app.terminalBgDarkness).toBe(98);
            expect(app.terminalBgBlur).toBe(0);
            expect(document.getElementById('settings-bg-darkness').value).toBe(
                '98',
            );
            expect(document.getElementById('settings-bg-blur').value).toBe('0');
        });
    });

    describe('Backwards compatibility guarantees', () => {
        it('legacy phi_appearance without bg fields leaves background disabled and terminal opaque', () => {
            const legacyLs = {
                ui_font_family: 'Inter',
                ui_font_size: 16,
                terminal_font_family: 'JetBrains Mono',
                terminal_font_size: 14,
                custom_font_name: 'Custom.woff2',
            };
            localStorage.setItem('phi_appearance', JSON.stringify(legacyLs));

            const parsed = JSON.parse(localStorage.getItem('phi_appearance'));
            const app = Object.create(App.prototype);
            app.terminalBgName = parsed?.terminal_bg_name || '';
            app.terminalBgDarkness =
                typeof parsed?.terminal_bg_darkness === 'number'
                    ? parsed.terminal_bg_darkness
                    : 98;
            app.terminalBgBlur =
                typeof parsed?.terminal_bg_blur === 'number'
                    ? parsed.terminal_bg_blur
                    : 0;

            expect(app.terminalBgName).toBe('');
            expect(app.terminalBgDarkness).toBe(98);
            expect(app.terminalBgBlur).toBe(0);

            // Theme retains default opaque #08080a
            const theme = getTerminalTheme('bash');
            expect(theme.background).toBe('#08080a');
            expect(document.body.classList.contains('has-terminal-bg')).toBe(
                false,
            );
        });

        it('loadCustomBg does nothing and clears DOM if terminalBgName is empty string', async () => {
            const app = Object.create(App.prototype);
            app.terminalBgName = '';
            app.clearCustomBgDOM = vi.fn();
            app._getCustomBg = vi.fn();

            await app.loadCustomBg();

            expect(app.clearCustomBgDOM).toHaveBeenCalled();
            expect(app._getCustomBg).not.toHaveBeenCalled();
            expect(document.body.classList.contains('has-terminal-bg')).toBe(
                false,
            );
        });
    });
});
